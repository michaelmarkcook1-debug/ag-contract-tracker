import { NextRequest, NextResponse } from "next/server";
import { endRun, getRun, launchBatch, pauseRun, resumeRun, startRun } from "@/lib/ingestion/manual-run";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET /api/ingestion/run — where the Admin run stands. A run whose batch has
// gone quiet (a function died) is picked up again here, so looking at the page
// is enough to un-stick it.
export async function GET(req: NextRequest) {
  let status = await getRun();
  if (status.run && status.stalled && status.command === "run") {
    const { run, kick } = await resumeRun();
    if (run && kick) await launchBatch(req.nextUrl.origin, run.id, run.batch);
    status = await getRun();
  }
  return NextResponse.json(status);
}

// POST /api/ingestion/run — { action: "start" | "pause" | "resume" | "end", sourceFilter?, maxSources?, dryRun? }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { action?: string; sourceFilter?: string; maxSources?: number; dryRun?: boolean };
  const origin = req.nextUrl.origin;
  try {
    if (body.action === "start") {
      const filter = ["vendor_rss", "investor_relations", "wire", "procurement", "all"].includes(body.sourceFilter ?? "") ? body.sourceFilter as "all" : "all";
      const limit = typeof body.maxSources === "number" && body.maxSources > 0 ? Math.floor(body.maxSources) : null;
      const { run, started } = await startRun({ sourceFilter: filter, sourceLimit: limit, dryRun: body.dryRun === true });
      if (started) await launchBatch(origin, run.id, run.batch);
      return NextResponse.json({ success: true, started, ...(await getRun()) }, { status: started ? 200 : 409 });
    }
    if (body.action === "pause") { await pauseRun(); return NextResponse.json({ success: true, ...(await getRun()) }); }
    if (body.action === "end") { await endRun(); return NextResponse.json({ success: true, ...(await getRun()) }); }
    if (body.action === "resume") {
      const { run, kick } = await resumeRun();
      if (run && kick) await launchBatch(origin, run.id, run.batch);
      return NextResponse.json({ success: true, ...(await getRun()) });
    }
    return NextResponse.json({ success: false, error: "action must be start, pause, resume or end" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
