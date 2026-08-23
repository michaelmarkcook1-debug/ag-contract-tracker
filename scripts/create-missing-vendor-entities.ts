/**
 * Create Entity records for tracked vendors that don't have one yet.
 * Pure reference-data creation — no LLM calls, no imports, no cost.
 * Without an Entity a tracked vendor's events cannot be attributed, so they
 * are invisible to vendor filters and to any tracked-vendor scoping.
 */
import { prisma } from "../src/lib/db";
import { TRACKED_VENDORS } from "../src/lib/ingestion/sources";

const REGIONS: Record<string, string[]> = {
  Netcompany: ["Europe"], Serco: ["UK", "Global"], Maximus: ["North America"],
  Endava: ["Europe", "Global"], Globant: ["Latin America", "Global"],
  Softtek: ["Latin America"], Thoughtworks: ["Global"], TaskUs: ["Global"],
  HGS: ["Global", "Asia"], iQor: ["Global"], Startek: ["Global"],
  Transcom: ["Europe"], Arvato: ["Europe"], Alight: ["North America"],
  Persistent: ["Global", "Asia"], "L&T Technology Services": ["Asia", "Global"],
};
const slugify = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const apply = process.argv.includes("--apply");
  const existing = await prisma.entity.findMany({
    where: { OR: TRACKED_VENDORS.map(n => ({ canonicalName: { equals: n, mode: "insensitive" as const } })) },
    select: { canonicalName: true },
  });
  const have = new Set(existing.map(e => e.canonicalName.toLowerCase()));
  const missing = TRACKED_VENDORS.filter(v => !have.has(v.toLowerCase()));
  console.log(`tracked: ${TRACKED_VENDORS.length} | existing: ${have.size} | missing: ${missing.length}`);
  if (!missing.length) { await prisma.$disconnect(); return; }
  console.log(missing.map(m => `  ${m} -> ${slugify(m)}`).join("\n"));
  if (!apply) { console.log("\n(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }

  let created = 0;
  for (const name of missing) {
    const slug = slugify(name);
    try {
      const clash = await prisma.entity.findUnique({ where: { slug } });
      if (clash) { console.log(`  ! slug "${slug}" taken by "${clash.canonicalName}" — skipped`); continue; }
      await prisma.entity.create({
        data: {
          canonicalName: name, displayName: name, slug, entityType: "vendor",
          regions: JSON.stringify(REGIONS[name] ?? ["Global"]), isActive: true,
        },
      });
      created++;
      console.log(`  ✓ ${name}`);
    } catch (e) { console.log(`  ✗ ${name}: ${String(e).slice(0, 90)}`); }
  }
  console.log(`\ncreated ${created} entities`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
