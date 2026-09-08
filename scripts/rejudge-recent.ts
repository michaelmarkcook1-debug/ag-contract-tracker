/**
 * Re-judge recently stored events with the CURRENT reading prompt.
 *
 * When the prompt learns a new distinction (2026-09-08: case studies and
 * marketing pages are not contract wins), the events stored just before that
 * change were judged by the old prompt. This re-reads each recent event's
 * primary source text with triageArticle and, where the model now says the
 * article is not an event, moves the event to excluded_noise with the
 * article type as the reason — logged as a ReviewAction, reversible.
 * Family changes are reported, not applied.
 *
 *   --since <ISO or hours>   window (default 6 hours)
 *   --only a,b,c             apply only exclusions whose article type is listed
 *   --apply                  write; default is a dry run
 */
import { prisma } from "../src/lib/db";
import { triageArticle } from "../src/lib/ingestion/classifier";

function sinceArg(): Date {
  const i = process.argv.indexOf("--since");
  if (i < 0) return new Date(Date.now() - 6 * 3_600_000);
  const v = process.argv[i + 1];
  return /^\d+$/.test(v) ? new Date(Date.now() - Number(v) * 3_600_000) : new Date(v);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const since = sinceArg();
  const oi = process.argv.indexOf("--only");
  const only = oi >= 0 ? new Set(process.argv[oi + 1].split(",").map(s => `model:${s.trim()}`)) : null;
  console.log(`${apply ? "MODE: APPLY" : "MODE: dry run"} — events created since ${since.toISOString()}\n`);
  const events = await prisma.canonicalMarketEvent.findMany({
    where: { createdAt: { gte: since }, publicationStatus: { in: ["published", "needs_review"] } },
    select: { id: true, family: true, eventType: true, canonicalTitle: true, publicationStatus: true, announcementDate: true,
      primaryEntity: { select: { canonicalName: true } },
      sourceEvents: { select: { sourceTitle: true, rawText: true, sourceType: true, sourceName: true, publisherUrl: true, sourceUrl: true }, orderBy: { createdAt: "asc" }, take: 1 } },
  });
  console.log(`events: ${events.length}`);
  const isBody = (t: string | null) => !!t && t.length > 300 && !t.trimStart().startsWith("<a ");
  const verdicts: { id: string; title: string; from: string; to: string; reason: string; prev: string }[] = [];
  let cost = 0, cursor = 0, unchanged = 0, familyChanged = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < events.length) {
      const e = events[cursor++]; const se = e.sourceEvents[0]; if (!se) continue;
      const t = await triageArticle({ title: se.sourceTitle ?? e.canonicalTitle, url: se.sourceUrl, publishedAt: e.announcementDate?.toISOString() ?? null, snippet: null, sourceId: "rejudge", provider: se.sourceName ?? e.primaryEntity?.canonicalName ?? "", sourceType: se.sourceType, publisherUrl: se.publisherUrl, bodyText: isBody(se.rawText) ? se.rawText!.slice(0, 4000) : null });
      if (!t) continue;
      cost += t.usage.costUsd;
      if (t.family === "EXCLUDED") verdicts.push({ id: e.id, title: e.canonicalTitle, from: e.family, to: "EXCLUDED", reason: t.exclusionReason ?? "model:no_event", prev: e.publicationStatus });
      else if (t.family !== e.family) { familyChanged++; console.log(`  family differs (not applied): ${e.family} → ${t.family} | ${e.canonicalTitle.slice(0, 70)}`); }
      else unchanged++;
    }
  }));
  console.log(`\nre-judged ${events.length} ($${cost.toFixed(2)}): unchanged ${unchanged} · family differs ${familyChanged} · now excluded ${verdicts.length}`);
  const byReason = new Map<string, number>(); verdicts.forEach(v => byReason.set(v.reason, (byReason.get(v.reason) ?? 0) + 1));
  console.log("excluded by reason:", [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "));
  verdicts.slice(0, 20).forEach(v => console.log(`  ${v.reason.padEnd(32)} ${v.from.padEnd(17)} ${v.title.slice(0, 75)}`));
  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }
  const toApply = only ? verdicts.filter(v => only.has(v.reason)) : verdicts;
  if (only) console.log(`applying ${toApply.length} of ${verdicts.length} (types: ${[...only].join(", ")})`);
  for (const v of toApply) {
    await prisma.$transaction([
      prisma.canonicalMarketEvent.update({ where: { id: v.id }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: v.reason } }),
      prisma.reviewAction.create({ data: { eventId: v.id, action: "rejudged_excluded", previousValue: v.prev, newValue: "excluded_noise", reviewerNote: v.reason } }),
    ]);
  }
  console.log(`written: ${toApply.length} events → excluded_noise`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
