/**
 * End date = start date + contract length, for every contract event that has
 * a length and a start (a stated start, else the announcement date) but no end
 * date (policy 2026-09-08). Marked:
 *
 *   derived_from_length  — the length was stated and the start is a stated date
 *   estimated            — the length is an estimate, or the start is the
 *                          announcement date standing in for a start date
 *
 * A row with no length gets no end date: nothing is invented. Also fills a
 * missing start date from the event's effective or announcement date, marked
 * "announcement" when that is what it is. Idempotent; no model spend.
 *
 *   npx tsx scripts/impute-end-dates.ts [--apply]
 */
import { prisma } from "@/lib/db";

process.on("unhandledRejection", err => { console.error(`unhandled (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); });

(async () => {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { family: "CONTRACT", publicationStatus: { in: ["published", "needs_review"] }, contractDetails: { is: { contractEndDate: null, contractLengthMonths: { gt: 0 } } } },
    select: { id: true, announcementDate: true, effectiveDate: true, contractDetails: { select: { id: true, contractStartDate: true, contractStartDatePrecision: true, contractLengthMonths: true, contractLengthDescriptor: true } } },
  });
  const counts = { derived: 0, estimated: 0, noStart: 0, startFilled: 0, failed: 0 };
  for (const e of rows) {
    const cd = e.contractDetails!;
    const statedStart = cd.contractStartDate && cd.contractStartDatePrecision === "day" ? cd.contractStartDate : (e.effectiveDate ?? null);
    const start = cd.contractStartDate ?? e.effectiveDate ?? e.announcementDate;
    if (!start) { counts.noStart++; continue; }
    const lengthIsEstimate = !!cd.contractLengthDescriptor && /estimat/i.test(cd.contractLengthDescriptor);
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + Math.round(cd.contractLengthMonths!));
    const precision = statedStart && !lengthIsEstimate ? "derived_from_length" : "estimated";
    counts[precision === "derived_from_length" ? "derived" : "estimated"]++;
    const data: Record<string, unknown> = { contractEndDate: end, contractEndDatePrecision: precision };
    if (!cd.contractStartDate) { data.contractStartDate = start; data.contractStartDatePrecision = e.effectiveDate ? "day" : "announcement"; counts.startFilled++; }
    if (apply) { try { await prisma.contractDetails.update({ where: { id: cd.id }, data }); } catch (err) { counts.failed++; if (counts.failed <= 3) console.log(`  failed ${e.id}: ${err instanceof Error ? err.message.slice(0, 100) : String(err)}`); } }
  }
  console.log(`${rows.length} contracts with a length and no end date: derived_from_length ${counts.derived} · estimated ${counts.estimated} · no start date at all ${counts.noStart} · start filled from announcement/effective date ${counts.startFilled}${apply ? ` · failed ${counts.failed} — written` : " — dry run, pass --apply"}`);
  await prisma.$disconnect();
})();
