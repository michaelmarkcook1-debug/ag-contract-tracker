import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry, SCHEDULED_SWEEP } from "@/lib/ingestion/pipeline";

export const maxDuration = 300;

// GET /api/cron — triggered by an external scheduler (launchd, crontab).
// Protected by CRON_SECRET when set. Same full sweep as /api/cron/ingest;
// this variant also reconciles the source registry first. It used to call the
// pipeline with no source offset, so a launchd schedule only ever crawled the
// first 15 Google News feeds.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
  }

  try {
    await syncSourceRegistry();
    const result = await runPipeline({ ...SCHEDULED_SWEEP, runType: "cron" });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
