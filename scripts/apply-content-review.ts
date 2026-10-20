/**
 * Applies a content review (ExecGenius scripts/review-excluded.ts report) to events excluded without a reason.
 *   event        -> published again, with the reviewed family/type/counterparty where the review corrected them,
 *                   reviewReason "content_review:event"; the other reports in its cluster are stamped duplicate_of it
 *   context      -> stays out of the events feed (it is not an event); reviewReason "content_review:context"
 *                   (its facts are carried into ExecGenius as evidence items by its own apply script)
 *   not_usable   -> stays excluded; reviewReason "content_review:not_usable"
 *   error/none   -> untouched
 * Every write is reversible: nothing is deleted, and the previous status is recorded in a ReviewAction row.
 *
 *   npx tsx scripts/apply-content-review.ts <report.json>            dry run
 *   npx tsx scripts/apply-content-review.ts <report.json> --apply
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local", override: true });
import * as fs from "fs";
import { PrismaNeon } from "@prisma/adapter-neon"; import { PrismaClient } from "../src/generated/prisma/client";
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) } as any);
const apply = process.argv.includes("--apply");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const FAMILIES = new Set(["CONTRACT", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE", "FINANCIAL_RESULTS"]);

async function main() {
  const counts = { event: 0, context: 0, not_usable: 0, duplicates: 0, skipped: 0, recoded: 0 };
  for (const r of report.results as any[]) {
    if (!["event", "context", "not_usable"].includes(r.verdict)) { counts.skipped++; continue; }
    const ev = await prisma.canonicalMarketEvent.findUnique({ where: { id: r.id }, select: { id: true, publicationStatus: true, family: true, eventType: true, reviewReason: true } });
    if (!ev || ev.reviewReason) { counts.skipped++; continue; }           // already handled, or gone
    if (r.verdict === "event") {
      const family = r.family && FAMILIES.has(r.family) ? r.family : ev.family;
      const eventType = r.eventType && typeof r.eventType === "string" ? r.eventType.toLowerCase() : ev.eventType;
      const recoded = family !== ev.family || eventType !== ev.eventType;
      if (recoded) counts.recoded++;
      counts.event++;
      if (apply) {
        await prisma.canonicalMarketEvent.update({ where: { id: ev.id }, data: { publicationStatus: "published", humanReviewRequired: false, family, eventType,
          reviewReason: `content_review:event${recoded ? ` (recoded from ${ev.family}/${ev.eventType})` : ""}`, ...(r.counterparty ? { counterpartyRaw: r.counterparty } : {}) } });
        if (family === "CONTRACT" && r.eventType) await prisma.contractDetails.updateMany({ where: { canonicalEventId: ev.id }, data: { contractEventType: eventType } });
        await prisma.reviewAction.create({ data: { eventId: ev.id, action: "content_review_published", previousValue: ev.publicationStatus, newValue: "published", reviewerNote: `${r.basis}: ${r.reason ?? ""}`.slice(0, 500) } });
        for (const dup of (r.reportIds ?? []).filter((x: string) => x !== ev.id)) {
          await prisma.canonicalMarketEvent.updateMany({ where: { id: dup, reviewReason: null }, data: { reviewReason: `duplicate_of:${ev.id} (content review)` } });
        }
      }
      counts.duplicates += Math.max(0, (r.reportIds ?? []).length - 1);
    } else {
      counts[r.verdict as "context" | "not_usable"]++;
      if (apply) {
        await prisma.canonicalMarketEvent.update({ where: { id: ev.id }, data: { reviewReason: `content_review:${r.verdict}` } });
        await prisma.reviewAction.create({ data: { eventId: ev.id, action: `content_review_${r.verdict}`, previousValue: ev.publicationStatus, newValue: ev.publicationStatus, reviewerNote: `${r.basis}: ${r.reason ?? ""}`.slice(0, 500) } });
        for (const dup of (r.reportIds ?? []).filter((x: string) => x !== ev.id)) {
          await prisma.canonicalMarketEvent.updateMany({ where: { id: dup, reviewReason: null }, data: { reviewReason: `duplicate_of:${ev.id} (content review)` } });
        }
      }
    }
  }
  console.log(`${apply ? "applied" : "dry run"}: republished ${counts.event} events (${counts.recoded} recoded), context ${counts.context}, not usable ${counts.not_usable}, duplicate reports stamped ${counts.duplicates}, skipped ${counts.skipped}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
