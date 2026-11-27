/**
 * The review queue, read again in full by a stronger model and settled.
 *
 * Every event held for review is sent with its whole article (not the headline,
 * not the extractor's quote alone) and one question: what is this, really?
 *
 *   PUBLISH       the article reports the event as news and it is confirmed
 *                 (announced, completed, terminated or disputed). An unnamed
 *                 client is fine: it is published as undisclosed, coded by
 *                 region and industry.
 *   RUMOUR        reported but not confirmed by the parties (talks, exploring,
 *                 sources say, planned layoffs) — the Rumours view.
 *   OPPORTUNITY   a public tender, RFP, bid or shortlist.
 *   MENTION       a real event the article only mentions in passing — parked.
 *   NOT_EVENT     the article does not report this event, or it is not a
 *                 commercial event with the provider as a party — dismissed.
 *   NEEDS_PERSON  genuinely unclear; stays in review.
 *
 * The answer must quote the article; a quote that is not in the text sends the
 * item back to a person. Answers are cached per model in _scratch, so a pilot,
 * a comparison and the final run never pay twice for the same read.
 *
 * Pilot (synchronous calls, nothing written):
 *   npx tsx scripts/review-reread.ts --sample 30 --models opus,sonnet
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { PRICES, REREAD_ACTION as ACTION, reasonWords, loadQueue, askNow, requestParams, parseAnswer, settleEvent, type Answer, type Outcome } from "@/lib/ingestion/review-reread";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "30"));
const MODELS = arg("--models", "opus").split(",");
async function pilot() {
  const { items, noText } = await loadQueue();
  console.log(`review queue: ${items.length + noText} items, ${items.length} with article text, ${noText} without (they stay for a person)`);
  // A spread sample: ordered by a hash of the id, so every reason group is represented without hand-picking.
  const sample = [...items].sort((a, b) => crypto.createHash("md5").update(a.id).digest("hex").localeCompare(crypto.createHash("md5").update(b.id).digest("hex"))).slice(0, SAMPLE);
  const answers: Record<string, Record<string, Answer>> = {};
  for (const model of MODELS) {
    const file = `_scratch/review-reread-${model}.json`;
    const cache: Record<string, Answer> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const todo = sample.filter(e => !cache[e.id]);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        const e = todo[next++];
        if (!e) return;
        try { cache[e.id] = await askNow(model, e); }
        catch (err) { console.error(`  ${model} ${e.id}: ${String(err).slice(0, 160)}`); }
      }
    }));
    fs.writeFileSync(file, JSON.stringify(cache));
    answers[model] = cache;
    const got = sample.map(e => cache[e.id]).filter(Boolean);
    const cost = got.reduce((s, a) => s + a.costUsd, 0), inTok = got.reduce((s, a) => s + a.inputTokens, 0), outTok = got.reduce((s, a) => s + a.outputTokens, 0);
    const tally: Record<string, number> = {};
    for (const a of got) tally[a.decision] = (tally[a.decision] ?? 0) + 1;
    console.log(`\n${model} (${PRICES[model].id}): ${got.length} answered · $${cost.toFixed(2)} ($${(cost / Math.max(1, got.length)).toFixed(4)}/item, sync price) · avg ${Math.round(inTok / Math.max(1, got.length))} in / ${Math.round(outTok / Math.max(1, got.length))} out tokens`);
    console.log(`  decisions: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")} · quote found in article: ${got.filter(a => a.grounded).length}/${got.length}`);
    console.log(`  whole queue (${items.length}) at batch price ≈ $${(cost / Math.max(1, got.length) * items.length * 0.5).toFixed(2)}`);
  }
  if (MODELS.length > 1) {
    const [a, b] = MODELS;
    const both = sample.filter(e => answers[a][e.id] && answers[b][e.id]);
    const agree = both.filter(e => answers[a][e.id].decision === answers[b][e.id].decision).length;
    console.log(`\n${a} and ${b} agree on ${agree} of ${both.length} decisions`);
  }
  console.log("");
  for (const e of sample) {
    console.log(`• [${e.family}] ${e.title.slice(0, 110)}\n    held: ${reasonWords(e.reason).slice(0, 120)}`);
    for (const model of MODELS) {
      const x = answers[model][e.id];
      if (!x) { console.log(`    ${model.padEnd(6)} (no answer)`); continue; }
      const client = x.counterparty ?? (x.counterpartyDescriptor ? `undisclosed: ${x.counterpartyDescriptor}` : "-");
      console.log(`    ${model.padEnd(6)} ${x.decision}${x.grounded ? "" : " (quote not found)"} · ${x.family ?? "?"}/${x.eventStatus ?? "?"} · ${client.slice(0, 50)} · ${x.clientRegion ?? "-"} · ${x.clientIndustry ?? "-"} — ${x.why ?? x.error ?? ""}`);
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}

// ── Whole queue: Batch API (half price), then apply ─────────────────────────

const BATCH_API = "https://api.anthropic.com/v1/messages/batches";
const headers = () => ({ "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const MODEL = MODELS[0];
/** Apply only these outcomes (e.g. --only rumour); everything else is left for the next stage. */
const ONLY = process.argv.includes("--only") ? arg("--only", "").split(",") as Outcome[] : undefined;
const CACHE = arg("--cache", `_scratch/review-reread-${MODEL}.json`);
const STATE = `_scratch/review-reread-batch-${MODEL}.json`;
const loadCache = (): Record<string, Answer> => fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

