import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { runPipeline, syncSourceRegistry } from "@/lib/ingestion/pipeline";

export const maxDuration = 300;

// POST /api/ingestion — trigger a pipeline run
// Returns immediately with a run ID; processing continues via after()
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { sourceFilter = "vendor_rss", maxSources = 0, dryRun = false } = body as {
      sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
      maxSources?: number;
      dryRun?: boolean;
    };

    // Create a run record immediately so the UI can poll it
    const { prisma } = await import("@/lib/db");
    const run = await prisma.ingestionRun.create({
      data: {
        runType: dryRun ? "dry_run" : "manual",
        sourceFilter: sourceFilter ?? null,
        status: "running",
      },
    });

    // Schedule the actual work to run after the response is sent
    after(async () => {
      try {
        // Sync source registry
        try { await syncSourceRegistry(); } catch { /* tolerate */ }

        await runPipeline(
          {
            sourceFilter,
            maxSourcesPerRun: maxSources > 0 ? maxSources : 999,
            dryRun,
          },
          undefined,
          run.id,
        );
      } catch (err) {
        console.error("Pipeline background error:", err);
        // Mark run as failed
        try {
          await prisma.ingestionRun.update({
            where: { id: run.id },
            data: {
              status: "failed",
              completedAt: new Date(),
              errors: JSON.stringify([String(err)]),
            },
          });
        } catch { /* best effort */ }
      }
    });

    return NextResponse.json({
      success: true,
      result: {
        runId: run.id,
        status: "started",
        message: "Pipeline started in background. Poll /api/ingestion for status.",
      },
    });
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
