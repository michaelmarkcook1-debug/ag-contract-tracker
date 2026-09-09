/**
 * Historical backfill — reinforce the store with old articles, in RUNS, and
 * hand over to the cron after the agreed number of good runs (2026-09-08).
 *
 * A RUN is one calendar month across the vendor list (118 vendor-month
 * windows by default), walking backwards from the latest complete month.
 * Google News honours `after:`/`before:` in RSS, so each window is a real
 * date-bounded query; the store's seen-URL check makes re-runs free.
 *
 * A run is GOOD when at most 5% of its windows errored and at most 10% hit
 * the feed's ~100-item cap (a capped window has lost items and should be
 * split). After `--runs` good runs (default 5) the runner sets the ingestion
 * mode to "current", which lets the scheduled cron resume gathering new
 * articles, and stops. While the runner works the mode is "historical" and
 * the cron stands down.
 *
 * NO per-run caps on how much is read. SPEND: a run projected above $7 needs
 * the user's explicit go-ahead; `--max-spend` (default 7) stops the runner
 * when cumulative model spend reaches it and prints the projection.
 * Measured 2026-09-08 on four windows: $0.34 per window, ~20 reads per
 * window, 50 events published from 78 reads.
 *
 * Resumable: data/backfill-history.state.json records every window and run.
 *
 * COHORT. Defaults to the AG programme's 63 providers plus the hyperscalers
 * (AWS, Microsoft, Google Cloud, Oracle) — 67 windows a run. `--cohort all`
 * runs every tracked vendor (118). The daily sweep is unaffected: it always
 * covers all 118.
 *
 *   npx tsx scripts/backfill-history.ts [--runs 5] [--latest 2026-08] [--cohort ag|all] [--vendors "Infosys,Capgemini"] [--concurrency 6] [--max-spend 7] [--dry-run]
 */
import fs from "fs";
import { runPipeline } from "@/lib/ingestion/pipeline";
import { googleNewsBackfillSources, splitGoogleNewsWindow, TRACKED_VENDORS, BACKFILL_COHORT, AG_COHORT_UNTRACKED, GNEWS_ITEM_CAP } from "@/lib/ingestion/sources";
import type { SourceDefinition } from "@/lib/ingestion/sources";
import { crawlSource } from "@/lib/ingestion/crawler";
import { setIngestionMode } from "@/lib/ingestion/mode";
import { prisma } from "@/lib/db";

