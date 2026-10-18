import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MAX_IDS = 1000;
type Action = "approve" | "reject" | "undo";

// POST /api/events/review — approve, reject or undo many queued events in one call.
// approve/reject only change rows still in needs_review, so a stale client
// cannot re-publish something already rejected; undo only returns rows a
// reviewer moved (published/excluded) to the queue. Every change is logged to
// ReviewAction exactly like the single-event PATCH.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { ids?: unknown; action?: unknown; note?: unknown };
  const action: Action | null = body.action === "approve" || body.action === "reject" || body.action === "undo" ? body.action : null;
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string"))] : [];
  if (!action || ids.length === 0) return NextResponse.json({ error: "Expected { ids: string[], action: 'approve' | 'reject' | 'undo' }" }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `At most ${MAX_IDS} ids per call` }, { status: 400 });
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

  const changed = await prisma.$transaction(async tx => {
    const from = action === "undo" ? ["published", "excluded_noise"] : ["needs_review"];
    const rows = await tx.canonicalMarketEvent.findMany({ where: { id: { in: ids }, publicationStatus: { in: from } }, select: { id: true, publicationStatus: true } });
    if (rows.length === 0) return [];
    const to = action === "approve" ? "published" : action === "reject" ? "excluded_noise" : "needs_review";
    await tx.canonicalMarketEvent.updateMany({
      where: { id: { in: rows.map(r => r.id) } },
      data: { publicationStatus: to, humanReviewRequired: to === "needs_review" },
    });
    await tx.reviewAction.createMany({
      data: rows.map(r => ({ eventId: r.id, action, reviewerNote: note, previousValue: r.publicationStatus, newValue: to })),
    });
    return rows.map(r => r.id);
  });

  return NextResponse.json({ success: true, changed, skipped: ids.filter(id => !changed.includes(id)) });
}
