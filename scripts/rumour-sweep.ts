/**
 * Published events that are really rumours, found in the catalogue's history.
 *
 * Candidates (structural only): published CONTRACT, M_AND_A, PARTNERSHIP and ORG_CHANGE events announced in the last
 * --months months (default 6), not already rumoured, terminated or disputed, with article text, excluding procurement
 * award records (they are award notices, not news).
 *
 *   1. screen   Haiku 5.5 reads each full article and flags any sign that the event is not confirmed (talks,
 *               sources, exploring, considering, planned layoffs). Recall first: it is only a screen.
 *   2. confirm  Sonnet 5.5 reads each flagged article in full with the review prompt (src/lib/ingestion/review-reread)
 *               — the owner's rule: Sonnet assigns rumours. Only a RUMOUR answer whose quote is in the article and
 *               whose family matches is applied: eventStatus becomes RUMOURED (the event stays published, now in the
 *               Rumours view and out of every count). Its write-up is kept when the event has none.
 * Both stages use the Batch API (half price) under a hard cap; answers are cached in _scratch. Every change is logged
 * to ReviewAction (action "rumour_sweep") and reversed by --undo.
 *
 *   npx tsx scripts/rumour-sweep.ts [--months 6] [--budget 7] [--apply]
 *   npx tsx scripts/rumour-sweep.ts --undo
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readableArticleText } from "@/lib/ingestion/article-text";
import { requestParams, parseAnswer, plan, type Answer, type Item } from "@/lib/ingestion/review-reread";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const MONTHS = Number(arg("--months", "6"));
const BUDGET = Number(arg("--budget", "7"));
const apply = process.argv.includes("--apply");
const VERSION = "rumour-sweep/1.0.0-2026-11-27";
const ACTION = "rumour_sweep";
const SCREEN_CACHE = "_scratch/rumour-screen.json";
const CONFIRM_CACHE = "_scratch/rumour-confirm.json";
const API = "https://api.anthropic.com/v1/messages/batches";
const headers = () => ({ "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Haiku 5.5, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, read 2026-11-27), batch = half. Prompts here stay under 100k tokens. */
const HAIKU = { id: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };

const SCREEN_SYSTEM = `You screen news articles for an IT-services market tracker. Each item is one event already recorded as confirmed, with the article it came from. Decide whether the article shows the event might NOT be confirmed: reported talks or negotiations, "in discussions", "exploring a sale", "considering", "weighing", "plans to", unnamed sources or "people familiar with the matter", a report the company declined to confirm, a rumoured or planned layoff not yet announced, a deal "nearing" agreement. When in doubt, flag it: a second reader will check.
An event the parties have announced, signed, completed, terminated or disputed is confirmed.
Reply with JSON only: {"unconfirmed": true|false, "why": "<12 words>"}`;

interface Screen { unconfirmed: boolean; why: string; costUsd: number }

async function loadCandidates(): Promise<Item[]> {
  const since = new Date(Date.now() - MONTHS * 30.44 * 86_400_000);
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: {
      publicationStatus: "published", family: { in: ["CONTRACT", "M_AND_A", "PARTNERSHIP", "ORG_CHANGE"] },
      OR: [{ announcementDate: { gte: since } }, { announcementDate: null, createdAt: { gte: since } }],
      AND: [{ OR: [{ eventStatus: null }, { eventStatus: { notIn: ["RUMOURED", "TERMINATED", "DISPUTED", "rumoured", "terminated", "disputed"] } }] },
        { OR: [{ readerVersion: null }, { NOT: { readerVersion: { startsWith: "procurement-import" } } }] }],
    },
    select: { id: true, family: true, eventStatus: true, canonicalTitle: true, counterpartyRaw: true, supportingText: true,
      primaryEntity: { select: { canonicalName: true } }, contractDetails: { select: { clientRaw: true, clientDescriptor: true } }, sourceEvents: { select: { id: true }, take: 5 } },
  });
  const items: Item[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const srcs = await prisma.sourceEvent.findMany({ where: { id: { in: chunk.flatMap(r => r.sourceEvents.map(s => s.id)) } }, select: { id: true, sourceTitle: true, rawText: true } });
    const byId = new Map(srcs.map(s => [s.id, s]));
    for (const r of chunk) {
      const best = r.sourceEvents.map(s => byId.get(s.id)).filter(Boolean).map(s => ({ title: s!.sourceTitle ?? "", text: readableArticleText(s!.rawText) ?? "" })).sort((a, b) => b.text.length - a.text.length)[0];
      if (!best?.text) continue;
      let quote: string | null = null;
      try { quote = (JSON.parse(r.supportingText ?? "{}") as { event?: string }).event ?? null; } catch { /* none */ }
      items.push({ id: r.id, family: r.family, eventStatus: r.eventStatus, title: r.canonicalTitle, provider: r.primaryEntity?.canonicalName ?? null,
        counterparty: r.contractDetails?.clientRaw ?? r.counterpartyRaw, descriptor: r.contractDetails?.clientDescriptor ?? null, quote,
        reason: "published as confirmed; checked again for whether it is only rumoured", headline: best.title, text: best.text });
    }
  }
  return items;
}

