import { NextRequest, NextResponse } from "next/server";
import { runPipeline, syncSourceRegistry } from "@/lib/ingestion/pipeline";

// GET /api/cron — triggered by external cron (launchd, crontab, Vercel Cron)
// Protected by CRON_SECRET environment variable
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
    const result = await runPipeline({
      sourceFilter: "all",
      maxSourcesPerRun: 15,
      dryRun: false,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
