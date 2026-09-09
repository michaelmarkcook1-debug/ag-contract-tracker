import { NextRequest, NextResponse } from "next/server";
import { runPipeline, SCHEDULED_SWEEP } from "@/lib/ingestion/pipeline";
import { getIngestionMode } from "@/lib/ingestion/mode";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET /api/cron/ingest — invoked by Vercel Cron once a day (vercel.json).
//
// One fire crawls EVERY source. With date-bounded Google News queries and
// persisted exclusions, a day's worth of new candidates is a few hundred
// articles, which fits the 300s Fluid Compute ceiling at concurrency 4. The
// previous design rotated a 15-source window with 12 model calls per fire,
// which needed ten days to visit each source once and looked at almost
// nothing. Anything deferred by the budget is picked up on the next fire.
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
    // While the historical backfill is reinforcing the store, the cron stands
    // down so spend stays with the backfill; it resumes when the runner flips
    // the mode to "current" after the agreed number of good runs.
    const mode = await getIngestionMode();
    if (mode.mode === "historical") {
      return NextResponse.json({ success: true, skipped: "historical phase", note: mode.note, since: mode.since });
    }
    const result = await runPipeline({ ...SCHEDULED_SWEEP, runType: "cron" });
    return NextResponse.json({
      success: true,
      result: {
        articlesFound: result.articlesFound,
        articlesRelevant: result.articlesRelevant,
        articlesTriaged: result.articlesTriaged,
        articlesExcluded: result.articlesExcluded,
        eventsPublished: result.eventsPublished,
        eventsQueued: result.eventsQueued,
        eventsDeferred: result.eventsDeferred,
        costUsd: result.usage.costUsd,
        errors: result.errors.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GET /api/cron/ingest", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
