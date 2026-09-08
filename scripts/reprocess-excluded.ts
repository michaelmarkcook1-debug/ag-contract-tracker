/**
 * Re-run stored exclusion rows that the CURRENT rules would admit.
 *
 * After a rule change (2026-09-08: noise rules yield to transaction headlines,
 * vendor-feed verbs widened) the articles the old rules dropped are still in
 * the store as SourceEvent rows with processingStatus "excluded". This rebuilds
 * them as articles from those rows — no crawl — and runs the normal pipeline
 * (body retrieval, triage, dedup, gate, store) with reprocessExcluded on, so a
 * re-admitted article replaces its exclusion row.
 *
 *   default   rows excluded by RULES that the current rules now pass
 *   --model   also rows excluded by the MODEL whose title carries contract words
 *             (the independent re-judgement found ~6% of those are events)
 *   --dry     list what would be re-run, no model calls
 */
import { prisma } from "../src/lib/db";
import { runPipeline } from "../src/lib/ingestion/pipeline";
import { isRelevantArticle, mentionsTrackedVendor } from "../src/lib/ingestion/sources";
import type { RawArticle } from "../src/lib/ingestion/crawler";

const SIGNAL = /\b(contract|awarded|award of|deal|agreement|selected|selects|signs|signed|wins|win\b|secures|renews|renewal|extends|extension|mandate)\b/i;

async function main() {
  const dry = process.argv.includes("--dry");
  const includeModel = process.argv.includes("--model");
  const rows = await prisma.sourceEvent.findMany({
    where: { processingStatus: "excluded", exclusionReason: { startsWith: includeModel ? "" : "rules:" } },
    select: { sourceUrl: true, sourceTitle: true, sourceName: true, sourceType: true, publicationDate: true, rawText: true, publisherUrl: true, exclusionReason: true },
  });
  const isBody = (t: string | null) => !!t && t.length > 300 && !t.trimStart().startsWith("<a ");
  const articles: RawArticle[] = [];
  for (const r of rows) {
    if (!r.sourceTitle) continue;
    const reason = r.exclusionReason ?? "";
    const provider = r.sourceName ?? "Market Wide";
    const verdict = isRelevantArticle(r.sourceTitle, r.sourceType);
    if (reason.startsWith("rules:")) {
      // The headline regexes are gone from selection; every rule exclusion except the
      // structural vendor gate is re-read by the model.
      if (reason === "rules:vendor_gate" || reason === "rules:no_title") continue;
      if (provider === "Market Wide" && !mentionsTrackedVendor(`${r.sourceTitle} ${r.rawText ?? ""}`)) continue;
    } else if (!(SIGNAL.test(r.sourceTitle) && verdict.relevant)) continue;
    articles.push({
      title: r.sourceTitle, url: r.sourceUrl, publishedAt: r.publicationDate?.toISOString() ?? null,
      snippet: null, sourceId: "reprocess", provider, sourceType: r.sourceType,
      publisherUrl: r.publisherUrl, bodyText: isBody(r.rawText) ? r.rawText : null,
    });
  }
  console.log(`excluded rows: ${rows.length} · admitted by the current rules: ${articles.length}`);
  articles.slice(0, 12).forEach(a => console.log(`  [${a.provider}] ${a.title.slice(0, 100)}`));
  if (dry || articles.length === 0) { await prisma.$disconnect(); return; }

  const p = await runPipeline({ articles, reprocessExcluded: true, maxArticleAgeDays: 0, maxExtractions: 2000, concurrency: 6, timeBudgetMs: 20 * 60_000, runType: "manual" });
  console.log(`\nreprocessed: triaged ${p.articlesTriaged} · model-excluded ${p.articlesExcluded} · published ${p.eventsPublished} · review ${p.eventsQueued} · merged ${p.articlesMerged} · $${p.usage.costUsd.toFixed(3)}${p.errors.length ? ` · errors ${p.errors.length}` : ""}`);
  p.errors.slice(0, 3).forEach(e => console.log("  ", e.slice(0, 160)));
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
