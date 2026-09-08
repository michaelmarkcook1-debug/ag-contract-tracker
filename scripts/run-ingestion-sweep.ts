/**
 * Controlled multi-pass ingestion sweep with hard cost + time caps.
 * Repeats passes over every source until the backlog drains or a cap is hit,
 * because each pipeline invocation defers work beyond its per-run LLM budget.
 */
import { prisma } from "../src/lib/db";
import { runPipeline, TOTAL_SOURCES } from "../src/lib/ingestion/pipeline";

const WINDOW = 30;             // sources per batch
const MAX_EXTRACTIONS = 400;   // per batch
const CONCURRENCY = 6;
const BATCH_BUDGET_MS = 8 * 60 * 1000;   // model budget per batch (measured after the crawl)
const COST_CAP_USD = Number(process.env.COST_CAP ?? 8);
const TIME_CAP_MS = Number(process.env.TIME_CAP_MIN ?? 40) * 60 * 1000;
const MAX_ROUNDS = 3;
// REPROCESS_EXCLUDED=1 re-evaluates URLs previously recorded as excluded — for a
// sweep right after a rule change, so articles the old rules dropped get another look.
const REPROCESS = process.env.REPROCESS_EXCLUDED === "1";

// A dropped Neon WebSocket surfaces as an unhandled ErrorEvent outside any
// awaited chain and would kill the whole run; log it and carry on — the
// pipeline retries nothing, but the next batch reconnects.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (continuing):", String(reason).slice(0, 200));
});

async function main() {
  const t0 = Date.now();
  const batches = Math.ceil(TOTAL_SOURCES / WINDOW);
  let cost = 0, inTok = 0, outTok = 0;
  let found = 0, duped = 0, irrelevant = 0, extracted = 0, published = 0, queued = 0, deferred = 0, errors = 0;
  const runIds: string[] = [];

  console.log(`sources=${TOTAL_SOURCES} batches/round=${batches} caps: $${COST_CAP_USD}, ${TIME_CAP_MS/60000}min, ${MAX_ROUNDS} rounds\n`);

  outer:
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let roundNew = 0;
    for (let b = 0; b < batches; b++) {
      if (cost >= COST_CAP_USD) { console.log(`\n⛔ cost cap $${COST_CAP_USD} reached`); break outer; }
      if (Date.now() - t0 > TIME_CAP_MS) { console.log("\n⛔ time cap reached"); break outer; }
      const offset = b * WINDOW;
      const p = await runPipeline({
        sourceFilter: "all", maxSourcesPerRun: WINDOW, sourceOffset: offset,
        maxExtractions: MAX_EXTRACTIONS, concurrency: CONCURRENCY, timeBudgetMs: BATCH_BUDGET_MS,
        reprocessExcluded: REPROCESS, runType: "manual",
      });
      cost += p.usage.costUsd; inTok += p.usage.inputTokens; outTok += p.usage.outputTokens;
      found += p.articlesFound; duped += p.articlesDuped; irrelevant += p.articlesIrrelevant;
      extracted += p.eventsExtracted; published += p.eventsPublished; queued += p.eventsQueued;
      deferred = p.eventsDeferred; errors += p.errors.length;
      roundNew += p.eventsPublished + p.eventsQueued;
      console.log(`r${round} b${b+1}/${batches} src${offset}-${offset+WINDOW}: found=${String(p.articlesFound).padStart(4)} stale=${String(p.articlesStale).padStart(4)} relevant=${String(p.articlesRelevant).padStart(4)} triaged=${String(p.articlesTriaged).padStart(4)} excl=${String(p.articlesExcluded).padStart(3)} new=${String(p.eventsPublished+p.eventsQueued).padStart(3)} (pub ${p.eventsPublished}/rev ${p.eventsQueued}) defer=${String(p.eventsDeferred).padStart(4)} $${p.usage.costUsd.toFixed(4)} cum=$${cost.toFixed(3)}`);
    }
    console.log(`— round ${round} added ${roundNew} events —`);
    if (roundNew === 0) { console.log("no new events; stopping early"); break; }
  }

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n════ SWEEP COMPLETE in ${mins} min ════`);
  console.log(`articles found (incl. re-crawls): ${found}`);
  console.log(`already stored (skipped, free):   ${duped}`);
  console.log(`dropped by relevance/vendor gate: ${irrelevant}`);
  console.log(`extracted:                        ${extracted}`);
  console.log(`  published:                      ${published}`);
  console.log(`  queued for review:              ${queued}`);
  console.log(`still deferred (last batch):      ${deferred}`);
  console.log(`errors:                           ${errors}`);
  console.log(`tokens: ${inTok} in / ${outTok} out`);
  console.log(`COST: $${cost.toFixed(4)}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
