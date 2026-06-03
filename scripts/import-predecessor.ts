/**
 * Re-process predecessor's scraped articles through Claude Haiku
 * Filters to in-scope + identified vendor → ~1,597 records
 * Feeds each through the existing LLM extraction pipeline
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env" });
import { readFileSync } from "fs";
import crypto from "crypto";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";
import { extractArticle, ruleBasedExtract } from "../src/lib/ingestion/classifier";
import type { RawArticle } from "../src/lib/ingestion/crawler";

const PRED_PATH = "/Users/michaelcook/Documents/Dev Projects/byson/b-yson-training-nextjs-branded/data/contracts.json";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set — run `vercel env pull .env.local --yes`");
const adapter = new PrismaNeon({ connectionString });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter } as any);

interface PredRecord {
  id: string; title: string; body?: string; articleUrl?: string;
  scopeStatus?: string; isNoise?: boolean;
  serviceProvider?: string; canonicalProvider?: string;
  clientName?: string; clientIndustry?: string;
  contractStartDate?: string; contractEndDate?: string;
  tcvUsd?: number; tcvEstimated?: boolean;
  geography?: string; source?: string;
  informationType?: string;
}

function hashArticle(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function resolveVendorId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const e = await prisma.entity.findFirst({
    where: {
      OR: [
        { canonicalName: name },
        { aliases: { some: { alias: name } } },
      ],
    },
    select: { id: true },
  });
  return e?.id ?? null;
}

async function main() {
  console.log("Loading predecessor contracts.json...");
  const raw = JSON.parse(readFileSync(PRED_PATH, "utf-8")) as { contracts: PredRecord[] };
  const all = raw.contracts;
  console.log(`  ${all.length.toLocaleString()} total records`);

  // Filter: in-scope + identified vendor + non-noise + has article URL or body
  const filtered = all.filter(c => {
    const inScope = c.scopeStatus === "in_scope" || c.scopeStatus === "In Scope";
    if (!inScope) return false;
    if (c.isNoise) return false;
    const hasVendor = c.serviceProvider && !["Unknown", "Unknown Provider", null, ""].includes(c.serviceProvider);
    if (!hasVendor) return false;
    if (!c.title || c.title.length < 15) return false;
    return true;
  });
  console.log(`  ${filtered.length.toLocaleString()} after filtering`);

  // Skip URLs already in SourceEvent
  const existingUrls = new Set(
    (await prisma.sourceEvent.findMany({ select: { sourceUrl: true } }))
      .map(s => s.sourceUrl)
  );
  console.log(`  ${existingUrls.size.toLocaleString()} URLs already in SourceEvent`);

  const toProcess = filtered.filter(c => {
    const sourceUrl = c.articleUrl || `predecessor://${c.id}`;
    return !existingUrls.has(sourceUrl);
  });
  console.log(`  ${toProcess.length.toLocaleString()} new records to process`);

  const useLlm = !!process.env.ANTHROPIC_API_KEY;
  console.log(`  LLM extraction: ${useLlm ? "enabled (Claude Haiku)" : "DISABLED (no API key — using rules)"}`);

  // Create an ingestion run record
  const run = await prisma.ingestionRun.create({
    data: { runType: "predecessor_import", sourceFilter: "predecessor" },
  });

  const stats = { processed: 0, published: 0, queued: 0, excluded: 0, errors: 0 };
  const CONCURRENCY = 10;        // parallel LLM workers
  const PROGRESS_EVERY = 50;
  const startTime = Date.now();

  // Process one record: extract via LLM and persist
  async function processOne(c: PredRecord): Promise<void> {
    try {
      const sourceUrl = c.articleUrl || `predecessor://${c.id}`;
      const article: RawArticle = {
        title: c.title.slice(0, 300),
        url: sourceUrl,
        publishedAt: c.contractStartDate ?? null,
        snippet: (c.body || c.title).slice(0, 1500),
        sourceId: "predecessor-import",
        provider: c.canonicalProvider || c.serviceProvider || "Unknown",
        sourceType: c.source?.includes("InvestorRelations") ? "investor_relations_release" :
                    c.source?.includes("press") ? "vendor_press_release" : "wire_service",
      };

      // In-flight URL dedup
      const existing = await prisma.sourceEvent.findUnique({
        where: { sourceUrl }, select: { id: true },
      });
      if (existing) { stats.excluded++; return; }

      const result = useLlm ? await extractArticle(article) : ruleBasedExtract(article);

      if (result.family === "EXCLUDED") { stats.excluded++; return; }

      const isHighConfidence = result.confidenceScore >= 0.72 && result.extractionMethod === "llm";
      const publicationStatus = isHighConfidence ? "published" : "needs_review";
      const vendorId = await resolveVendorId(result.vendorRaw);

      await prisma.$transaction(async (tx) => {
        const sourceEvent = await tx.sourceEvent.create({
          data: {
            sourceUrl,
            rawTextHash: hashArticle(sourceUrl),
            sourceTitle: article.title,
            sourceName: article.provider,
            sourceType: article.sourceType,
            publicationDate: article.publishedAt ? new Date(article.publishedAt) : null,
            rawText: article.snippet,
            extractedFamily: result.family,
            extractionConfidence: result.confidenceScore,
            processingStatus: "extracted",
            ingestionRunId: run.id,
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
            originalArticleUrl: sourceUrl,
            primaryEntityId: vendorId,
            sourceEvents: { connect: { id: sourceEvent.id } },
          },
        });

        if (result.family === "CONTRACT") {
          await tx.contractDetails.create({
            data: {
              canonicalEventId: event.id,
              vendorId: vendorId ?? undefined,
              vendorRaw: result.vendorRaw,
              vendorConfidence: vendorId ? 0.9 : 0.6,
              clientRaw: result.clientRaw,
              clientConfidence: 0.5,
              contractEventType: result.eventType,
              tcvCommittedUsd: result.tcvUsd && !result.tcvIsEstimate ? result.tcvUsd : null,
              tcvEstimateMidUsd: result.tcvUsd && result.tcvIsEstimate ? result.tcvUsd : null,
              tcvBasis: result.tcvUsd ? (result.tcvIsEstimate ? "model_estimated" : "official_disclosed") : "undisclosed",
              tcvIsEstimate: result.tcvIsEstimate,
              contractLengthMonths: result.contractLengthMonths,
              primaryMacroServiceLine: result.primaryMacroServiceLine,
              scopeSummary: article.snippet?.slice(0, 500),
              platformsUsed: "[]",
              clientServiceCoverageLocation: JSON.stringify(result.geography),
              secondaryMacroServiceLines: "[]",
              secondaryMicroServiceLines: "[]",
            },
          });
        }
      });

      if (publicationStatus === "published") stats.published++; else stats.queued++;
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 5) console.error(`  Error on ${c.id}:`, (err as Error).message);
    }
  }

  // Run with bounded concurrency
  async function runBatch() {
    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= toProcess.length) return;
        await processOne(toProcess[idx]);
        stats.processed++;
        if (stats.processed % PROGRESS_EVERY === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = stats.processed / elapsed;
          const eta = rate > 0 ? ((toProcess.length - stats.processed) / rate / 60).toFixed(1) : "?";
          console.log(`  ${stats.processed}/${toProcess.length} | pub:${stats.published} queued:${stats.queued} excl:${stats.excluded} err:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`);
          await prisma.ingestionRun.update({
            where: { id: run.id },
            data: {
              articlesFound: stats.processed,
              eventsExtracted: stats.published + stats.queued,
              eventsPublished: stats.published,
              eventsQueued: stats.queued,
            },
          });
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  await runBatch();

  // Final stats
  await prisma.ingestionRun.update({
    where: { id: run.id },
    data: {
      status: stats.errors > toProcess.length * 0.1 ? "partial" : "completed",
      completedAt: new Date(),
      articlesFound: stats.processed,
      articlesDuped: 0,
      eventsExtracted: stats.published + stats.queued,
      eventsPublished: stats.published,
      eventsQueued: stats.queued,
    },
  });

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Import complete in ${totalMin} min:`);
  console.log(`  Processed:    ${stats.processed.toLocaleString()}`);
  console.log(`  Published:    ${stats.published.toLocaleString()}`);
  console.log(`  Queued:       ${stats.queued.toLocaleString()}`);
  console.log(`  Excluded:     ${stats.excluded.toLocaleString()}`);
  console.log(`  Errors:       ${stats.errors.toLocaleString()}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
