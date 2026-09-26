/**
 * Apply the store's value rule to what is already stored: a contract value is
 * never negative (isContractValue in src/lib/ingestion/store.ts). A negative
 * committed value is a reduction amount — moved to tcvOriginalValue as stated,
 * basis "reduction_amount", committed value emptied, each change logged.
 * Idempotent. Dry run by default.
 *
 *   npx tsx --env-file=.env --env-file=.env.local scripts/sanitise-contract-values.ts [--apply]
 */
import { prisma } from "@/lib/db";
(async () => {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.contractDetails.findMany({ where: { tcvCommittedUsd: { lt: 0 } }, select: { id: true, canonicalEventId: true, tcvCommittedUsd: true, tcvOriginalValue: true, tcvOriginalCurrency: true, tcvBasis: true } });
  console.log(`${rows.length} negative committed values${apply ? " — correcting" : " (dry run; pass --apply)"}`);
  for (const r of rows) {
    console.log(`  ${r.canonicalEventId} ${r.tcvCommittedUsd} (${r.tcvBasis})`);
    if (!apply) continue;
    await prisma.$transaction([
      prisma.contractDetails.update({ where: { id: r.id }, data: { tcvCommittedUsd: null, tcvOriginalValue: r.tcvOriginalValue ?? r.tcvCommittedUsd, tcvOriginalCurrency: r.tcvOriginalCurrency ?? "USD", tcvBasis: "reduction_amount", tcvConfidence: "known" } }),
      prisma.reviewAction.create({ data: { eventId: r.canonicalEventId, action: "negative_value_moved_to_reduction_amount", previousValue: `${r.tcvBasis}:${r.tcvCommittedUsd}`, newValue: "reduction_amount", reviewerNote: "a contract value is never negative; the stated amount is the size of a reduction" } }),
    ]);
  }
  await prisma.$disconnect();
})();
