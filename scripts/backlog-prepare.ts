/**
 * Prepare the pending backlog for reading — the three free steps, no model calls.
 *
 *   --step headlines   collapse re-issued/syndicated copies by normalised headline
 *   --step fetch       resolve Google News redirects, fetch publisher pages,
 *                      drop what cannot be read
 *   --step content     collapse identical article text (content hash); attach a
 *                      copy of an article already read to that read
 *
 * What it will NOT do: call a model, or delete anything. Every row it takes out
 * of the backlog becomes "excluded" with a reason that names the row it
 * duplicates, so each decision is visible and reversible.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx --env-file=.env --env-file=.env.local scripts/backlog-prepare.ts --step headlines|fetch|content [--apply] [--limit N] [--concurrency 3] [--pace-ms 400]
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { retrieveArticle, readableArticleText } from "@/lib/ingestion/article-text";
import { findReadByContent, storeDuplicateContent, sameStoryHeadline } from "@/lib/ingestion/store";
import type { RawArticle } from "@/lib/ingestion/crawler";

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 160)));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const STEP = arg("--step", "");
const apply = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", "0"));
const CONCURRENCY = Number(arg("--concurrency", "3"));
const PACE_MS = Number(arg("--pace-ms", "400"));
const REPORT = "_scratch/backlog-prepare.json";
const PENDING = `"processingStatus" = 'pending'`;
const DAY = 86_400_000;

function report(step: string, data: Record<string, unknown>) {
  fs.mkdirSync("_scratch", { recursive: true });
  const all = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, "utf8")) : {};
  all[step] = { ...data, apply, at: new Date().toISOString() };
  fs.writeFileSync(REPORT, JSON.stringify(all, null, 1));
}

async function exclude(id: string, reason: string) {
  if (!apply) return;
  await prisma.sourceEvent.update({ where: { id }, data: { processingStatus: "excluded", exclusionReason: reason.slice(0, 120), extractedFamily: "EXCLUDED" } });
}

// ── Step 1: headlines ─────────────────────────────────────────────────────────
/**
 * A headline is the same story when it matches after the publisher suffix,
 * case and punctuation are removed, within 7 days. Synthetic titles from the
 * predecessor import ("Concentrix | Contract | Enterprise Client | …") are
 * identical for DIFFERENT contracts and are never collapsed; nor are headlines
 * too short to identify anything.
 */
export function normHeadline(title: string | null): string | null {
  if (!title || title.includes(" | ")) return null;
  const h = title.replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  return h.length >= 25 && h.split(" ").length >= 5 ? h : null;
}

async function stepHeadlines() {
  const rows = await prisma.$queryRawUnsafe<{ id: string; t: string | null; d: Date | null; status: string; read: boolean; pub: string | null; len: number; c: Date }[]>(`
    select id, "sourceTitle" t, "publicationDate" d, "processingStatus" status, ("modelId" is not null) read, "publisherUrl" pub,
      coalesce(length("rawText"),0) len, "createdAt" c
    from "SourceEvent" where "sourceType" <> 'procurement_notice' and "sourceTitle" is not null
      and ("processingStatus" = 'pending' or "modelId" is not null)`);
  const groups = new Map<string, typeof rows>();
  for (const r of rows) { const h = normHeadline(r.t); if (!h) continue; (groups.get(h) ?? groups.set(h, []).get(h)!).push(r); }
  let collapsed = 0, againstRead = 0, groupsWithDupes = 0;
  const pairs: string[] = [];
  const sample: string[] = [];
  for (const [h, g] of groups) {
    const pend = g.filter(r => r.status === "pending");
    if (pend.length === 0 || g.length < 2) continue;
    // keeper: an article already read, else the pending copy most likely to fetch
    const rank = (r: typeof g[number]) => (r.read ? 0 : 1) * 1e12 - (r.pub ? 1e9 : 0) - r.len;
    const sorted = [...g].sort((a, b) => rank(a) - rank(b) || a.c.getTime() - b.c.getTime());
    let did = false;
    for (const r of pend) {
      // nearest keeper-eligible copy within 7 days (a recurring headline weeks apart is a different story)
      const k = sorted.find(x => x.id !== r.id && (x.read || sorted.indexOf(x) < sorted.indexOf(r))
        && (!x.d || !r.d || Math.abs(x.d.getTime() - r.d.getTime()) <= 7 * DAY));
      if (!k) continue;
      await exclude(r.id, `duplicate_headline:${k.id}`);
      collapsed++; did = true; if (k.read) againstRead++;
      if (sample.length < 8) sample.push(`${h.slice(0, 80)}  (keeper ${k.read ? "already read" : "pending"})`);
      pairs.push(`${r.t}  [${r.d?.toISOString().slice(0, 10)}]\n      = ${k.t}  [${k.d?.toISOString().slice(0, 10)}]`);
    }
    if (did) groupsWithDupes++;
  }
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`headline groups with duplicates: ${groupsWithDupes} · pending rows collapsed: ${collapsed} (${againstRead} were copies of an article already read)`);
  sample.forEach(s => console.log("   " + s));
  console.log(`pending ${apply ? "now" : "unchanged (dry run)"}: ${left}${apply ? "" : ` → would be ${left - collapsed}`}`);
  if (process.argv.includes("--show")) pairs.sort(() => Math.random() - 0.5).slice(0, 20).forEach(p => console.log("  " + p));
  report("headlines", { collapsed, againstRead, groupsWithDupes, pendingAfter: apply ? left : left - collapsed });
}

