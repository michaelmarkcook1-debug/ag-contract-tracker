/**
 * Second opinions that never got an answer (the API was unavailable, so the
 * check failed closed and the event was held for review) are asked again.
 *
 * An event the article does support has "event_source_mismatch" removed from
 * its review reasons; with no other reason left it is published, exactly as it
 * would have been had the check answered the first time. Everything else stays
 * in review. Each answer is logged to ReviewAction as a source_check.
 *
 * It does not look for an existing event to merge into (the store does that
 * only at read time), so run the catalogue dedupe afterwards.
 *
 *   npx tsx scripts/recheck-source-checks.ts [--apply]
 *
 * Answers are cached in _scratch/recheck-verdicts.json, so a dry run followed
 * by --apply pays for each check once.
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { checkSource, SOURCE_CHECK_VERSION, type SourceCheck } from "@/lib/ingestion/source-check";

const apply = process.argv.includes("--apply");
const CACHE = "_scratch/recheck-verdicts.json";
const MISMATCH = "event_source_mismatch";
type Verdict = Pick<SourceCheck, "verdict" | "why">;

async function main() {
  const cache: Record<string, Verdict> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const acts = await prisma.reviewAction.findMany({ where: { action: "source_check" }, select: { eventId: true, reviewerNote: true }, orderBy: { createdAt: "asc" } });
  // The latest check on each event decides whether it is still unanswered.
  const latest = new Map<string, string>();
  for (const a of acts) latest.set(a.eventId, a.reviewerNote ?? "");
  const ids = [...latest].filter(([, note]) => note.includes(" UNAVAILABLE:")).map(([id]) => id);

  const events: { id: string; canonicalTitle: string; supportingText: string | null; reviewReason: string | null; sourceEvents: { sourceTitle: string | null; rawText: string | null }[] }[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    events.push(...await prisma.canonicalMarketEvent.findMany({
      where: { id: { in: ids.slice(i, i + 50) }, publicationStatus: "needs_review", reviewReason: { contains: MISMATCH } },
      select: { id: true, canonicalTitle: true, supportingText: true, reviewReason: true, sourceEvents: { select: { sourceTitle: true, rawText: true }, take: 1 } },
    }));
  }
  console.log(`unanswered second opinions: ${ids.length}; still held for that reason: ${events.length}`);

  let cost = 0, down = 0;
  const todo = events.filter(e => !cache[e.id]);
  for (let i = 0; i < todo.length && down < 5; i += 8) {
    const chunk = todo.slice(i, i + 8);
    const res = await Promise.all(chunk.map(e => {
      const src = e.sourceEvents[0];
      if (!src?.rawText) return Promise.resolve<SourceCheck>({ verdict: "UNAVAILABLE", why: "no article text stored", costUsd: 0 });
      let quote: string | null = null;
      try { quote = (JSON.parse(e.supportingText ?? "{}") as { event?: string }).event ?? null; } catch { /* no quote */ }
      return checkSource({ title: e.canonicalTitle, quote }, { title: src.sourceTitle ?? e.canonicalTitle, text: src.rawText });
    }));
    res.forEach((r, k) => {
      cost += r.costUsd;
      if (r.verdict === "UNAVAILABLE" && /^HTTP /.test(r.why)) { down++; return; }
      if (r.verdict !== "UNAVAILABLE") down = 0;
      cache[chunk[k].id] = { verdict: r.verdict, why: r.why };
    });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  }
  if (down >= 5) {
    console.log("stopping: the API is still refusing calls (five in a row). Nothing was changed; run again once it is back.");
    await prisma.$disconnect();
    process.exit(1);
  }

  const tally: Record<string, number> = {};
  let published = 0, stillHeld = 0, answered = 0;
  for (const e of events) {
    const v = cache[e.id];
    if (!v) continue;
    answered++;
    tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
    const rest = (e.reviewReason ?? "").split(",").map(s => s.trim()).filter(s => s && s !== MISMATCH);
    const lifts = v.verdict === "SUPPORTED";
    if (lifts && rest.length === 0) published++; else if (lifts) stillHeld++;
    if (!apply || v.verdict === "UNAVAILABLE") continue;
    await prisma.$transaction(async tx => {
      await tx.reviewAction.create({ data: {
        eventId: e.id, action: "source_check",
        reviewerNote: `${SOURCE_CHECK_VERSION} ${v.verdict}: ${v.why} · asked again`.slice(0, 500),
        previousValue: MISMATCH, newValue: lifts ? "supported" : MISMATCH,
      } });
      if (lifts) await tx.canonicalMarketEvent.update({ where: { id: e.id }, data: rest.length
        ? { reviewReason: rest.join(",") }
        : { reviewReason: null, publicationStatus: "published", humanReviewRequired: false } });
    });
  }
  console.log("answers: " + Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ") + ` · cost $${cost.toFixed(2)}`);
  console.log(`${apply ? "applied" : "dry run"}: ${published} published, ${stillHeld} supported but held for another reason, ${answered - published - stillHeld} stay in review`);
  await prisma.$disconnect();
  process.exit(0);
}
main();
