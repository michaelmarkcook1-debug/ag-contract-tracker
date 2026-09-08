import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry, ROUTE_TIME_BUDGET_MS } from "@/lib/ingestion/pipeline";

// Fluid Compute allows 300s. The pipeline's model budget (ROUTE_TIME_BUDGET_MS)
// plus a ≤30s crawl and one in-flight 20s call stays inside it. The previous
// 60s ceiling, with a default of 12 model calls per batch, is why sweeps
// looked at ~2% of their candidates.
export const maxDuration = 300;

// POST /api/ingestion — trigger a pipeline run
// Supports sourceOffset/maxSources for batched processing from the Admin UI.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      sourceFilter = "all",
      maxSources = 30,
      sourceOffset = 0,
      dryRun = false,
      sync = false,
      maxExtractions = 400,
      concurrency = 4,
      maxArticleAgeDays,
    } = body as {
      sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
      maxSources?: number;
      sourceOffset?: number;
      dryRun?: boolean;
      sync?: boolean;
      maxExtractions?: number;
      concurrency?: number;
      maxArticleAgeDays?: number;
    };

    // Registry sync is opt-in only (POST {sync:true}). It does 100+ DB writes
    // and is NOT needed to crawl — the pipeline reads sources from code. Running
    // it on every batch was burning the serverless time budget before any
    // sources were crawled.
    if (sync) {
      try { await syncSourceRegistry(); } catch { /* tolerate */ }
    }

    const result = await runPipeline({
      sourceFilter,
      maxSourcesPerRun: maxSources > 0 ? maxSources : 30,
      sourceOffset,
      dryRun,
      maxExtractions,
      concurrency,
      timeBudgetMs: ROUTE_TIME_BUDGET_MS,
      ...(maxArticleAgeDays !== undefined ? { maxArticleAgeDays } : {}),
    });

    return NextResponse.json({ success: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("POST /api/ingestion", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// GET /api/ingestion — check API key status and source counts
export async function GET() {
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const { prisma } = await import("@/lib/db");
  const [sourcesTotal, lastRun, needsReview] = await Promise.all([
    prisma.sourceRegistryItem.count({ where: { isActive: true } }),
    prisma.ingestionRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.canonicalMarketEvent.count({ where: { publicationStatus: "needs_review", ...(await (await import("@/lib/data")).trackedEventScope()) } }),
  ]);
  return NextResponse.json({ hasApiKey, sourcesTotal, needsReview, lastRun });
}