/** Read every queue item that has no answer yet, through the Batch API, under a hard cap. */
async function runBatch(budget: number) {
  const { items, noText } = await loadQueue();
  const cache = loadCache();
  const done = Object.values(cache);
  const perItem = done.length ? done.reduce((s, a) => s + a.costUsd, 0) / done.length : 0.03;
  // --skip <file>: a JSON list of ids another stage has already settled (the Sonnet rumours), not read again.
  const skip = new Set<string>(process.argv.includes("--skip") ? JSON.parse(fs.readFileSync(arg("--skip", ""), "utf8")) : []);
  const todo = items.filter(e => !cache[e.id] && !skip.has(e.id));
  const projected = todo.length * perItem * 0.5;
  console.log(`queue ${items.length + noText}: ${items.length} with text (${items.length - todo.length} already read), ${noText} without · to read ${todo.length} · projected $${projected.toFixed(2)} at batch price (cap $${budget})`);
  if (projected > budget * 0.9) { console.log("projection exceeds the cap; nothing submitted"); return; }
  const state: { batches: { id: string; ids: string[]; collected?: boolean }[] } = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { batches: [] };
  const byId = new Map(items.map(e => [e.id, e]));
  const inFlight = new Set(state.batches.filter(b => !b.collected).flatMap(b => b.ids));
  const fresh = todo.filter(e => !inFlight.has(e.id));
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    const res = await fetch(BATCH_API, { method: "POST", headers: headers(), body: JSON.stringify({ requests: chunk.map(e => ({ custom_id: e.id, params: requestParams(MODEL, e) })) }) });
    const body = await res.text();
    if (!res.ok) throw new Error(`batch submit HTTP ${res.status}: ${body.slice(0, 200)}`);
    const id = (JSON.parse(body) as { id: string }).id;
    state.batches.push({ id, ids: chunk.map(e => e.id) });
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`submitted ${id}: ${chunk.length}`);
  }
  let spent = 0;
  for (const b of state.batches.filter(x => !x.collected)) {
    let url: string | null = null;
    for (;;) {
      const s = await (await fetch(`${BATCH_API}/${b.id}`, { headers: headers() })).json() as { processing_status: string; results_url: string | null; request_counts: Record<string, number> };
      if (s.processing_status === "ended" && s.results_url) { url = s.results_url; break; }
      console.log(`  ${b.id} ${s.processing_status} ${JSON.stringify(s.request_counts)}`);
      await sleep(30_000);
    }
    const lines = (await (await fetch(url, { headers: headers() })).text()).split("\n").filter(l => l.trim());
    for (const line of lines) {
      const r = JSON.parse(line) as { custom_id: string; result: { type: string; message?: Parameters<typeof parseAnswer>[1] } };
      const e = byId.get(r.custom_id);
      if (!e || r.result.type !== "succeeded" || !r.result.message) continue;
      cache[r.custom_id] = parseAnswer(MODEL, r.result.message, e.text, 0.5);
      spent += cache[r.custom_id].costUsd;
    }
    b.collected = true;
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`collected ${b.id}: ${lines.length} answers · $${spent.toFixed(2)} so far`);
  }
  console.log(`read complete · this run $${spent.toFixed(2)}`);
}

async function apply(write: boolean, only?: Outcome[]) {
  const cache = loadCache();
  const tally: Record<string, number> = {};
  const labels: string[] = [];
  let applied = 0;
  for (const [id, a] of Object.entries(cache)) {
    const r = await settleEvent(id, MODEL, a, { write, only });
    if (!r.applied && write) continue;
    tally[r.to] = (tally[r.to] ?? 0) + 1;
    if (r.applied) applied++;
    if (r.label && (r.to === "published" || r.to === "rumour")) labels.push(r.label);
  }
  console.log(`${write ? `applied ${applied}` : "plan"}${only ? ` (only: ${only.join(", ")})` : ""}: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (labels.length) console.log(`undisclosed clients labelled, e.g.: ${[...new Set(labels)].slice(0, 12).join("; ")}`);
}

/** Reverses every change this script made, from the logged previous values. */
async function undo() {
  const acts = await prisma.reviewAction.findMany({ where: { action: ACTION, previousValue: { not: null } }, orderBy: { createdAt: "desc" } });
  let n = 0;
  for (const act of acts) {
    const b = JSON.parse(act.previousValue!);
    await prisma.$transaction(async tx => {
      await tx.canonicalMarketEvent.update({ where: { id: act.eventId }, data: { publicationStatus: b.publicationStatus, reviewReason: b.reviewReason, humanReviewRequired: b.humanReviewRequired,
        eventStatus: b.eventStatus, canonicalTitle: b.canonicalTitle, counterpartyRaw: b.counterpartyRaw, industry: b.industry, geography: b.geography,
        ...(b.analystInsight !== undefined ? { analystInsight: b.analystInsight } : {}) } });
      if (b.contractDetails) await tx.contractDetails.update({ where: { canonicalEventId: act.eventId }, data: b.contractDetails });
      if (b.maDetails) await tx.maDetails.update({ where: { canonicalEventId: act.eventId }, data: b.maDetails });
      if (b.partnershipDetails) await tx.partnershipDetails.update({ where: { canonicalEventId: act.eventId }, data: b.partnershipDetails });
      await tx.reviewAction.update({ where: { id: act.id }, data: { previousValue: null, newValue: `undone:${act.newValue}` } });
    });
    n++;
  }
  console.log(`undone: ${n}`);
}

async function main() {
  if (process.argv.includes("--undo")) await undo();
  else if (process.argv.includes("--run")) { await runBatch(Number(arg("--budget", "0"))); await apply(process.argv.includes("--apply"), ONLY); }
  else if (process.argv.includes("--plan")) await apply(false, ONLY);
  else return pilot();
  await prisma.$disconnect();
  process.exit(0);
}

if (process.argv[1]?.endsWith("review-reread.ts")) main();