// ── Step 1b: near-duplicate titles ────────────────────────────────────────────
/**
 * The same story under a reworded headline ("AWS and Minfy sign strategic
 * collaboration" / "Minfy signs five-year collaboration agreement with AWS").
 * Two headlines within 7 days are one story when the share of meaningful words
 * they have in common (Jaccard) reaches the threshold AND every number in one
 * appears in the other: "Q2 results" is never "Q3 results", "$26M" never "$62M".
 * The keeper is an article already read, else the earlier pending copy.
 */
const TITLE_STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "as", "is", "are", "its", "it", "from", "new", "that", "this", "after", "over", "into", "amid", "says", "said", "will", "has", "have", "be", "how", "why", "what", "inc", "ltd", "limited", "corp", "plc", "company", "group"]);
export function titleTokens(title: string | null): Set<string> | null {
  const h = normHeadline(title);
  if (!h) return null;
  // Numbers are kept whatever their length: "October 6" and "October 9" are different fixtures.
  const t = new Set(h.split(" ").filter(w => (w.length > 1 || /\d/.test(w)) && !TITLE_STOP.has(w)));
  return t.size >= 5 ? t : null;
}
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  const numbers = (s: Set<string>) => [...s].filter(w => /\d/.test(w)).sort().join(" ");
  if (numbers(a) !== numbers(b)) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

