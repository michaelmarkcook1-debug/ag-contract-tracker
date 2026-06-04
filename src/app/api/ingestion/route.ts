import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry } from "@/lib/ingestion/pipeline";

export const maxDuration = 300; // 5 min function timeout

// POST /api/ingestion — trigger a pipeline run
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { sourceFilter = "vendor_rss", maxSources = 0, dryRun = false } = body as {
      sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
      maxSources?: number;
      dryRun?: boolean;
    };

    // Sync source registry (idempotent, tolerates failures on individual sources)
    try {
      await syncSourceRegistry();
    } catch (e) {
      console.warn("syncSourceRegistry partial failure:", e);
    }

    const result = await runPipeline({
      sourceFilter,
      // 0 = all sources (no cap); otherwise respect the caller's limit
      maxSourcesPerRun: maxSources > 0 ? maxSources : 999,
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
