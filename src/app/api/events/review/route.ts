import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { defaultEventType, isValidEventType } from "@/lib/ingestion/classifier";
import { ASSIGNABLE, type Assignable } from "@/lib/review-reasons";

const MAX_IDS = 1000;
type Action = "approve" | "reject" | "undo" | "assign";
const UNCONFIRMED = new Set(["RUMOURED", "OPPORTUNITY", "UNKNOWN"]);

// POST /api/events/review — approve, reject, assign or undo many queued events in one call.
// approve/reject/assign only change rows still in needs_review, so a stale client
// cannot re-publish something already rejected; undo only returns rows a
// reviewer moved to the queue, restoring the type an assign changed. Every
// change is logged to ReviewAction exactly like the single-event PATCH.
//
// assign:
//   an event type  published as that type (the event type within it re-derived when the type changes); a rumour or
//                  tender assigned a type is treated as confirmed (status ANNOUNCED)
//   RUMOUR         published to the Rumours view, type unchanged
//   MENTION        parked: a real event the article only mentions in passing; out of the queue and the Tracker
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { ids?: unknown; action?: unknown; note?: unknown; type?: unknown };
  const action: Action | null = ["approve", "reject", "undo", "assign"].includes(body.action as string) ? body.action as Action : null;
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string"))] : [];
  const type = (ASSIGNABLE as readonly string[]).includes(body.type as string) ? body.type as Assignable : null;
  if (!action || ids.length === 0 || (action === "assign" && !type)) {
    return NextResponse.json({ error: `Expected { ids: string[], action: 'approve' | 'reject' | 'undo' | 'assign', type?: ${ASSIGNABLE.join(" | ")} }` }, { status: 400 });
  }
  if (ids.length > MAX_IDS) return NextResponse.json({ error: `At most ${MAX_IDS} ids per call` }, { status: 400 });
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

  const changed = await prisma.$transaction(async tx => {
    if (action === "assign") return assign(tx, ids, type!, note);
    if (action === "undo") return undo(tx, ids, note);
    const rows = await tx.canonicalMarketEvent.findMany({ where: { id: { in: ids }, publicationStatus: "needs_review" }, select: { id: true, publicationStatus: true } });
    if (rows.length === 0) return [];
    const to = action === "approve" ? "published" : "excluded_noise";
    await tx.canonicalMarketEvent.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { publicationStatus: to, humanReviewRequired: false } });
    await tx.reviewAction.createMany({ data: rows.map(r => ({ eventId: r.id, action, reviewerNote: note, previousValue: r.publicationStatus, newValue: to })) });
    return rows.map(r => r.id);
  }, { timeout: 60_000 });

  return NextResponse.json({ success: true, changed, skipped: ids.filter(id => !changed.includes(id)) });
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function assign(tx: Tx, ids: string[], type: Assignable, note: string | null): Promise<string[]> {
  const rows = await tx.canonicalMarketEvent.findMany({
    where: { id: { in: ids }, publicationStatus: "needs_review" },
    select: { id: true, family: true, eventType: true, eventStatus: true, reviewReason: true, publicationStatus: true, canonicalTitle: true },
  });
  for (const r of rows) {
    let data: Record<string, unknown>;
    if (type === "MENTION") {
      data = { publicationStatus: "parked", humanReviewRequired: false, reviewReason: "mention_only" };
    } else if (type === "RUMOUR") {
      data = { publicationStatus: "published", humanReviewRequired: false, reviewReason: null, eventStatus: "RUMOURED" };
    } else {
      const eventType = type === r.family && isValidEventType(type, r.eventType) ? r.eventType : defaultEventType(type, r.canonicalTitle);
      data = { publicationStatus: "published", humanReviewRequired: false, reviewReason: null, family: type, eventType,
        eventStatus: !r.eventStatus || UNCONFIRMED.has(r.eventStatus.toUpperCase()) ? "ANNOUNCED" : r.eventStatus };
    }
    await tx.canonicalMarketEvent.update({ where: { id: r.id }, data });
  }
  // The previous values are kept so undo can put the event back exactly as it was.
  await tx.reviewAction.createMany({ data: rows.map(r => ({ eventId: r.id, action: "assign", reviewerNote: note,
    previousValue: JSON.stringify({ publicationStatus: r.publicationStatus, family: r.family, eventType: r.eventType, eventStatus: r.eventStatus, reviewReason: r.reviewReason }), newValue: type })) });
  return rows.map(r => r.id);
}

async function undo(tx: Tx, ids: string[], note: string | null): Promise<string[]> {
  const rows = await tx.canonicalMarketEvent.findMany({ where: { id: { in: ids }, publicationStatus: { in: ["published", "excluded_noise", "parked"] } }, select: { id: true, publicationStatus: true } });
  if (rows.length === 0) return [];
  const assigns = await tx.reviewAction.findMany({ where: { eventId: { in: rows.map(r => r.id) }, action: "assign" }, orderBy: { createdAt: "desc" } });
  const lastAssign = new Map<string, string>();
  for (const a of assigns) if (!lastAssign.has(a.eventId) && a.previousValue?.startsWith("{")) lastAssign.set(a.eventId, a.previousValue);
  for (const r of rows) {
    const prev = lastAssign.get(r.id);
    const b = prev ? JSON.parse(prev) as { family: string; eventType: string; eventStatus: string | null; reviewReason: string | null } : null;
    await tx.canonicalMarketEvent.update({ where: { id: r.id }, data: { publicationStatus: "needs_review", humanReviewRequired: true,
      ...(b ? { family: b.family, eventType: b.eventType, eventStatus: b.eventStatus, reviewReason: b.reviewReason } : {}) } });
  }
  await tx.reviewAction.createMany({ data: rows.map(r => ({ eventId: r.id, action: "undo", reviewerNote: note, previousValue: r.publicationStatus, newValue: "needs_review" })) });
  return rows.map(r => r.id);
}
