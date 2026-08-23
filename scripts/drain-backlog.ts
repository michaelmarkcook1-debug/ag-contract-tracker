/**
 * Drain the relevant-article backlog with bounded concurrency and hard caps.
 * Stops at whichever comes first: article target, cost cap, or time cap.
 */
import { prisma } from "../src/lib/db";
import { runPipeline, TOTAL_SOURCES } from "../src/lib/ingestion/pipeline";

const TARGET_ARTICLES = Number(process.env.TARGET ?? 2500);
const COST_CAP_USD    = Number(process.env.COST_CAP ?? 12);
const TIME_CAP_MS     = Number(process.env.TIME_CAP_MIN ?? 55) * 60_000;
const WINDOW          = 15;
const CONCURRENCY     = 6;
const PER_BATCH_MS    = 8 * 60_000;
const MAX_ROUNDS      = 12;

async function main() {
  const t0 = Date.now();
  const batches = Math.ceil(TOTAL_SOURCES / WINDOW);
  let processed = 0, cost = 0, pub = 0, rev = 0, extracted = 0, errors = 0, inTok = 0, outTok = 0;
  console.log(`target=${TARGET_ARTICLES} articles | cost cap $${COST_CAP_USD} | time cap ${TIME_CAP_MS/60000}min | concurrency=${CONCURRENCY}\n`);

  outer:
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let roundProcessed = 0;
    for (let b = 0; b < batches; b++) {
      if (processed >= TARGET_ARTICLES) { console.log(`\n✔ target ${TARGET_ARTICLES} reached`); break outer; }
      if (cost >= COST_CAP_USD)        { console.log(`\n⛔ cost cap $${COST_CAP_USD}`); break outer; }
      if (Date.now() - t0 > TIME_CAP_MS){ console.log("\n⛔ time cap"); break outer; }

      const remaining = TARGET_ARTICLES - processed;
      const p = await runPipeline({
        sourceFilter: "all", maxSourcesPerRun: WINDOW, sourceOffset: b * WINDOW,
        maxExtractions: Math.min(400, remaining),
        timeBudgetMs: PER_BATCH_MS, concurrency: CONCURRENCY, runType: "manual",
      });
      processed += p.articlesProcessed; roundProcessed += p.articlesProcessed;
      cost += p.usage.costUsd; inTok += p.usage.inputTokens; outTok += p.usage.outputTokens;
      pub += p.eventsPublished; rev += p.eventsQueued; extracted += p.eventsExtracted;
      errors += p.errors.length;
      console.log(`r${round} b${b+1}/${batches}: processed=${String(p.articlesProcessed).padStart(4)} events=${String(p.eventsPublished+p.eventsQueued).padStart(3)} defer=${String(p.eventsDeferred).padStart(4)} $${p.usage.costUsd.toFixed(3)} | total ${processed}/${TARGET_ARTICLES} $${cost.toFixed(2)}`);
    }
    console.log(`— round ${round}: ${roundProcessed} articles —`);
    if (roundProcessed === 0) { console.log("backlog empty; stopping"); break; }
  }

  console.log(`\n════ DRAIN COMPLETE in ${((Date.now()-t0)/60000).toFixed(1)} min ════`);
  console.log(`articles processed through LLM: ${processed}`);
  console.log(`events created: ${extracted} (published ${pub} / review ${rev})`);
  console.log(`excluded as out-of-scope:       ${processed - extracted}`);
  console.log(`errors: ${errors} | tokens ${inTok} in / ${outTok} out`);
  console.log(`COST: $${cost.toFixed(4)}  (avg $${(cost/Math.max(1,processed)).toFixed(5)}/article)`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,400)); process.exit(1); });
