import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runPipeline, TOTAL_SOURCES } from "@/lib/ingestion/pipeline";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Sources crawled per fire. Crawling is cheap; the LLM cap is the real limiter,
// so we crawl a wide window but only extract up to `maxExtractions`.
const WINDOW = 15;

// ⏸  SCHEDULE PAUSED (2026-08-22) pending vendor-universe sign-off.
// The endpoint still works when called manually; only the automatic daily
// trigger is switched off, so no unattended run fires against the expanded
// 114-source universe before scope is agreed.
//
// To resume, add this back to vercel.json (Hobby allows at most one run/day):
//   "crons": [{ "path": "/api/cron/ingest", "schedule": "0 7 * * *" }]
// Note vercel.json rejects any key outside its schema — the schedule cannot be
// "commented out" in that file, it has to be removed or restored wholesale.
//
// GET /api/cron/ingest — invoked by Vercel Cron on a schedule.
// Each fire processes one rotating window of sources so that, over successive
// runs, the whole source list is covered. The window advances automatically by
// counting prior "cron" runs — no cursor table needed.
export async function GET(req: NextRequest) {
  // If CRON_SECRET is configured, require it (Vercel Cron sends it as a Bearer
  // token). If it's unset, allow the request so the job works out of the box.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const priorCronRuns = await prisma.ingestionRun.count({ where: { runType: "cron" } });
    const sourceOffset = TOTAL_SOURCES > 0 ? (priorCronRuns * WINDOW) % TOTAL_SOURCES : 0;

    const result = await runPipeline({
      sourceFilter: "all",
      maxSourcesPerRun: WINDOW,
      sourceOffset,
      maxExtractions: 12,
      runType: "cron",
    });

    return NextResponse.json({
      success: true,
      window: { offset: sourceOffset, size: WINDOW, totalSources: TOTAL_SOURCES },
      result: {
        articlesFound: result.articlesFound,
        eventsPublished: result.eventsPublished,
        eventsQueued: result.eventsQueued,
        eventsDeferred: result.eventsDeferred,
        errors: result.errors.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GET /api/cron/ingest", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
