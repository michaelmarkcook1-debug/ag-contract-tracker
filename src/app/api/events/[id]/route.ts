import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// PATCH /api/events/[id] — review actions: approve | reject | set_title
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as {
    action: "approve" | "reject" | "set_title";
    value?: string;
    note?: string;
  };

  const event = await prisma.canonicalMarketEvent.findUnique({ where: { id } });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let update: Record<string, unknown> = {};
  let previousValue: string | null = null;
  let newValue: string | null = body.value ?? null;

  if (body.action === "approve") {
    update = { publicationStatus: "published", humanReviewRequired: false };
    previousValue = event.publicationStatus;
    newValue = "published";
  } else if (body.action === "reject") {
    update = { publicationStatus: "excluded_noise", humanReviewRequired: false };
    previousValue = event.publicationStatus;
    newValue = "excluded_noise";
  } else if (body.action === "set_title" && body.value) {
    update = { canonicalTitle: body.value.slice(0, 500) };
    previousValue = event.canonicalTitle;
    newValue = body.value;
  } else {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  const [updated] = await Promise.all([
    prisma.canonicalMarketEvent.update({ where: { id }, data: update }),
    prisma.reviewAction.create({
      data: {
        eventId: id,
        action: body.action,
        reviewerNote: body.note ?? null,
        previousValue,
        newValue,
      },
    }),
  ]);

  return NextResponse.json({ success: true, event: { id: updated.id, publicationStatus: updated.publicationStatus, canonicalTitle: updated.canonicalTitle } });
}