process.on("unhandledRejection", err => { console.error(`unhandled (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); });

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const STATE = "data/backfill-history.state.json";
const GOOD_MAX_ERROR_SHARE = 0.05, GOOD_MAX_CAP_SHARE = 0.10;

interface WindowResult { found: number; read: number; published: number; merged: number; capped: boolean; errors: number; costUsd: number; at: string }
interface RunResult { month: string; windows: number; read: number; published: number; merged: number; capped: number; errored: number; costUsd: number; good: boolean; at: string }
interface State { done: Record<string, WindowResult>; runs: RunResult[]; goodRuns: number; handedOver?: string }

(async () => {
  const targetRuns = Number(arg("--runs", "5"));
  const now = new Date();
  const latestArg = arg("--latest", new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7));
  // Default cohort: the AG programme's providers plus the hyperscalers
  // (directed 2026-09-09). "--cohort all" runs every tracked vendor.
  const cohort = arg("--cohort", "ag");
  const vendors = process.argv.includes("--vendors")
    ? arg("--vendors", "").split(",").map(s => s.trim()).filter(Boolean)
    : cohort === "all" ? [...TRACKED_VENDORS] : [...BACKFILL_COHORT];
  const concurrency = Number(arg("--concurrency", "6"));
  const dryRun = process.argv.includes("--dry-run");
  const maxSpend = Number(arg("--max-spend", "7"));

  const state: State = fs.existsSync(STATE) ? { runs: [], goodRuns: 0, ...JSON.parse(fs.readFileSync(STATE, "utf8")) } : { done: {}, runs: [], goodRuns: 0 };
  const save = () => { fs.mkdirSync("data", { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); };
  const monthsDone = new Set(state.runs.map(r => r.month));

  // Months to run: walk backwards from --latest, skipping months already run.
  const months: Date[] = [];
  for (let m = new Date(`${latestArg}-01T00:00:00Z`); months.length < targetRuns - state.goodRuns && m.getUTCFullYear() >= 2015; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 1))) {
    if (!monthsDone.has(m.toISOString().slice(0, 7))) months.push(m);
  }
  if (!process.argv.includes("--vendors") && cohort !== "all") console.log(`cohort: AG providers + hyperscalers (${vendors.length} vendors). Not covered by the article pipeline and therefore not backfilled: ${AG_COHORT_UNTRACKED.join(", ")}.`);
  console.log(`${state.goodRuns}/${targetRuns} good runs so far; ${months.length} months queued (${months.map(m => m.toISOString().slice(0, 7)).join(", ")}) × ${vendors.length} vendors${dryRun ? " — dry run: crawl only, no reads, no mode change" : ` — spend cap $${maxSpend}`}`);
  if (!months.length) { console.log("nothing to do"); await prisma.$disconnect(); return; }

  if (!dryRun) await setIngestionMode("historical", `backfill running: ${state.goodRuns}/${targetRuns} good runs`);
  let spend = 0, windowsRun = 0, stopped = false;
  for (const month of months) {
    const label = month.toISOString().slice(0, 7);
    const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const sources: SourceDefinition[] = googleNewsBackfillSources(month, next, vendors);
    const run: RunResult = { month: label, windows: sources.length, read: 0, published: 0, merged: 0, capped: 0, errored: 0, costUsd: 0, good: false, at: new Date().toISOString() };
    console.log(`\n=== run ${state.runs.length + 1}: ${label} — ${sources.length} windows`);
    for (const src of sources) {
      if (!dryRun && spend >= maxSpend) {
        const perWindow = windowsRun ? spend / windowsRun : 0.34;
        const left = sources.length - sources.indexOf(src);
        console.log(`\nSTOPPED at the $${maxSpend} spend cap after ${windowsRun} windows ($${spend.toFixed(2)}, $${perWindow.toFixed(2)}/window). This run has ${left} windows left (≈ $${(perWindow * left).toFixed(0)}); a full run of ${sources.length} windows ≈ $${(perWindow * sources.length).toFixed(0)}. Re-run with --max-spend <figure> once approved; progress is saved.`);
        stopped = true; break;
      }
      if (state.done[src.id]) { const d = state.done[src.id]; run.read += d.read; run.published += d.published; run.merged += d.merged; if (d.capped) run.capped++; if (d.errors) run.errored++; run.costUsd += d.costUsd; continue; }
      const t0 = Date.now();
      if (dryRun) {
        const { articles, error } = await crawlSource(src);
        const capped = articles.length >= GNEWS_ITEM_CAP;
        console.log(`  ${src.name.padEnd(40)} ${error ? `ERROR ${error.slice(0, 60)}` : `${articles.length} items${capped ? " (AT CAP — split the window)" : ""}`}`);
        if (capped) { const halves = splitGoogleNewsWindow(src); if (halves) { sources.splice(sources.indexOf(src) + 1, 0, ...halves); console.log(`    ↳ split into ${halves.length} sub-windows`); } else run.capped++; }
        if (error) run.errored++;
        continue;
      }
      const p = await runPipeline({ sources: [src], maxArticleAgeDays: 0, maxExtractions: Number.MAX_SAFE_INTEGER, concurrency, timeBudgetMs: 24 * 3_600_000, runType: "backfill_history" });
      let capped = p.articlesFound >= GNEWS_ITEM_CAP;
      if (capped) {
        // The window lost articles at the feed's cap: split it and read the
        // halves too, so a busy vendor-month is covered rather than truncated.
        const halves = splitGoogleNewsWindow(src);
        if (halves) { sources.splice(sources.indexOf(src) + 1, 0, ...halves); capped = false; console.log(`    ↳ at the ${GNEWS_ITEM_CAP}-item cap — split into ${halves.map(h => h.name.split(" ").pop()).join(" + ")}`); }
      }
      state.done[src.id] = { found: p.articlesFound, read: p.articlesTriaged, published: p.eventsPublished, merged: p.articlesMerged, capped, errors: p.errors.length, costUsd: p.usage.costUsd, at: new Date().toISOString() };
      save();
      run.read += p.articlesTriaged; run.published += p.eventsPublished; run.merged += p.articlesMerged; if (capped) run.capped++; if (p.errors.length) run.errored++; run.costUsd += p.usage.costUsd;
      spend += p.usage.costUsd; windowsRun++;
      console.log(`  ${src.name.padEnd(40)} found ${String(p.articlesFound).padStart(3)} · stored already ${String(p.articlesDuped).padStart(3)} · read ${String(p.articlesTriaged).padStart(3)} · published ${String(p.eventsPublished).padStart(3)} · merged ${String(p.articlesMerged).padStart(3)} · $${p.usage.costUsd.toFixed(2)} · ${((Date.now() - t0) / 1000).toFixed(0)}s${capped ? " · AT CAP" : ""}${p.errors.length ? ` · ${p.errors.length} errors` : ""}`);
    }
    if (stopped) break;
    if (dryRun) { console.log(`  dry run ${label}: ${run.errored} errors, ${run.capped} windows at the cap`); continue; }
    run.good = run.errored / run.windows <= GOOD_MAX_ERROR_SHARE && run.capped / run.windows <= GOOD_MAX_CAP_SHARE;
    if (run.good) state.goodRuns++;
    state.runs.push(run); save();
    console.log(`  run ${label}: read ${run.read} · published ${run.published} · merged ${run.merged} · errored windows ${run.errored} · capped windows ${run.capped} · $${run.costUsd.toFixed(2)} → ${run.good ? "GOOD" : "not good (errors or capped windows over the limit — split capped windows and re-run)"} · ${state.goodRuns}/${targetRuns} good`);
    await setIngestionMode("historical", `backfill running: ${state.goodRuns}/${targetRuns} good runs`);
    if (state.goodRuns >= targetRuns) {
      state.handedOver = new Date().toISOString(); save();
      await setIngestionMode("current", `historical fill complete: ${state.goodRuns} good runs (${state.runs.map(r => r.month).join(", ")}); cron resumes`);
      console.log(`\n${state.goodRuns} good runs — historical fill complete. Ingestion mode set to CURRENT; the scheduled cron gathers new articles from here.`);
      break;
    }
  }
  if (!dryRun && !stopped && state.goodRuns < targetRuns) await setIngestionMode("historical", `backfill paused: ${state.goodRuns}/${targetRuns} good runs`);
  console.log(`\nspend this invocation $${spend.toFixed(2)} over ${windowsRun} windows`);
  await prisma.$disconnect();
  process.exit(0);
})();
