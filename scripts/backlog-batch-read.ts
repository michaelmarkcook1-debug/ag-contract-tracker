/**
 * Read the pending backlog through the Anthropic Message Batches API (half
 * price), under a hard spend cap.
 *
 * Same prompt, parsing, grounding and storage as the live pipeline: requests
 * come from readerPrompts/readerRequestParams, results go through
 * assembleReading and then storeReading/storeNonEvent/storePending, so a
 * batch-read article is indistinguishable from a cron-read one.
 *
 * Spend control: a pilot batch measures the real cost per article; each later
 * batch is sized to the budget left, less a 15% margin. Cost is only known
 * after a batch ends, so the cap is enforced by sizing, never by hope.
 *
 * Crash-safe: submitted batches are recorded in _scratch/batch-read.json and
 * collected on the next start before anything new is submitted.
 *
 *   npx tsx scripts/backlog-batch-read.ts --budget 10 [--pilot 120] [--apply]
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readableArticleText } from "@/lib/ingestion/article-text";
import { readerPrompts, readerRequestParams, parseReaderResponse, assembleReading } from "@/lib/ingestion/reader";
import { storeReading, storeNonEvent, storePending, storeUnreadable, findReadByContent, storeDuplicateContent, MAX_READ_ATTEMPTS } from "@/lib/ingestion/store";
import type { RawArticle } from "@/lib/ingestion/crawler";

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 200)));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BUDGET = Number(arg("--budget", "0"));
const PILOT = Number(arg("--pilot", "120"));
const apply = process.argv.includes("--apply");
const STATE = "_scratch/batch-read.json";
const API = "https://api.anthropic.com/v1/messages/batches";
const headers = () => ({ "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" });

interface Item { rowId: string; article: RawArticle; text: string; segments: number }
interface BatchRec { id: string; items: Item[]; submittedAt: string; collected?: boolean; costUsd?: number }
interface State { runId: string; spentUsd: number; batches: BatchRec[] }

const loadState = (): State | null => fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null;
const saveState = (s: State) => { fs.mkdirSync("_scratch", { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s)); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * GET with retries. Network loss (the laptop sleeping, DNS gone) is waited out
 * indefinitely — the batch is safe at Anthropic; HTTP errors get 5 retries.
 */
async function getWithRetry(url: string): Promise<Response> {
  for (let httpFails = 0; ;) {
    try {
      const res = await fetch(url, { headers: headers() });
      if (res.ok || ++httpFails > 5) return res;
      await sleep(10_000 * httpFails);
    } catch {
      await sleep(60_000);
    }
  }
}

/** Next pending rows in the cron's drain order, skipping any already in a batch. */
async function nextItems(n: number, exclude: Set<string>, runId: string): Promise<{ items: Item[]; skipped: { unreadable: number; dupes: number } }> {
  // Order and ids first (small), then bodies in pages of 100 — one query
  // returning ~1,000 article bodies is dropped by the Neon websocket.
  const order = await prisma.sourceEvent.findMany({
    where: { processingStatus: "pending", readAttempts: { lt: MAX_READ_ATTEMPTS }, id: { notIn: [...exclude] } },
    orderBy: [{ readAttempts: "asc" }, { publicationDate: { sort: "desc", nulls: "last" } }],
    take: n, select: { id: true },
  });
  const byId = new Map<string, { id: string; sourceUrl: string; publisherUrl: string | null; sourceTitle: string | null; sourceName: string | null; sourceType: string; publicationDate: Date | null; rawText: string | null }>();
  for (let i = 0; i < order.length; i += 100) {
    const page = await prisma.sourceEvent.findMany({
      where: { id: { in: order.slice(i, i + 100).map(o => o.id) } },
      select: { id: true, sourceUrl: true, publisherUrl: true, sourceTitle: true, sourceName: true, sourceType: true, publicationDate: true, rawText: true },
    });
    page.forEach(r => byId.set(r.id, r));
  }
  const rows = order.map(o => byId.get(o.id)!).filter(Boolean);
  const items: Item[] = [];
  let unreadable = 0, dupes = 0;
  for (const p of rows) {
    const article: RawArticle = { title: p.sourceTitle ?? "", url: p.sourceUrl, publishedAt: p.publicationDate?.toISOString() ?? null, snippet: null, sourceId: "pending", provider: p.sourceName ?? "", sourceType: p.sourceType, publisherUrl: p.publisherUrl, bodyText: p.rawText };
    const text = readableArticleText(p.rawText) ?? "";
    if (!text) { unreadable++; if (apply) await storeUnreadable(article, runId); continue; }
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const prior = await findReadByContent(hash, article.title);
    if (prior) { dupes++; if (apply) await storeDuplicateContent(article, text, hash, prior, runId); continue; }
    items.push({ rowId: p.id, article, text, segments: readerPrompts({ title: article.title, text, provider: article.provider, sourceType: article.sourceType, publishedAt: article.publishedAt }).prompts.length });
  }
  return { items, skipped: { unreadable, dupes } };
}

