import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry } from "@/lib/ingestion/pipeline";

// POST /api/ingestion — trigger a pipeline run
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { sourceFilter = "vendor_rss", maxSources = 5, dryRun = false } = body as {
      sourceFilter?: "vendor_rss" | "procurement" | "wire" | "all";
      maxSources?: number;
      dryRun?: boolean;
    };

    // Sync source registry on each run (idempotent)
    await syncSourceRegistry();

    const result = await runPipeline({
      sourceFilter,
      maxSourcesPerRun: Math.min(maxSources, 20),
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
    prisma.canonicalMarketEvent.count({ where: { publicationStatus: "needs_review" } }),
  ]);
  return NextResponse.json({ hasApiKey, sourcesTotal, needsReview, lastRun });
}
