import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry } from "@/lib/ingestion/pipeline";

export const maxDuration = 60;

// POST /api/ingestion — trigger a pipeline run
// Supports sourceOffset for batched processing (avoids 60s Hobby timeout)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      sourceFilter = "all",
      maxSources = 10,
      sourceOffset = 0,
      dryRun = false,
      sync = false,
    } = body as {
      sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
      maxSources?: number;
      sourceOffset?: number;
      dryRun?: boolean;
      sync?: boolean;
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
      maxSourcesPerRun: maxSources > 0 ? maxSources : 10,
      sourceOffset,
      dryRun,
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