async function submit(items: Item[]): Promise<string> {
  const requests = items.flatMap(it => {
    const { prompts } = readerPrompts({ title: it.article.title, text: it.text, provider: it.article.provider, sourceType: it.article.sourceType, publishedAt: it.article.publishedAt });
    return prompts.map((prompt, s) => ({ custom_id: `${it.rowId}_${s}`, params: readerRequestParams(prompt) }));
  });
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let status = 0, body = "";
    try {
      const res = await fetch(API, { method: "POST", headers: headers(), body: JSON.stringify({ requests }) });
      status = res.status; body = await res.text();
      if (res.ok) {
        const b = JSON.parse(body) as { id: string };
        console.log(`submitted ${b.id}: ${items.length} articles, ${requests.length} requests`);
        return b.id;
      }
    } catch (err) { body = String(err); }
    // A 5xx or dropped connection may still have created the batch: adopt it
    // rather than submit (and pay for) the same requests twice.
    const list = await getWithRetry(`${API}?limit=10`).then(r => r.json()) as { data: { id: string; created_at: string; request_counts: Record<string, number> }[] };
    const made = list.data.find(b => Date.parse(b.created_at) >= started - 5_000 && Object.values(b.request_counts).reduce((a, n) => a + n, 0) === requests.length);
    if (made) { console.log(`submitted ${made.id} (adopted after HTTP ${status}): ${items.length} articles, ${requests.length} requests`); return made.id; }
    if ((status && status < 500 && status !== 429) || attempt >= 5) throw new Error(`batch submit HTTP ${status}: ${body.slice(0, 300)}`);
    console.log(`  submit HTTP ${status || "network"} — retry ${attempt} in ${30 * attempt}s`);
    await sleep(30_000 * attempt);
  }
}

async function waitFor(id: string): Promise<string> {
  for (;;) {
    const res = await getWithRetry(`${API}/${id}`);
    if (!res.ok) throw new Error(`batch status HTTP ${res.status}`);
    const b = await res.json() as { processing_status: string; results_url: string | null; request_counts: Record<string, number> };
    if (b.processing_status === "ended" && b.results_url) return b.results_url;
    console.log(`  ${id} ${b.processing_status} ${JSON.stringify(b.request_counts)}`);
    await sleep(30_000);
  }
}

type Counts = { published: number; queued: number; merged: number; nonEvent: number; failed: number; costUsd: number; outputTokens: number; inputTokens: number };

/** Collect one ended batch and store every article exactly as the pipeline does. */
async function collect(rec: BatchRec, runId: string): Promise<Counts> {
  const url = await waitFor(rec.id);
  const res = await getWithRetry(url);
  if (!res.ok) throw new Error(`batch results HTTP ${res.status}`);
  const byId = new Map<string, ReturnType<typeof parseReaderResponse>>();
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { custom_id: string; result: { type: string; message?: Parameters<typeof parseReaderResponse>[0]; error?: unknown } };
    byId.set(r.custom_id, r.result.type === "succeeded" && r.result.message
      ? parseReaderResponse(r.result.message, 0.5)
      : { parsed: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, error: `batch ${r.result.type}` });
  }
  const c: Counts = { published: 0, queued: 0, merged: 0, nonEvent: 0, failed: 0, costUsd: 0, outputTokens: 0, inputTokens: 0 };
  // Sequential, like the pipeline's store phase: a re-report must see the
  // event stored a moment earlier and attach to it.
  for (const it of rec.items) {
    const results = Array.from({ length: it.segments }, (_, s) => byId.get(`${it.rowId}_${s}`)
      ?? { parsed: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, error: "batch result missing" });
    const { text } = readerPrompts({ title: it.article.title, text: it.text });
    const out = assembleReading(text, results);
    // Every segment is billed even when an earlier one failed.
    for (const r of results) { c.costUsd += r.usage.costUsd; c.outputTokens += r.usage.outputTokens; c.inputTokens += r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens; }
    try {
      if (!out.ok) { c.failed++; await storePending(it.article, it.text, out.error, runId); continue; }
      if (out.reading.events.length === 0) { c.nonEvent++; await storeNonEvent(it.article, it.text, out.reading, runId); continue; }
      const s = await storeReading(it.article, it.text, out.reading, runId);
      c.published += s.published; c.queued += s.queued; c.merged += s.merged;
      if (s.published + s.queued + s.merged === 0) c.nonEvent++;
    } catch (err) {
      console.error(`store ${it.rowId}: ${String(err).slice(-200)}`);
    }
  }
  return c;
}

