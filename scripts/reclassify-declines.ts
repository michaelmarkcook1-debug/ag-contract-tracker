/**
 * Second pass over the TCV backfill's model rationales (TCV_CACHE): rows the
 * model declined to value because they are NOT contract awards.
 *
 *   partnership / collaboration wording → family PARTNERSHIP (technology_alliance);
 *                                         the ContractDetails row is removed after
 *                                         its counterparty is copied to the event
 *   thought leadership, blogs, internal initiatives, facility openings,
 *   event support                       → excluded_noise, reviewReason set
 *   terminations, insourcing, umbrella vehicles, thin awards → left as they are
 *                                         (real events that carry no value)
 *
 * Every change is logged as a ReviewAction (family_changed / reclassified_not_contract).
 * Dry run by default; --apply writes.
 */
import fs from "fs";
import { prisma } from "../src/lib/db";

const CACHE_PATH = process.env.TCV_CACHE ?? "/tmp/tcv-estimates.json";
const PARTNER = /partnership|collaborat|alliance|co-?develop|jointly develop|teams? up|technology partner|partners? (?:with|to)\b/i;
const NOISE = /thought[- ]leadership|blog|internal (?:employee|training)|training initiative|employee (?:training|initiative)|facilit(?:y|ies)|delivery cent|(?:opens?|opening) (?:a )?(?:new )?(?:office|centre|center)|event (?:support|sponsorship|announcement)|sponsor|sports? (?:event|championship)|dancesport|elibertadores|product (?:launch|announcement)|awareness/i;

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Record<string, { low: number | null; rationale: string | null }>;
  const ids = Object.entries(cache).filter(([, v]) => !v.low && v.rationale).map(([id]) => id);
  const rows = await prisma.contractDetails.findMany({
    where: { id: { in: ids }, canonicalEvent: { is: { publicationStatus: { in: ["published", "needs_review"] } } } },
    select: { id: true, clientRaw: true, canonicalEvent: { select: { id: true, family: true, canonicalTitle: true, publicationStatus: true, counterpartyRaw: true } } },
  });
  const toPartner: typeof rows = [], toNoise: typeof rows = [], leave: typeof rows = [];
  for (const r of rows) {
    const why = cache[r.id].rationale ?? "";
    if (PARTNER.test(why) || PARTNER.test(r.canonicalEvent.canonicalTitle)) toPartner.push(r);
    else if (NOISE.test(why) || NOISE.test(r.canonicalEvent.canonicalTitle)) toNoise.push(r);
    else leave.push(r);
  }
  console.log(`still-declined rows: ${rows.length} → partnership ${toPartner.length} · noise ${toNoise.length} · leave ${leave.length}`);
  console.log("→ PARTNERSHIP:"); toPartner.slice(0, 8).forEach(r => console.log(`   ${r.canonicalEvent.canonicalTitle.slice(0, 70)}`));
  console.log("→ excluded_noise:"); toNoise.slice(0, 8).forEach(r => console.log(`   ${r.canonicalEvent.canonicalTitle.slice(0, 70)}`));
  console.log("→ left (terminations, frameworks, thin awards):"); leave.slice(0, 6).forEach(r => console.log(`   ${r.canonicalEvent.canonicalTitle.slice(0, 70)}`));
  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }
  for (const r of toPartner) {
    await prisma.$transaction([
      prisma.canonicalMarketEvent.update({ where: { id: r.canonicalEvent.id }, data: { family: "PARTNERSHIP", eventType: "technology_alliance", counterpartyRaw: r.canonicalEvent.counterpartyRaw ?? r.clientRaw ?? undefined } }),
      prisma.contractDetails.delete({ where: { id: r.id } }),
      prisma.reviewAction.create({ data: { eventId: r.canonicalEvent.id, action: "family_changed", previousValue: "CONTRACT", newValue: "PARTNERSHIP", reviewerNote: (cache[r.id].rationale ?? "").slice(0, 200) } }),
    ]);
  }
  for (const r of toNoise) {
    await prisma.$transaction([
      prisma.canonicalMarketEvent.update({ where: { id: r.canonicalEvent.id }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: `not_a_contract: ${(cache[r.id].rationale ?? "").slice(0, 120)}` } }),
      prisma.reviewAction.create({ data: { eventId: r.canonicalEvent.id, action: "reclassified_not_contract", previousValue: r.canonicalEvent.publicationStatus, newValue: "excluded_noise", reviewerNote: (cache[r.id].rationale ?? "").slice(0, 200) } }),
    ]);
  }
  console.log(`written: ${toPartner.length} → PARTNERSHIP, ${toNoise.length} → excluded_noise`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
