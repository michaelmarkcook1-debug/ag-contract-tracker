import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readableArticleText } from "@/lib/ingestion/article-text";

export const dynamic = "force-dynamic";

// GET /api/events/[id]/article — the full stored text of every article behind an event, for reading in the review
// queue, with the passage the extractor relied on (so it can be highlighted).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await prisma.canonicalMarketEvent.findUnique({
    where: { id },
    select: { supportingText: true, sourceEvents: { select: { id: true, sourceTitle: true, sourceUrl: true, publisherUrl: true, sourceName: true, publicationDate: true, rawText: true }, take: 10 } },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  let quote: string | null = null;
  try { quote = (JSON.parse(event.supportingText ?? "{}") as { event?: string }).event ?? null; } catch { /* no quote */ }
  const sources = event.sourceEvents
    .map(s => ({ id: s.id, title: s.sourceTitle, url: s.publisherUrl ?? s.sourceUrl, publisher: s.sourceName, date: s.publicationDate?.toISOString().slice(0, 10) ?? null, text: readableArticleText(s.rawText) }))
    .sort((a, b) => (b.text?.length ?? 0) - (a.text?.length ?? 0));
  return NextResponse.json({ quote, sources });
}
