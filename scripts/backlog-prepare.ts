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
import { findReadByContent, storeDuplicateContent } from "@/lib/ingestion/store";
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
  const rows = await prisma.$queryRawUnsafe<{ id: string; url: string; t: string | null; name: string | null; type: string; d: Date | null; pub: string | null; raw: string | null; c: Date }[]>(`
    select id, "sourceUrl" url, "sourceTitle" t, "sourceName" name, "sourceType" type, "publicationDate" d, "publisherUrl" pub, "rawText" raw, "createdAt" c
    from "SourceEvent" where ${PENDING} and "rawText" is not null`);
  const byHash = new Map<string, typeof rows>();
  for (const r of rows) {
    const text = readableArticleText(r.raw); if (!text) continue;
    const h = crypto.createHash("sha256").update(text).digest("hex");
    (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(r);
  }
  let attachedToRead = 0, collapsedWithin = 0;
  for (const [h, g] of byHash) {
    const prior = await findReadByContent(h);
    if (prior) {
      for (const r of g) {
        attachedToRead++;
        if (apply) {
          const text = readableArticleText(r.raw)!;
          const art: RawArticle = { title: r.t ?? "", url: r.url, publishedAt: r.d?.toISOString() ?? null, snippet: null, sourceId: "backlog", provider: r.name ?? "", sourceType: r.type, publisherUrl: r.pub, bodyText: r.raw };
          await storeDuplicateContent(art, text, h, prior, "backlog-prepare").catch(e => console.error(`attach ${r.id}: ${String(e).slice(0, 100)}`));
        }
      }
      continue;
    }
    if (g.length < 2) continue;
    const [keep, ...rest] = [...g].sort((a, b) => (b.pub ? 1 : 0) - (a.pub ? 1 : 0) || a.c.getTime() - b.c.getTime());
    for (const r of rest) { collapsedWithin++; await exclude(r.id, `duplicate_content:${keep.id}`); }
  }
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`readable pending rows hashed: ${[...byHash.values()].reduce((n, g) => n + g.length, 0)} · copies of articles already read (attached): ${attachedToRead} · duplicate copies within the backlog: ${collapsedWithin}`);
  console.log(`pending ${apply ? "now" : "unchanged (dry run)"}: ${left}${apply ? "" : ` → would be ${left - attachedToRead - collapsedWithin}`}`);
  report("content", { attachedToRead, collapsedWithin, pendingAfter: apply ? left : left - attachedToRead - collapsedWithin });
}

(async () => {
  if (STEP === "headlines") await stepHeadlines();
  else if (STEP === "fetch") await stepFetch();
  else if (STEP === "content") await stepContent();
  else console.log("--step headlines|fetch|content");
  await prisma.$disconnect();
  process.exit(0);
})();
