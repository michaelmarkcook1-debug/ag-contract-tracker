import { NextRequest, NextResponse } from "next/server";
import { launchBatch } from "@/lib/ingestion/manual-run";

// One batch of an Admin run. Answers at once and does the work afterwards, so
// the batch that started this one is not kept waiting; each batch therefore
// gets its own full time allowance.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { runId?: string; batch?: number };
  if (typeof body.runId !== "string" || typeof body.batch !== "number") return NextResponse.json({ error: "runId and batch are required" }, { status: 400 });
  const claimed = await launchBatch(req.nextUrl.origin, body.runId, body.batch);
  return NextResponse.json({ claimed }, { status: 202 });
}