async function stepTitles() {
  const THRESHOLD = Number(arg("--threshold", "0.7"));   // 0.7: 30 of 30 sampled pairs at or above it were the same story; below it 4 of 34 were not
  const rows = await prisma.$queryRawUnsafe<{ id: string; t: string | null; d: Date | null; status: string; read: boolean; pub: string | null; len: number; c: Date }[]>(`
    select id, "sourceTitle" t, "publicationDate" d, "processingStatus" status, ("modelId" is not null) read, "publisherUrl" pub,
      coalesce(length("rawText"),0) len, "createdAt" c
    from "SourceEvent" where "sourceType" <> 'procurement_notice' and "sourceTitle" is not null
      and ("processingStatus" = 'pending' or "modelId" is not null)`);
  const items = rows.map(r => ({ r, tok: titleTokens(r.t) })).filter((x): x is { r: typeof rows[number]; tok: Set<string> } => x.tok !== null);
  // Block on each headline's rarest words, so only plausible pairs are compared.
  const df = new Map<string, number>();
  for (const { tok } of items) for (const w of tok) df.set(w, (df.get(w) ?? 0) + 1);
  const keysOf = (tok: Set<string>) => [...tok].sort((x, y) => (df.get(x)! - df.get(y)!) || x.localeCompare(y)).slice(0, 4).filter(w => df.get(w)! <= 400);
  const index = new Map<string, number[]>();
  items.forEach((it, i) => { for (const k of keysOf(it.tok)) (index.get(k) ?? index.set(k, []).get(k)!).push(i); });
  // Keepers first: read articles, then pending by "most likely to have good text", then age.
  const rank = (r: typeof rows[number]) => (r.read ? 0 : 1) * 1e12 - (r.pub ? 1e9 : 0) - r.len;
  const order = items.map((_, i) => i).sort((x, y) => rank(items[x].r) - rank(items[y].r) || items[x].r.c.getTime() - items[y].r.c.getTime());
  const pos = new Map(order.map((i, p) => [i, p]));
  const dropped = new Set<number>();
  const bands: Record<string, string[]> = { "0.90-1.00": [], "0.80-0.90": [], "0.70-0.80": [], "0.60-0.70": [] };
  const bandOf = (v: number) => v >= 0.9 ? "0.90-1.00" : v >= 0.8 ? "0.80-0.90" : v >= 0.7 ? "0.70-0.80" : "0.60-0.70";
  let collapsed = 0, againstRead = 0;
  for (const i of order) {
    const { r, tok } = items[i];
    if (r.status !== "pending") continue;
    let best = -1, bestSim = 0;
    const seen = new Set<number>();
    for (const k of keysOf(tok)) for (const j of index.get(k) ?? []) {
      if (j === i || seen.has(j) || dropped.has(j) || pos.get(j)! >= pos.get(i)!) continue;
      seen.add(j);
      const o = items[j].r;
      if (o.d && r.d && Math.abs(o.d.getTime() - r.d.getTime()) > 7 * DAY) continue;
      const sim = titleSimilarity(tok, items[j].tok);
      if (sim > bestSim) { bestSim = sim; best = j; }
    }
    if (best < 0 || bestSim < 0.6 || bestSim >= 0.9999) continue;   // exact matches belong to --step headlines
    const k = items[best].r;
    bands[bandOf(bestSim)].push(`${bestSim.toFixed(2)}  ${String(r.t).slice(0, 110)}\n          = ${String(k.t).slice(0, 110)}${k.read ? "  (already read)" : ""}`);
    if (bestSim < THRESHOLD) continue;
    dropped.add(i);
    await exclude(r.id, `duplicate_headline:${k.id}`);
    collapsed++; if (k.read) againstRead++;
  }
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`near-duplicate titles by similarity: ${Object.entries(bands).map(([b, v]) => `${b}: ${v.length}`).join(" · ")}`);
  console.log(`threshold ${THRESHOLD}: pending rows collapsed ${collapsed} (${againstRead} were copies of an article already read)`);
  console.log(`pending ${apply ? "now" : "unchanged (dry run)"}: ${left}${apply ? "" : ` → would be ${left - collapsed}`}`);
  if (process.argv.includes("--show")) for (const [b, v] of Object.entries(bands)) {
    console.log(`\n--- ${b} (${v.length})`);
    [...v].sort(() => Math.random() - 0.5).slice(0, Number(arg("--samples", "10"))).forEach(x => console.log("  " + x));
  }
  report("titles", { threshold: THRESHOLD, collapsed, againstRead, bands: Object.fromEntries(Object.entries(bands).map(([b, v]) => [b, v.length])), pendingAfter: apply ? left : left - collapsed });
}

// ── Step 2: fetch ─────────────────────────────────────────────────────────────
/**
 * Resolve and fetch every pending row that lacks readable text. Google News
 * rate-limits redirect resolution: before it engages failures are ~0, after it
 * engages EVERY request fails. A run of consecutive redirect failures therefore
 * stops the pass and records nothing for the burst — writing FETCH_FAILED there
 * would drop good URLs on a false premise. A page that resolves but yields no
 * readable text (paywall, blocked, script-rendered, gone) is dropped:
 * excluded "rules:unreadable".
 */
