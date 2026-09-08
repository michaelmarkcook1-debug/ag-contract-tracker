/**
 * Historical rerun over GDELT, one vendor-month at a time.
 *
 *   --from YYYY-MM-DD   start of the window (default: 18 months ago)
 *   --to   YYYY-MM-DD   end of the window   (default: today)
 *   --vendors A,B,C     restrict to these tracked vendors (default: all)
 *   --estimate          crawl + rules only, NO model calls — reports how many
 *                       candidates the window holds and a projected cost
 *   --apply             run the full pipeline (bodies, triage, dedup, gate)
 *   COST_CAP=…          USD ceiling for --apply (default 150)
 *
 * Every vendor-month is a separate pipeline run (runType "backfill") with the
 * age cutoff off, so the same selection, dedup and gate apply as for live
 * ingestion. Articles already stored (including those recorded as excluded)
 * are skipped. GDELT is paced at one request per ~5s (it 429s faster than that).
 */
import { prisma } from "../src/lib/db";
import { runPipeline } from "../src/lib/ingestion/pipeline";
import { gdeltBackfillSources, isRelevantArticle, TRACKED_VENDORS } from "../src/lib/ingestion/sources";
import { crawlSource } from "../src/lib/ingestion/crawler";

// Measured on the 2026-09-06 sweeps: triage with body ≈ $0.0015 (Haiku, cached
// prompt), analysis with body ≈ $0.009 (Sonnet); ~45% of candidates survive
// triage and ~40% of those are CONTRACT/M&A and get analysed.
const UNIT = { triage: 0.0015, analysis: 0.009, keepRate: 0.45, analyseRate: 0.4 };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// A dropped Neon WebSocket surfaces as an unhandled ErrorEvent outside any
// awaited chain and would kill the whole run; log it and carry on — the
// pipeline retries nothing, but the next batch reconnects.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (continuing):", String(reason).slice(0, 200));
});

async function main() {
  const estimate = process.argv.includes("--estimate");
  const apply = process.argv.includes("--apply");
  if (!estimate && !apply) { console.log("pass --estimate or --apply"); return; }
  const to = arg("to") ? new Date(arg("to")!) : new Date();
  const from = arg("from") ? new Date(arg("from")!) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 18, 1));
  const vendors = arg("vendors") ? arg("vendors")!.split(",").map(s => s.trim()).filter(v => (TRACKED_VENDORS as readonly string[]).includes(v)) : TRACKED_VENDORS;
  const COST_CAP = Number(process.env.COST_CAP ?? 150);
  const sources = gdeltBackfillSources(from, to, vendors);
  console.log(`${estimate ? "ESTIMATE" : "APPLY"}: ${vendors.length} vendors × ${sources.length / vendors.length} months = ${sources.length} GDELT requests, ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);

  if (estimate) {
    let found = 0, unique = 0, seen = 0, relevant = 0, errors = 0;
    const urls = new Set<string>();
    for (const [i, src] of sources.entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, 5000));
      try {
        const { articles, error } = await crawlSource(src);
        if (error) { errors++; if (errors <= 5) console.log(`  ${src.name}: ${error}`); continue; }
        found += articles.length;
        const fresh = articles.filter(a => !urls.has(a.url)); fresh.forEach(a => urls.add(a.url));
        unique += fresh.length;
        const stored = fresh.length ? await prisma.sourceEvent.findMany({ where: { sourceUrl: { in: fresh.map(a => a.url) } }, select: { sourceUrl: true } }) : [];
        const storedSet = new Set(stored.map(s => s.sourceUrl)); seen += storedSet.size;
        relevant += fresh.filter(a => !storedSet.has(a.url) && isRelevantArticle(a.title, a.sourceType).relevant).length;
      } catch (err) {
        errors++; if (errors <= 5) console.log(`  ${src.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${sources.length} requests · found ${found} · candidates so far ${relevant}`);
    }
    const analyses = relevant * UNIT.keepRate * UNIT.analyseRate;
    const cost = relevant * UNIT.triage + analyses * UNIT.analysis;
    console.log(`\nfound ${found} · unique ${unique} · already stored ${seen} · candidates ${relevant} · request errors ${errors}`);
    console.log(`projected: ~${Math.round(relevant * UNIT.keepRate)} events kept before dedup, ~${Math.round(analyses)} analyses, ≈ $${cost.toFixed(0)} model spend, ~${Math.round(relevant * 0.6 / 60)} min of page fetches at 6-wide`);
    await prisma.$disconnect();
    return;
  }

  let cost = 0, published = 0, queued = 0, merged = 0, triaged = 0;
  for (const [i, src] of sources.entries()) {
    if (cost >= COST_CAP) { console.log(`⛔ cost cap $${COST_CAP}`); break; }
    if (i > 0) await new Promise(r => setTimeout(r, 5000));
    const p = await runPipeline({
      sources: [src], maxArticleAgeDays: 0, maxExtractions: 2000, concurrency: 6,
      timeBudgetMs: 20 * 60_000, runType: "backfill",
    });
    cost += p.usage.costUsd; published += p.eventsPublished; queued += p.eventsQueued; merged += p.articlesMerged; triaged += p.articlesTriaged;
    console.log(`${src.name.padEnd(40)} found=${String(p.articlesFound).padStart(3)} cand=${String(p.articlesRelevant).padStart(3)} triaged=${String(p.articlesTriaged).padStart(3)} pub=${String(p.eventsPublished).padStart(3)} rev=${String(p.eventsQueued).padStart(3)} merged=${String(p.articlesMerged).padStart(3)} $${p.usage.costUsd.toFixed(3)} cum=$${cost.toFixed(2)}${p.errors.length ? ` errors=${p.errors.length}` : ""}`);
  }
  console.log(`\nBACKFILL: triaged ${triaged} · published ${published} · review ${queued} · merged ${merged} · $${cost.toFixed(2)}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
