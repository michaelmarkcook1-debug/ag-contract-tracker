import crypto from "crypto";
import { prisma } from "@/lib/db";
import { ALL_SOURCES, VENDOR_RSS_SOURCES, INVESTOR_RELATIONS_SOURCES, PROCUREMENT_SOURCES, WIRE_SOURCES, GOOGLE_NEWS_SOURCES, isRelevantArticle } from "./sources";
import { crawlSource, RawArticle } from "./crawler";
import { extractArticle, ExtractionResult } from "./classifier";

export interface PipelineOptions {
  sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
  maxSourcesPerRun?: number;
  sourceOffset?: number;
  dryRun?: boolean;
  /** Cap on LLM extractions per invocation — keeps each batch inside the 60s budget. */
  maxExtractions?: number;
}

export interface PipelineProgress {
  phase: "crawling" | "classifying" | "storing" | "done";
  sourcesAvailable: number;
  sourcesProcessed: number;
  sourcesTotal: number;
  articlesFound: number;
  articlesDuped: number;
  articlesIrrelevant: number;
  eventsExtracted: number;
  eventsPublished: number;
  eventsQueued: number;
  eventsDeferred: number;
  currentSource?: string;
  errors: string[];
}

function hashArticle(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function pickSources(filter: PipelineOptions["sourceFilter"]) {
  if (filter === "vendor_rss") return VENDOR_RSS_SOURCES;
  if (filter === "investor_relations") return INVESTOR_RELATIONS_SOURCES;
  if (filter === "procurement") return PROCUREMENT_SOURCES;
  if (filter === "wire") return [...WIRE_SOURCES, ...GOOGLE_NEWS_SOURCES];
  return ALL_SOURCES;
}

async function resolveVendorId(vendorName: string | null): Promise<string | null> {
  if (!vendorName) return null;
  const entity = await prisma.entity.findFirst({
    where: {
      OR: [
        { canonicalName: { equals: vendorName } },
        { aliases: { some: { alias: { equals: vendorName } } } },
      ],
    },
    select: { id: true },
  });
  return entity?.id ?? null;
}

async function storeEvent(article: RawArticle, result: ExtractionResult, runId: string): Promise<"published" | "queued" | "excluded"> {
  if (result.family === "EXCLUDED") return "excluded";

  const now = new Date().toISOString();
  const isHighConfidence = result.confidenceScore >= 0.72 && result.extractionMethod !== "rules";
  const publicationStatus = isHighConfidence ? "published" : "needs_review";

  // Upsert SourceEvent (idempotent by sourceUrl)
  const existing = await prisma.sourceEvent.findUnique({ where: { sourceUrl: article.url } });
  if (existing) return "excluded"; // already processed

  const vendorId = await resolveVendorId(result.vendorRaw);

  await prisma.$transaction(async (tx) => {
    const sourceEvent = await tx.sourceEvent.create({
      data: {
        sourceUrl: article.url,
        rawTextHash: hashArticle(article.url),
        sourceTitle: article.title.slice(0, 300),
        sourceName: article.provider,
        sourceType: article.sourceType,
        publicationDate: article.publishedAt ? new Date(article.publishedAt) : null,
        rawText: article.snippet ?? null,
        extractedFamily: result.family,
        extractionConfidence: result.confidenceScore,
        processingStatus: "extracted",
        ingestionRunId: runId,
      },
    });

    const event = await tx.canonicalMarketEvent.create({
      data: {
        family: result.family,
        eventType: result.eventType,
        canonicalTitle: result.canonicalTitle.slice(0, 500),
        announcementDate: article.publishedAt ? new Date(article.publishedAt) : null,
        announcementDateBasis: "explicit",
        geography: JSON.stringify(result.geography),
        industry: result.industry,
        industryBasis: result.industry ? "classified" : "unavailable",
        confidenceScore: result.confidenceScore,
        commercialRelevanceScore: result.tcvUsd ? Math.min(0.95, 0.6 + result.confidenceScore * 0.35) : result.confidenceScore * 0.8,
        humanReviewRequired: publicationStatus === "needs_review",
        publicationStatus,
        analystInsight: result.analystInsight,
        originalArticleUrl: article.url,
        primaryEntityId: vendorId,
        sourceEvents: { connect: { id: sourceEvent.id } },
      },
    });

    // Store family-specific details
    if (result.family === "CONTRACT") {
      const clientId = await resolveVendorId(result.clientRaw);
      await tx.contractDetails.create({
        data: {
          canonicalEventId: event.id,
          vendorId: vendorId ?? undefined,
          vendorRaw: result.vendorRaw,
          vendorConfidence: vendorId ? 0.9 : 0.6,
          clientRaw: result.clientRaw,
          clientId: clientId ?? undefined,
          clientConfidence: clientId ? 0.85 : 0.5,
          contractEventType: result.eventType,
          tcvCommittedUsd: result.tcvUsd && !result.tcvIsEstimate ? result.tcvUsd : null,
          tcvEstimateMidUsd: result.tcvUsd && result.tcvIsEstimate ? result.tcvUsd : null,
          tcvBasis: result.tcvUsd ? (result.tcvIsEstimate ? "model_estimated" : "official_disclosed") : "undisclosed",
          tcvIsEstimate: result.tcvIsEstimate,
          contractLengthMonths: result.contractLengthMonths,
          primaryMacroServiceLine: result.primaryMacroServiceLine,
          scopeSummary: result.summary ?? article.snippet?.slice(0, 500) ?? null,
          platformsUsed: "[]",
          clientServiceCoverageLocation: JSON.stringify(result.geography),
          secondaryMacroServiceLines: "[]",
          secondaryMicroServiceLines: "[]",
        },
      });
    }
    // Other families: store minimal details (can be enriched in review)
  });

  return publicationStatus === "published" ? "published" : "queued";
}

// ── Sync source registry from definitions ─────────────────────────────────────
// Reconciles the SourceRegistryItem table to exactly match ALL_SOURCES:
// upserts every code-defined source and deactivates anything stale (sources
// removed from code). Runs in parallel chunks so it doesn't stall on a cold DB.
export async function syncSourceRegistry(): Promise<void> {
  const codeUrls = new Set(ALL_SOURCES.map(s => s.url));
  const codeIds = new Set(ALL_SOURCES.map(s => s.id));

  const upsertOne = async (src: (typeof ALL_SOURCES)[number]) => {
    try {
      const existing = await prisma.sourceRegistryItem.findFirst({
        where: { OR: [{ url: src.url }, { id: src.id }] },
      });
      if (existing) {
        await prisma.sourceRegistryItem.update({
          where: { id: existing.id },
          data: { name: src.name, provider: src.provider, url: src.url, sourceType: src.sourceType, tier: src.tier, fetchMethod: src.fetchMethod, isActive: true },
        });
      } else {
        await prisma.sourceRegistryItem.create({
          data: { id: src.id, name: src.name, provider: src.provider, url: src.url, sourceType: src.sourceType, tier: src.tier, fetchMethod: src.fetchMethod, isActive: true },
        });
      }
    } catch {
      // Skip individual source sync failures — don't block the pipeline
    }
  };

  // Upsert in parallel chunks of 20
  for (let i = 0; i < ALL_SOURCES.length; i += 20) {
    await Promise.all(ALL_SOURCES.slice(i, i + 20).map(upsertOne));
  }

  // Deactivate registry rows that no longer exist in code (stale accumulation)
  try {
    const all = await prisma.sourceRegistryItem.findMany({ where: { isActive: true }, select: { id: true, url: true } });
    const staleIds = all.filter(r => !codeUrls.has(r.url) && !codeIds.has(r.id)).map(r => r.id);
    if (staleIds.length) {
      await prisma.sourceRegistryItem.updateMany({ where: { id: { in: staleIds } }, data: { isActive: false } });
    }
  } catch {
    // tolerate
  }
}

// ── Main pipeline run ─────────────────────────────────────────────────────────
export async function runPipeline(
  options: PipelineOptions = {},
  onProgress?: (p: PipelineProgress) => void,
  existingRunId?: string,
): Promise<PipelineProgress> {
  const { sourceFilter = "all", maxSourcesPerRun = 10, sourceOffset = 0, dryRun = false, maxExtractions = 12 } = options;
  const runStart = Date.now();
  // Hard wall-clock budget. Serverless caps the function at 60s and a single
  // in-flight LLM call can run up to its 20s fetch timeout, so we must stop
  // *starting* new calls at 38s (38 + 20 = 58 < 60) to guarantee the run always
  // reaches its final DB write instead of being killed mid-flight.
  const TIME_BUDGET_MS = 38_000;

  // Use existing run record if provided (from after() pattern), otherwise create one
  const run = existingRunId
    ? { id: existingRunId }
    : await prisma.ingestionRun.create({
        data: { runType: dryRun ? "dry_run" : "manual", sourceFilter: sourceFilter ?? null },
      });

  const allPickedSources = pickSources(sourceFilter);
  const sources = allPickedSources.slice(sourceOffset, sourceOffset + maxSourcesPerRun);
  const progress: PipelineProgress = {
    phase: "crawling",
    sourcesAvailable: allPickedSources.length,
    sourcesProcessed: 0,
    sourcesTotal: sources.length,
    articlesFound: 0,
    articlesDuped: 0,
    articlesIrrelevant: 0,
    eventsExtracted: 0,
    eventsPublished: 0,
    eventsQueued: 0,
    eventsDeferred: 0,
    errors: [],
  };

  const allArticles: RawArticle[] = [];

  // Phase 1: Crawl — parallel with concurrency cap
  const CRAWL_CONCURRENCY = 15;
  let crawlCursor = 0;
  async function crawlWorker() {
    while (true) {
      const idx = crawlCursor++;
      if (idx >= sources.length) return;
      const source = sources[idx];
      try {
        const { articles, error } = await crawlSource(source);
        if (error) {
          progress.errors.push(`${source.name}: ${error}`);
          await prisma.sourceRegistryItem.updateMany({
            where: { url: source.url },
            data: { consecutiveErrors: { increment: 1 }, lastError: error, lastCrawledAt: new Date() },
          }).catch(() => {});
        } else {
          allArticles.push(...articles);
          progress.articlesFound += articles.length;
          await prisma.sourceRegistryItem.updateMany({
            where: { url: source.url },
            data: { consecutiveErrors: 0, lastError: null, lastCrawledAt: new Date(), lastItemCount: articles.length, nextDueAt: new Date(Date.now() + source.refreshHours * 3_600_000) },
          }).catch(() => {});
        }
      } catch (err) {
        progress.errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      progress.sourcesProcessed++;
    }
  }
  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, crawlWorker));

  if (dryRun) {
    progress.phase = "done";
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "completed", completedAt: new Date(), articlesFound: progress.articlesFound } });
    return progress;
  }

  // Phase 2: Classify + store
  progress.phase = "classifying";
  onProgress?.(progress);

  // Filter already-seen URLs before expensive LLM calls
  const urls = allArticles.map(a => a.url);
  const existing = await prisma.sourceEvent.findMany({ where: { sourceUrl: { in: urls } }, select: { sourceUrl: true } });
  const seenUrls = new Set(existing.map(e => e.sourceUrl));

  const newArticles = allArticles.filter(a => !seenUrls.has(a.url));
  progress.articlesDuped = allArticles.length - newArticles.length;

  // Cheap relevance pre-filter BEFORE any LLM spend — drops obvious noise
  // (earnings, rankings, opinion pieces) for free via regex.
  const relevantArticles = newArticles.filter(a => isRelevantArticle(a.title, a.sourceType).relevant);
  progress.articlesIrrelevant = newArticles.length - relevantArticles.length;

  // Hard cap on LLM calls so a batch always finishes inside the 60s budget.
  // Articles beyond the cap stay unstored and are re-crawled on the next run.
  let llmCalls = 0;
  for (let i = 0; i < relevantArticles.length; i++) {
    const article = relevantArticles[i];
    if (llmCalls >= maxExtractions || Date.now() - runStart > TIME_BUDGET_MS) {
      progress.eventsDeferred = relevantArticles.length - i;
      break;
    }
    try {
      const result = await extractArticle(article);
      llmCalls++;
      if (result.family === "EXCLUDED") continue;
      progress.eventsExtracted++;
      progress.phase = "storing";

      const outcome = await storeEvent(article, result, run.id);
      if (outcome === "published") progress.eventsPublished++;
      else if (outcome === "queued") progress.eventsQueued++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      progress.errors.push(`Article error (${article.url.slice(0, 60)}): ${msg}`);
    }
    // Small delay between LLM calls
    if (process.env.ANTHROPIC_API_KEY) await new Promise(r => setTimeout(r, 150));
  }

  progress.phase = "done";
  await prisma.ingestionRun.update({
    where: { id: run.id },
    data: {
      status: progress.errors.length > newArticles.length * 0.3 ? "partial" : "completed",
      completedAt: new Date(),
      articlesFound: progress.articlesFound,
      articlesDuped: progress.articlesDuped,
      eventsExtracted: progress.eventsExtracted,
      eventsPublished: progress.eventsPublished,
      eventsQueued: progress.eventsQueued,
      errors: JSON.stringify(progress.errors.slice(0, 20)),
    },
  });

  return progress;
}