/** Submit requests in batches of 500, wait, and return each result by custom_id. */
async function runBatches(requests: { custom_id: string; params: unknown }[], label: string): Promise<Map<string, { type: string; message?: Record<string, unknown> }>> {
  const out = new Map<string, { type: string; message?: Record<string, unknown> }>();
  const ids: string[] = [];
  // Batch custom_ids are limited to 64 characters and some event ids are longer: send a short hash, map it back.
  const back = new Map<string, string>();
  const short = requests.map(r => { const k = crypto.createHash("sha1").update(r.custom_id).digest("hex").slice(0, 32); back.set(k, r.custom_id); return { ...r, custom_id: k }; });
  for (let i = 0; i < short.length; i += 500) {
    const res = await fetch(API, { method: "POST", headers: headers(), body: JSON.stringify({ requests: short.slice(i, i + 500) }) });
    const body = await res.text();
    // A failed submission stops further submissions, but what was already submitted is still collected (and paid for once).
    if (!res.ok) { console.error(`${label} submit HTTP ${res.status}: ${body.slice(0, 200)} — collecting what was submitted`); break; }
    ids.push((JSON.parse(body) as { id: string }).id);
  }
  console.log(`${label}: submitted ${requests.length} in ${ids.length} batch(es)`);
  for (const id of ids) {
    let url: string | null = null;
    for (;;) {
      const s = await (await fetch(`${API}/${id}`, { headers: headers() })).json() as { processing_status: string; results_url: string | null; request_counts: Record<string, number> };
      if (s.processing_status === "ended" && s.results_url) { url = s.results_url; break; }
      await sleep(30_000);
    }
    for (const line of (await (await fetch(url, { headers: headers() })).text()).split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { custom_id: string; result: { type: string; message?: Record<string, unknown> } };
      out.set(back.get(r.custom_id) ?? r.custom_id, r.result);
    }
  }
  return out;
}

async function screen(items: Item[]): Promise<Record<string, Screen>> {
  const cache: Record<string, Screen> = fs.existsSync(SCREEN_CACHE) ? JSON.parse(fs.readFileSync(SCREEN_CACHE, "utf8")) : {};
  const todo = items.filter(e => !cache[e.id]);
  // Projected from the measured Haiku cost of earlier batches when there are any; else ~2,600 input / 400 output tokens per item.
  const done = Object.values(cache);
  const per = done.length ? done.reduce((s, x) => s + x.costUsd, 0) / done.length : (2600 * HAIKU.input + 400 * HAIKU.output) / 1e6 * 0.5;
  console.log(`screen: ${items.length} candidates, ${todo.length} to read · projected $${(todo.length * per).toFixed(2)}`);
  if (todo.length * per > BUDGET * 0.5) throw new Error("screen projection exceeds half the cap; nothing submitted");
  if (!todo.length) return cache;
  const results = await runBatches(todo.map(e => ({ custom_id: e.id, params: {
    model: HAIKU.id, max_tokens: 2500, system: [{ type: "text", text: SCREEN_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `EVENT: ${e.title}\nfamily: ${e.family} · recorded status: ${e.eventStatus ?? "unknown"}\nextractor's passage: ${e.quote ?? "(none)"}\n\nHEADLINE: ${e.headline}\nARTICLE:\n${e.text.slice(0, 30_000)}` }],
  } })), "screen");
  for (const [id, r] of results) {
    const m = r.message as { content?: { type?: string; text?: string }[]; usage?: Record<string, number> } | undefined;
    if (r.type !== "succeeded" || !m) continue;
    const u = m.usage ?? {};
    const costUsd = 0.5 * ((u.input_tokens ?? 0) * HAIKU.input + (u.cache_read_input_tokens ?? 0) * HAIKU.cacheRead + (u.cache_creation_input_tokens ?? 0) * HAIKU.cacheWrite + (u.output_tokens ?? 0) * HAIKU.output) / 1e6;
    const raw = (m.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
    const v = /"unconfirmed"\s*:\s*(true|false)/.exec(raw);
    // An unparsed answer is flagged, not dropped: the screen favours recall.
    cache[id] = { unconfirmed: v ? v[1] === "true" : true, why: (/"why"\s*:\s*"([^"]*)/.exec(raw)?.[1] ?? (v ? "" : "unparsed")).slice(0, 140), costUsd };
  }
  fs.writeFileSync(SCREEN_CACHE, JSON.stringify(cache));
  return cache;
}

