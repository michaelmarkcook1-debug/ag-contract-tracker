import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getIngestionMode } from "@/lib/ingestion/mode";
import { dedupeReviewItems } from "@/lib/ingestion/review-dedupe";
import { loadQueue, askNow, settleEvent, REREAD_ACTION, type Outcome } from "@/lib/ingestion/review-reread";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** New review items handled per run; anything left is picked up by the next run. */
const PER_RUN = 80;
/** No new Opus read starts after this many ms, so the run finishes inside maxDuration. */
const READ_DEADLINE_MS = 220_000;

// GET /api/cron/review — invoked by Vercel Cron after the daily ingest (vercel.json).
//
// Every event the pipeline held for review since the last run goes through two stages, as the owner set them on
// 2026-11-27:
//   1. a Sonnet duplicate check against the published catalogue and the rest of the queue (a duplicate is folded into
//      the record it repeats);
//   2. an Opus read of the full article that discards it, parks it as a passing mention, or categorises it (publish,
//      rumour), fills in the counterparty, codes an unnamed client by country and industry, and writes it up.
// Anything Opus cannot settle with a quote from the article stays in review for a person.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  try {
    const mode = await getIngestionMode();
    if (mode.mode === "historical") return NextResponse.json({ success: true, skipped: "historical phase" });

    // Held in the last week and not yet through this job (every item it handles gets a review_reread entry).
    const since = new Date(Date.now() - 7 * 86_400_000);
    const recent = await prisma.canonicalMarketEvent.findMany({
      where: { publicationStatus: "needs_review", createdAt: { gte: since } },
      select: { id: true }, orderBy: { createdAt: "asc" }, take: 2000,
    });
    const seen = new Set((await prisma.reviewAction.findMany({
      where: { action: REREAD_ACTION, eventId: { in: recent.map(r => r.id) } }, select: { eventId: true },
    })).map(a => a.eventId));
    const ids = recent.map(r => r.id).filter(id => !seen.has(id)).slice(0, PER_RUN);
    if (!ids.length) return NextResponse.json({ success: true, result: { newItems: 0 } });

    // Stage 1: Sonnet duplicate check.
    const dedupe = await dedupeReviewItems(ids, { model: "sonnet", action: "dedup_review" });
    const folded = new Set(dedupe.folded);

    // Stage 2: Opus reads what is left, eight at a time.
    const { items } = await loadQueue(ids.filter(id => !folded.has(id)));
    const withText = new Set(items.map(i => i.id));
    const outcomes: Record<string, number> = {};
    let readCost = 0, reads = 0, failures = 0, next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (;;) {
        if (Date.now() - started > READ_DEADLINE_MS) return;
        const item = items[next++];
        if (!item) return;
        try {
          const answer = await askNow("opus", item);
          reads++; readCost += answer.costUsd;
          const r = await settleEvent(item.id, "opus", answer, { write: true });
          outcomes[r.to] = (outcomes[r.to] ?? 0) + 1;
        } catch (err) {
          failures++;
          console.error("cron/review read", item.id, String(err).slice(0, 200));
        }
      }
    }));
    // Items with no readable article text cannot be read; they are marked so they are not picked up again.
    const noText = ids.filter(id => !folded.has(id) && !withText.has(id));
    if (noText.length) await prisma.reviewAction.createMany({ data: noText.map(eventId => ({ eventId, action: REREAD_ACTION, reviewerNote: "keep: no article text to read", newValue: "needs_review" })) });

    return NextResponse.json({
      success: true,
      result: {
        newItems: ids.length,
        duplicatesFolded: folded.size, duplicateChecks: dedupe.judged, dedupeCostUsd: Number(dedupe.costUsd.toFixed(4)),
        opusReads: reads, outcomes: outcomes as Partial<Record<Outcome, number>>, readCostUsd: Number(readCost.toFixed(4)),
        noArticleText: noText.length, failures, leftForNextRun: Math.max(0, items.length - reads - failures),
        seconds: Math.round((Date.now() - started) / 1000),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("GET /api/cron/review", msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
