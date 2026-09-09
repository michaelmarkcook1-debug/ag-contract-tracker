/**
 * Data integrity: values that a third party ESTIMATED were imported as if the
 * contract had disclosed them. GlobalData's own text says so — "GlobalData has
 * estimated the value (and duration) of the contract". A third-party estimate
 * is not a stated value (mandate §12; policy 2026-09-08: estimates are labelled).
 *
 * This moves each such figure from the stated field to the estimate fields,
 * basis `third_party_estimated:globaldata`, and logs the change per event so
 * it can be reversed. Rows where GlobalData estimated only the DURATION keep
 * their stated value. Nothing else is touched; no publication status changes.
 *
 *   npx tsx scripts/tcv/relabel-third-party-estimates.ts [--apply]
 */
import { prisma } from "@/lib/db";

const VALUE_ESTIMATED = /globaldata has estimated the (value|value and duration|duration and value)( of the contract)?/i;

(async () => {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.$queryRawUnsafe<{ eventId: string; cdId: string; tcv: number; basis: string; title: string; text: string }[]>(`
    SELECT DISTINCT e.id AS "eventId", cd.id AS "cdId", cd."tcvCommittedUsd" AS tcv, cd."tcvBasis" AS basis, e."canonicalTitle" AS title,
           substring(se."rawText" from '(?i)globaldata has estimated the [a-z ]+') AS text
    FROM "CanonicalMarketEvent" e JOIN "ContractDetails" cd ON cd."canonicalEventId"=e.id
    JOIN "_CanonicalMarketEventToSourceEvent" j ON j."A"=e.id JOIN "SourceEvent" se ON se.id=j."B"
    WHERE e.family='CONTRACT' AND cd."tcvCommittedUsd">0 AND COALESCE(cd."tcvIsEstimate",false)=false
      AND se."rawText" ~* 'globaldata has estimated the'`);
  const valueEst = rows.filter(r => VALUE_ESTIMATED.test(r.text ?? ""));
  const durationOnly = rows.length - valueEst.length;
  console.log(`${rows.length} 'disclosed' contract values carry GlobalData estimate wording: ${valueEst.length} estimate the VALUE (relabelled), ${durationOnly} estimate only the duration (value stays stated)${apply ? "" : " — dry run"}`);
  if (!apply) { await prisma.$disconnect(); return; }
  let n = 0;
  for (const r of valueEst) {
    await prisma.$transaction([
      prisma.contractDetails.update({ where: { id: r.cdId }, data: {
        tcvCommittedUsd: null, tcvIsEstimate: true, tcvBasis: "third_party_estimated:globaldata", tcvConfidence: "third_party_estimate",
        tcvEstimateLowUsd: r.tcv, tcvEstimateMidUsd: r.tcv, tcvEstimateHighUsd: r.tcv,
        tcvEstimateMethod: "third_party", tcvEstimateVersion: "globaldata", tcvEstimateExplanation: "GlobalData's own text: the value was estimated by GlobalData, not disclosed by the parties",
      } }),
      prisma.reviewAction.create({ data: { eventId: r.eventId, action: "value_relabelled_third_party_estimate", previousValue: `${r.basis}:${Math.round(r.tcv)}`, newValue: `third_party_estimated:globaldata:${Math.round(r.tcv)}`, reviewerNote: "2026-09-08: source text says GlobalData estimated the value; moved from the stated field to the labelled estimate fields" } }),
    ]);
    if (++n % 500 === 0) process.stdout.write(`\r relabelled ${n}`);
  }
  console.log(`\nrelabelled ${n}`);
  await prisma.$disconnect();
})();