(async () => {
  if (!(BUDGET > 0)) { console.log("--budget <usd> is required"); process.exit(1); }
  let state = loadState();
  if (!state) {
    const runId = apply ? (await prisma.ingestionRun.create({ data: { runType: "backlog_batch" }, select: { id: true } })).id : "dry";
    state = { runId, spentUsd: 0, batches: [] };
  }
  const totals: Counts = { published: 0, queued: 0, merged: 0, nonEvent: 0, failed: 0, costUsd: 0, outputTokens: 0, inputTokens: 0 };
  let articlesRead = 0;
  const add = (c: Counts) => { for (const k of Object.keys(totals) as (keyof Counts)[]) totals[k] += c[k]; };

  const finish = async (rec: BatchRec) => {
    const c = await collect(rec, state!.runId);
    rec.collected = true; rec.costUsd = c.costUsd;
    state!.spentUsd += c.costUsd; articlesRead += rec.items.length; add(c);
    saveState(state!);
    console.log(`collected ${rec.id}: ${rec.items.length} articles · $${c.costUsd.toFixed(2)} ($${(c.costUsd / rec.items.length).toFixed(4)}/article) · published ${c.published}, review ${c.queued}, merged ${c.merged}, no event ${c.nonEvent}, failed ${c.failed} · spent $${state!.spentUsd.toFixed(2)} of $${BUDGET}`);
  };

  // Anything submitted before a crash is collected first.
  for (const rec of state.batches.filter(b => !b.collected)) await finish(rec);

  const inFlight = () => new Set(state!.batches.flatMap(b => b.items.map(i => i.rowId)));
  // Cost model from what has been collected: half the measured cost treated as
  // a per-article overhead (prompt, system, output scaffolding), half as
  // proportional to article length. Each batch is trimmed so its projection
  // fits the budget left less 15%.
  const model = () => {
    const done = state!.batches.filter(b => b.collected && b.costUsd != null);
    const arts = done.reduce((s, b) => s + b.items.length, 0);
    const chars = done.reduce((s, b) => s + b.items.reduce((t, i) => t + i.text.length, 0), 0);
    const spent = done.reduce((s, b) => s + b.costUsd!, 0);
    return arts ? { perArticle: 0.5 * spent / arts, perChar: 0.5 * spent / chars, avg: spent / arts } : null;
  };

  for (;;) {
    const left = BUDGET - state.spentUsd;
    const m = model();
    if (m && left * 0.85 < m.avg * 20) { console.log(`stopping: $${left.toFixed(2)} left buys fewer than ~20 articles`); break; }
    const want = m ? Math.min(2000, Math.ceil((left * 0.85 / m.avg) * 1.3)) : PILOT;
    const { items: candidates, skipped } = await nextItems(want, inFlight(), state.runId);
    if (skipped.unreadable || skipped.dupes) console.log(`  skipped before spend: ${skipped.unreadable} unreadable, ${skipped.dupes} copies of articles already read`);
    let items = candidates, projected = 0;
    if (m) {
      items = [];
      for (const it of candidates) {
        const est = m.perArticle + m.perChar * it.text.length;
        if (projected + est > left * 0.85) break;
        items.push(it); projected += est;
      }
    }
    if (items.length === 0) { console.log(candidates.length ? "stopping: budget left does not cover the next article" : "backlog empty"); break; }
    const chars = items.reduce((s, i) => s + i.text.length, 0);
    console.log(`next batch: ${items.length} articles, ${(chars / 1e6).toFixed(1)}M chars${m ? `, projected $${projected.toFixed(2)} of $${left.toFixed(2)} left` : " (pilot)"}`);
    if (!apply) { console.log("dry run — nothing submitted"); break; }
    // Chunks of 200 articles, all submitted before any is collected, so they
    // process in parallel at Anthropic.
    const recs: BatchRec[] = [];
    for (let k = 0; k < items.length; k += 200) {
      const chunk = items.slice(k, k + 200);
      const rec: BatchRec = { id: await submit(chunk), items: chunk, submittedAt: new Date().toISOString() };
      state.batches.push(rec); saveState(state); recs.push(rec);
    }
    for (const rec of recs) await finish(rec);
    if (state.spentUsd >= BUDGET) { console.log("budget reached"); break; }
  }

  if (apply) {
    await prisma.ingestionRun.update({
      where: { id: state.runId },
      data: {
        status: "completed", completedAt: new Date(),
        articlesTriaged: { increment: articlesRead }, eventsPublished: { increment: totals.published }, eventsQueued: { increment: totals.queued },
        articlesMerged: { increment: totals.merged }, articlesExcluded: { increment: totals.nonEvent },
        eventsExtracted: { increment: totals.published + totals.queued },
        inputTokens: { increment: totals.inputTokens }, outputTokens: { increment: totals.outputTokens }, costUsd: { increment: totals.costUsd },
      },
    });
  }
  const pending = await prisma.sourceEvent.count({ where: { processingStatus: "pending" } });
  console.log(`\nthis session: ${articlesRead} articles read · $${totals.costUsd.toFixed(2)} · published ${totals.published}, review ${totals.queued}, merged into existing ${totals.merged}, no event ${totals.nonEvent}, failed ${totals.failed}`);
  console.log(`total spent on this backlog run: $${state.spentUsd.toFixed(2)} of $${BUDGET} · pending now ${pending}`);
  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error("FATAL (state kept; rerun to resume):", e); process.exit(1); });
