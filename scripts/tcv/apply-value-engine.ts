/**
 * Write a calculated, labelled estimate onto every contract event that has no
 * disclosed value (policy 2026-09-08: every contract carries a value).
 *
 * Routes, most specific first: the BPO rate card when agents are stated, the
 * fitted value model, then the comparables pool. Each estimate records its
 * method, inputs, explanation and version so a reader can check it.
 *
 * WHAT THIS SCRIPT CANNOT DO. It never touches tcvCommittedUsd and never
 * touches publicationStatus — the earlier backfill demoted 91 contracts on an
 * estimator's say-so, and that route no longer exists. Any earlier estimate
 * it replaces is logged in ReviewAction with the previous basis and midpoint.
 *
 * Published events only: a row still in the review queue is not priced until a
 * reader or a person has confirmed it is a contract.
 *
 *   npx tsx scripts/tcv/apply-value-engine.ts [--apply] [--limit N] [--only-missing]
 */
import { prisma } from "@/lib/db";
import { estimateContractValue } from "@/lib/tcv/engine";
import { extractUsersServed, VALUE_MODEL_VERSION } from "@/lib/tcv/value-model";
import card from "@/lib/tcv/bpo-rate-card.json";
const VALUE_MODEL_VERSION_TAG = VALUE_MODEL_VERSION;
const CARD_VERSION_TAG = (card as { version: string }).version;

const money = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${(n / 1e3).toFixed(0)}k`;

// The serverless database driver can reject asynchronously on a dropped socket
// after the awaiting call has already resolved; that must not kill a long pass.
process.on("unhandledRejection", err => { console.error(`unhandled (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); });
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await f(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 700 * (i + 1))); } }
  throw last;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const onlyMissing = process.argv.includes("--only-missing");
  const li = process.argv.indexOf("--limit");
  const limit = li > 0 ? Number(process.argv[li + 1]) : undefined;

  const rows = await prisma.canonicalMarketEvent.findMany({
    // Published events only. A row in the review queue has not yet been confirmed
    // as a contract; pricing it would lend it a credibility it has not earned.
    where: { family: "CONTRACT", publicationStatus: "published", contractDetails: { is: { OR: [{ tcvCommittedUsd: null }, { tcvCommittedUsd: 0 }], ...(onlyMissing ? { tcvEstimateMidUsd: null } : {}) } } },
    select: { id: true, canonicalTitle: true, eventType: true, industry: true, geography: true, announcementDate: true,
      primaryEntity: { select: { canonicalName: true } },
      contractDetails: { select: { id: true, primaryMacroServiceLine: true, contractLengthMonths: true, clientAnonymised: true, tcvBasis: true, tcvEstimateMidUsd: true, tcvEstimateVersion: true, agentCount: true, agentTarget: true, deliveryLocations: true, workType: true, usersServed: true } },
      sourceEvents: { select: { sourceType: true, sourceName: true, rawText: true }, take: 3 } },
    take: limit,
  });
  console.log(`${rows.length} undisclosed contract events${apply ? " — writing estimates" : " (dry run; pass --apply)"}`);

  const titledAmount = rows.filter(r => /[$€£]\s?\d|\d\s?(million|billion|mn|bn|crore|lakh)\b/i.test(r.canonicalTitle)).length;
  console.log(`${titledAmount} of them state an amount in the title that the old extraction never stored — the reader re-read captures those as stated values; the engine does not parse titles`);
  const methods: Record<string, number> = {}; let none = 0, written = 0, skipped = 0; const failures: string[] = [];
  for (const r of rows) {
   try {
    const cd = r.contractDetails!;
    // A third party's estimate (GlobalData) is better evidence than this model — never overwrite it.
    if (cd.tcvBasis?.startsWith("third_party_estimated:")) { skipped++; continue; }
    // already priced by this engine version: leave it (a re-run must be idempotent)
    if (apply && cd.tcvBasis?.startsWith("value_engine_v1") && cd.tcvEstimateVersion && [VALUE_MODEL_VERSION_TAG, CARD_VERSION_TAG].includes(cd.tcvEstimateVersion)) { skipped++; continue; }
    const se = r.sourceEvents.find(s => s.rawText && s.rawText.length >= 400 && !s.rawText.includes("<a href")) ?? r.sourceEvents[0];
    const text = se?.rawText ?? null;
    const est = await estimateContractValue({
      serviceLine: cd.primaryMacroServiceLine, sourceType: se?.sourceType ?? null, sourceName: se?.sourceName ?? null,
      contractLengthMonths: cd.contractLengthMonths, provider: r.primaryEntity?.canonicalName ?? null, industry: r.industry, geography: r.geography,
      eventType: r.eventType, anonymised: !!cd.clientAnonymised, usersServed: cd.usersServed ?? (text ? extractUsersServed(text) : null),
      announcementYear: r.announcementDate?.getFullYear() ?? null, agentCount: cd.agentCount, agentTarget: cd.agentTarget,
      deliveryLocations: cd.deliveryLocations ? JSON.parse(cd.deliveryLocations) as string[] : null, workType: cd.workType, text,
    });
    if (!est) { none++; continue; }
    methods[est.method] = (methods[est.method] ?? 0) + 1;
    if (written < 12) console.log(`  ${est.method.padEnd(13)} ${money(est.lowUsd)}–${money(est.highUsd)} | ${r.canonicalTitle.slice(0, 60)} | ${est.explanation.slice(0, 110)}`);
    if (apply) {
      await retry(() => prisma.$transaction([
        prisma.contractDetails.update({ where: { id: cd.id }, data: {
          tcvEstimateLowUsd: est.lowUsd, tcvEstimateMidUsd: est.midUsd, tcvEstimateHighUsd: est.highUsd,
          tcvBasis: est.basis, tcvIsEstimate: true, tcvConfidence: "estimated",
          tcvEstimateMethod: est.method, tcvEstimateInputs: JSON.stringify(est.inputs), tcvEstimateExplanation: est.explanation, tcvEstimateVersion: est.version,
        } }),
        ...(cd.tcvEstimateMidUsd != null ? [prisma.reviewAction.create({ data: { eventId: r.id, action: "estimate_replaced", previousValue: `${cd.tcvBasis}:${Math.round(cd.tcvEstimateMidUsd)}`, newValue: `${est.basis}:${est.midUsd}`, reviewerNote: est.explanation.slice(0, 300) } })] : []),
      ]));
    }
    written++;
    if (apply && written % 200 === 0) process.stdout.write(`\r written ${written}`);
   } catch (err) { failures.push(`${r.canonicalTitle.slice(0, 60)}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`); }
  }
  console.log(`\nestimated ${written} (${Object.entries(methods).map(([k, v]) => `${k} ${v}`).join(", ")}); nothing to say for ${none}; already at this version ${skipped}; failed ${failures.length}${apply ? " — written" : " — dry run, nothing written"}`);
  failures.slice(0, 5).forEach(f => console.log(`  failed: ${f}`));
  await prisma.$disconnect();
})();
