/**
 * Collapse vendor aliases / full legal names onto the single canonical name.
 *
 * Resolves every still-unlinked contract row against the tracked universe using
 * the same matcher the ingestion gate uses (TRACKED_VENDORS + VENDOR_ALIASES),
 * then:
 *   1. links contractDetails.vendorId + event.primaryEntityId, and
 *   2. records the variant in EntityAlias, so resolveVendorId() matches it
 *      directly on every future run instead of relying on this backfill.
 *
 * vendorRaw is never overwritten — the original string is preserved and the UI
 * already prefers vendor.canonicalName once the link exists.
 *
 * Run with --apply to write; default is a dry run.
 */
import { prisma } from "../src/lib/db";
import { TRACKED_VENDORS, matchTrackedVendorPreferring } from "../src/lib/ingestion/sources";

// Multi-vendor strings resolve to the first match in this order.
const PRIORITY = ["IBM", "TCS", "Accenture", "NTT DATA", "CGI", "Kyndryl",
  "DXC Technology", "TELUS International", "Infosys", "Atos", "Capgemini", "Cognizant"];
const ORDER = [...PRIORITY, ...TRACKED_VENDORS.filter(v => !PRIORITY.includes(v))];

// Different companies that merely contain a tracked name.
const NOT_THE_SAME_COMPANY = [/Hyperlink\s+InfoSystem/i, /Genex\s+Infosys/i, /Worldline/i];

function resolve(raw: string): string | null {
  if (NOT_THE_SAME_COMPANY.some(re => re.test(raw))) return null;
  return matchTrackedVendorPreferring(raw, ORDER);
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");

  const ents = await prisma.entity.findMany({
    where: { OR: TRACKED_VENDORS.map(n => ({ canonicalName: { equals: n, mode: "insensitive" as const } })) },
    select: { id: true, canonicalName: true },
  });
  const byName = new Map<string, string>();
  for (const n of TRACKED_VENDORS) {
    const hit = ents.find(e => e.canonicalName.toLowerCase() === n.toLowerCase());
    if (hit) byName.set(n, hit.id);
  }
  const noEntity = TRACKED_VENDORS.filter(n => !byName.has(n));
  if (noEntity.length) console.log(`⚠ ${noEntity.length} tracked vendors have no Entity record (run npm run backfill:vendors):\n   ${noEntity.join(", ")}\n`);

  const rows = await prisma.contractDetails.findMany({
    where: { vendorId: null, vendorRaw: { not: null } },
    select: { id: true, canonicalEventId: true, vendorRaw: true },
  });
  console.log(`still-unlinked contract rows: ${rows.length}`);

  const plan = new Map<string, { ids: string[]; eventIds: string[]; variants: Set<string> }>();
  let unresolved = 0;
  for (const r of rows) {
    const canon = resolve(r.vendorRaw!);
    if (!canon || !byName.has(canon)) { unresolved++; continue; }
    if (!plan.has(canon)) plan.set(canon, { ids: [], eventIds: [], variants: new Set() });
    const p = plan.get(canon)!;
    p.ids.push(r.id); p.eventIds.push(r.canonicalEventId); p.variants.add(r.vendorRaw!);
  }

  let total = 0, variantCount = 0;
  console.log("\nresolvable to canonical names:");
  for (const [canon, p] of [...plan].sort((a, b) => b[1].ids.length - a[1].ids.length)) {
    total += p.ids.length; variantCount += p.variants.size;
    console.log(`  ${canon.padEnd(22)} ${String(p.ids.length).padStart(4)} contracts via ${String(p.variants.size).padStart(3)} variants  e.g. ${[...p.variants].slice(0,2).map(v=>`"${v}"`).join(", ")}`);
  }
  console.log(`\nTOTAL resolvable: ${total} contracts, ${variantCount} distinct alias strings`);
  console.log(`Not a tracked vendor (left alone): ${unresolved}`);

  if (!apply) { console.log("\n(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }

  let aliasesAdded = 0;
  for (const [canon, p] of plan) {
    const entityId = byName.get(canon)!;
    const a = await prisma.contractDetails.updateMany({ where: { id: { in: p.ids } }, data: { vendorId: entityId, vendorConfidence: 0.9 } });
    const b = await prisma.canonicalMarketEvent.updateMany({ where: { id: { in: p.eventIds }, primaryEntityId: null }, data: { primaryEntityId: entityId } });
    for (const variant of p.variants) {
      if (variant.toLowerCase() === canon.toLowerCase()) continue;
      try {
        await prisma.entityAlias.upsert({
          where: { entityId_alias: { entityId, alias: variant } },
          update: {}, create: { entityId, alias: variant },
        });
        aliasesAdded++;
      } catch { /* alias already recorded */ }
    }
    console.log(`  ✓ ${canon.padEnd(22)} ${a.count} contracts, ${b.count} events, ${p.variants.size} aliases`);
  }
  console.log(`\nEntityAlias rows added: ${aliasesAdded} — future runs resolve these directly.`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