async function stepFetch() {
  const rows = await prisma.$queryRawUnsafe<{ id: string; url: string; pub: string | null; raw: string | null; gnews: boolean }[]>(`
    select id, "sourceUrl" url, "publisherUrl" pub, "rawText" raw, ("sourceUrl" like '%news.google.com%') gnews
    from "SourceEvent" where ${PENDING} and "sourceType" <> 'procurement_notice'
      and coalesce("redirectState",'') not in ('BLOCKED','INVALID') and "bodyAttempts" < 3
    order by ("publisherUrl" is null), "publicationDate" desc nulls last`);
  const needs = rows.filter(r => !readableArticleText(r.raw) || (r.raw?.length ?? 0) < 1500);
  const work = LIMIT > 0 ? needs.slice(0, LIMIT) : needs;
  const s = { candidates: needs.length, attempted: 0, resolved: 0, redirectFailed: 0, readable: 0, fullText: 0, unreadable: 0, keptStored: 0, aborted: false };
  console.log(`pending rows needing a fetch: ${needs.length}; this pass: ${work.length}; concurrency ${CONCURRENCY}, pace ${PACE_MS}ms`);
  const THROTTLE_ABORT = 25;
  let consecutive = 0, cursor = 0; const t0 = Date.now();
  async function worker() {
    while (!s.aborted) {
      const i = cursor++; if (i >= work.length) return;
      const r = work[i];
      if (PACE_MS > 0) await new Promise(res => setTimeout(res, PACE_MS));
      s.attempted++;
      let pub: string | null = r.pub, text = "";
      try { const got = await retrieveArticle(r.pub ?? r.url, 60_000); pub = got.publisherUrl ?? r.pub; text = got.article?.text ?? ""; } catch { /* treated below */ }
      if (r.gnews && !pub) {
        s.redirectFailed++;
        if (++consecutive >= THROTTLE_ABORT) { s.aborted = true; console.log(`\nSTOPPED: ${THROTTLE_ABORT} consecutive redirect failures — Google is rate-limiting. Nothing recorded for the burst; re-run later to continue.`); }
        continue;
      }
      consecutive = 0; if (!r.pub && pub) s.resolved++;
      const readable = readableArticleText(text);
      const stored = readableArticleText(r.raw);
      const best = readable && readable.length >= (stored?.length ?? 0) ? text : (stored ? r.raw : null);
      const bodyState = !best ? "UNREADABLE" : best.length >= 1500 ? "FULL_TEXT" : best.length >= 800 ? "PARTIAL_ARTICLE" : "SNIPPET_ONLY";
      if (!best) s.unreadable++; else { s.readable++; if (bodyState === "FULL_TEXT") s.fullText++; if (best === r.raw) s.keptStored++; }
      if (apply) {
        await prisma.sourceEvent.update({ where: { id: r.id }, data: {
          publisherUrl: pub ?? undefined, redirectState: !r.gnews ? "NOT_APPLICABLE" : r.pub ? "ALREADY_RESOLVED" : "RESOLVED", redirectAttemptedAt: new Date(),
          bodyState, bodyAttemptedAt: new Date(), bodyAttempts: { increment: 1 }, bodyChars: best?.length ?? null,
          ...(best && best !== r.raw ? { rawText: best.slice(0, 60_000) } : {}),
          ...(!best ? { processingStatus: "excluded", exclusionReason: "rules:unreadable", extractedFamily: "EXCLUDED" } : {}),
        } }).catch(e => console.error(`write ${r.id}: ${String(e).slice(0, 100)}`));
      }
      if (s.attempted % 100 === 0) console.log(`  ${s.attempted}/${work.length} · readable ${s.readable} (full ${s.fullText}) · unreadable ${s.unreadable} · redirect failures ${s.redirectFailed} · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`\nfetch pass: ${JSON.stringify(s)} · runtime ${Math.round((Date.now() - t0) / 1000)}s · pending now ${left}`);
  report("fetch", { ...s, runtimeS: Math.round((Date.now() - t0) / 1000), pendingAfter: left });
}

// ── Step 3: content ───────────────────────────────────────────────────────────
/**
 * Identical text is one article, however many URLs carry it. The hash is taken
 * over exactly the text the reader would be given (readableArticleText), so it
 * matches the pipeline's own one-read-per-content guard.
 */
async function stepContent() {
  // Paged: one query over every pending body is tens of MB and the Neon
  // websocket drops it.
  type Row = { id: string; url: string; t: string | null; name: string | null; type: string; d: Date | null; pub: string | null; raw: string | null; c: Date };
  const rows: Row[] = [];
  for (let after = ""; ;) {
    const page = await prisma.$queryRawUnsafe<Row[]>(`
      select id, "sourceUrl" url, "sourceTitle" t, "sourceName" name, "sourceType" type, "publicationDate" d, "publisherUrl" pub, "rawText" raw, "createdAt" c
      from "SourceEvent" where ${PENDING} and "rawText" is not null and id > $1 order by id limit 250`, after);
    if (page.length === 0) break;
    rows.push(...page);
    after = page[page.length - 1].id;
  }
  const byHash = new Map<string, Row[]>();
  for (const r of rows) {
    const text = readableArticleText(r.raw); if (!text) continue;
    const h = crypto.createHash("sha256").update(text).digest("hex");
    (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(r);
  }
  // One batched lookup for which texts were already read; the full prior
  // record is fetched only for those.
  const seen = new Set<string>();
  const hashes = [...byHash.keys()];
  for (let i = 0; i < hashes.length; i += 500) {
    const hit = await prisma.sourceEvent.findMany({
      where: { articleTextHash: { in: hashes.slice(i, i + 500) }, processingStatus: { in: ["extracted", "excluded"] } },
      select: { articleTextHash: true },
    });
    for (const r of hit) if (r.articleTextHash) seen.add(r.articleTextHash);
  }
  // Identical text is often page chrome (paywall, chatbot panel, newsroom
  // shell) shared by different stories, so a copy only counts when its
  // headline names the same story as the one it would be merged into.
  let attachedToRead = 0, collapsedWithin = 0, boilerplateKept = 0;
  // Attached rows point at a real run so the write is auditable (and the FK holds).
  const runId = apply ? (await prisma.ingestionRun.create({ data: { runType: "backlog_prepare", status: "completed", completedAt: new Date() }, select: { id: true } })).id : "";
  for (const [h, g] of byHash) {
    const attached = new Set<string>();
    for (const r of seen.has(h) ? g : []) {
      const prior = await findReadByContent(h, r.t);
      if (!prior) continue;
      attached.add(r.id);
      attachedToRead++;
      if (apply) {
        const text = readableArticleText(r.raw)!;
        const art: RawArticle = { title: r.t ?? "", url: r.url, publishedAt: r.d?.toISOString() ?? null, snippet: null, sourceId: "backlog", provider: r.name ?? "", sourceType: r.type, publisherUrl: r.pub, bodyText: r.raw };
        await storeDuplicateContent(art, text, h, prior, runId).catch(e => console.error(`attach ${r.id}: ${String(e).slice(-300)}`));
      }
    }
    const rest = g.filter(r => !attached.has(r.id));
    if (rest.length < 2) continue;
    const [keep, ...others] = [...rest].sort((a, b) => (b.pub ? 1 : 0) - (a.pub ? 1 : 0) || a.c.getTime() - b.c.getTime());
    for (const r of others) {
      if (!sameStoryHeadline(keep.t, r.t)) { boilerplateKept++; continue; }
      collapsedWithin++;
      await exclude(r.id, `duplicate_content:${keep.id}`);
    }
  }
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`readable pending rows hashed: ${[...byHash.values()].reduce((n, g) => n + g.length, 0)} · copies of articles already read (attached): ${attachedToRead} · duplicate copies within the backlog: ${collapsedWithin} · same text, different story (kept): ${boilerplateKept}`);
  console.log(`pending ${apply ? "now" : "unchanged (dry run)"}: ${left}${apply ? "" : ` → would be ${left - attachedToRead - collapsedWithin}`}`);
  report("content", { attachedToRead, collapsedWithin, boilerplateKept, pendingAfter: apply ? left : left - attachedToRead - collapsedWithin });
}

(async () => {
  if (STEP === "headlines") await stepHeadlines();
  else if (STEP === "titles") await stepTitles();
  else if (STEP === "fetch") await stepFetch();
  else if (STEP === "content") await stepContent();
  else console.log("--step headlines|titles|fetch|content");
  await prisma.$disconnect();
  process.exit(0);
})();