async function confirm(items: Item[], budgetLeft: number): Promise<Record<string, Answer>> {
  const cache: Record<string, Answer> = fs.existsSync(CONFIRM_CACHE) ? JSON.parse(fs.readFileSync(CONFIRM_CACHE, "utf8")) : {};
  const todo = items.filter(e => !cache[e.id]);
  const per = 0.0065;   // measured: the Sonnet review read cost $3.72 for 608 items at batch price (2026-11-27)
  console.log(`confirm: ${items.length} flagged, ${todo.length} to read with Sonnet · projected $${(todo.length * per).toFixed(2)} (left under cap $${budgetLeft.toFixed(2)})`);
  if (todo.length * per > budgetLeft * 0.9) throw new Error("confirm projection exceeds the cap left; nothing submitted");
  if (!todo.length) return cache;
  const byId = new Map(todo.map(e => [e.id, e]));
  const results = await runBatches(todo.map(e => ({ custom_id: e.id, params: requestParams("sonnet", e) })), "confirm");
  for (const [id, r] of results) if (r.type === "succeeded" && r.message) cache[id] = parseAnswer("sonnet", r.message as Parameters<typeof parseAnswer>[1], byId.get(id)!.text, 0.5);
  fs.writeFileSync(CONFIRM_CACHE, JSON.stringify(cache));
  return cache;
}

async function undo() {
  const acts = await prisma.reviewAction.findMany({ where: { action: ACTION, newValue: "RUMOURED" }, orderBy: { createdAt: "desc" } });
  let n = 0;
  for (const a of acts) {
    const b = JSON.parse(a.previousValue ?? "{}") as { eventStatus?: string | null; analystInsight?: string | null };
    const r = await prisma.canonicalMarketEvent.updateMany({ where: { id: a.eventId, eventStatus: "RUMOURED" }, data: { eventStatus: b.eventStatus ?? null, ...(b.analystInsight !== undefined ? { analystInsight: b.analystInsight } : {}) } });
    n += r.count;
  }
  await prisma.reviewAction.updateMany({ where: { action: ACTION, newValue: "RUMOURED" }, data: { newValue: "undone" } });
  console.log(`restored ${n} events to their previous status`);
}

async function main() {
  if (process.argv.includes("--undo")) return undo();
  const items = await loadCandidates();
  const sc = await screen(items);
  const screenCost = items.reduce((s, e) => s + (sc[e.id]?.costUsd ?? 0), 0);
  const flagged = items.filter(e => sc[e.id]?.unconfirmed);
  console.log(`screen: ${flagged.length} of ${items.length} flagged as possibly unconfirmed · $${screenCost.toFixed(2)}`);
  const ans = await confirm(flagged, BUDGET - screenCost);
  const confirmCost = flagged.reduce((s, e) => s + (ans[e.id]?.costUsd ?? 0), 0);
  const tally: Record<string, number> = {};
  const rumours: { e: Item; a: Answer }[] = [];
  for (const e of flagged) {
    const a = ans[e.id];
    if (!a) continue;
    tally[a.decision] = (tally[a.decision] ?? 0) + 1;
    if (plan(e, a).to === "rumour") rumours.push({ e, a });
  }
  console.log(`confirm: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")} · $${confirmCost.toFixed(2)} · total spent $${(screenCost + confirmCost).toFixed(2)}`);
  const fam: Record<string, number> = {};
  for (const { e } of rumours) fam[e.family] = (fam[e.family] ?? 0) + 1;
  console.log(`rumours to apply (quoted, same type): ${rumours.length} — ${Object.entries(fam).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(", ")}`);
  for (const { e, a } of rumours.slice(0, 25)) console.log(`  • ${e.title.slice(0, 100)}\n      ${a.why ?? ""}`);
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply."); return; }
  let n = 0;
  for (const { e, a } of rumours) {
    const cur = await prisma.canonicalMarketEvent.findUnique({ where: { id: e.id }, select: { eventStatus: true, analystInsight: true, publicationStatus: true } });
    if (!cur || cur.publicationStatus !== "published" || cur.eventStatus?.toUpperCase() === "RUMOURED") continue;
    await prisma.$transaction([
      prisma.canonicalMarketEvent.update({ where: { id: e.id }, data: { eventStatus: "RUMOURED", ...(!cur.analystInsight && a.writeUp ? { analystInsight: a.writeUp } : {}) } }),
      prisma.reviewAction.create({ data: { eventId: e.id, action: ACTION, reviewerNote: `${VERSION} sonnet RUMOUR: ${a.why ?? ""}`.slice(0, 500),
        previousValue: JSON.stringify({ eventStatus: cur.eventStatus, analystInsight: cur.analystInsight }), newValue: "RUMOURED" } }),
    ]);
    n++;
  }
  console.log(`applied: ${n} events moved to Rumours. Undo with: npx tsx scripts/rumour-sweep.ts --undo`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0)).catch(async e => { console.error(String(e)); await prisma.$disconnect(); process.exit(1); });
