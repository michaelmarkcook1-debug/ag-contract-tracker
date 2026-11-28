import { NextRequest, NextResponse } from "next/server";
import { fetchPendingText } from "@/lib/ingestion/pending-text";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// GET /api/cron/fetch-text — fetch page text for queued articles that have none (no model calls, no cost), so the
// Batch API reader can read them. Runs here because Google News sends UK/EU requests to its consent page; from
// Vercel's US region the publisher links resolve. Each call works for up to ~4 minutes; call again until
// `remaining` is 0.  ?runType=backfill_queue (default) · ?runType=all for every queued article.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const rt = req.nextUrl.searchParams.get("runType") ?? "backfill_queue";
  try {
    const result = await fetchPendingText({ runType: rt === "all" ? undefined : rt, concurrency: 6, deadlineMs: 240_000, retryLocalFailures: true });
    return NextResponse.json({ success: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GET /api/cron/fetch-text", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
