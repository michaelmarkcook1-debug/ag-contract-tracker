/**
 * Attribute orphaned contracts to tracked vendor Entity records.
 *
 * Many imported rows carry legal-name variants ("International Business
 * Machines Corp") that never linked to an Entity, so those contracts are
 * invisible to vendor filters and vendor profile pages.
 *
 * This sets contractDetails.vendorId (and the event's primaryEntityId). It does
 * NOT overwrite vendorRaw — the original string is preserved, and the UI already
 * prefers vendor.canonicalName when the link exists.
 *
 * Run with --apply to write; default is a dry run.
 */
import { prisma } from "../src/lib/db";

// Precedence order: when a row names several tracked vendors, the earliest wins.
const PRECEDENCE: { canonical: string; re: RegExp }[] = [
  { canonical: "IBM",                re: /(^|[^A-Za-z0-9])(IBM|International Business Machines)([^A-Za-z0-9]|$)/ },
  { canonical: "TCS",                re: /(^|[^A-Za-z0-9])(TCS|Tata Consultancy)([^A-Za-z0-9]|$)/i },
  { canonical: "Accenture",          re: /(^|[^A-Za-z0-9])Accenture([^A-Za-z0-9]|$)/i },
  { canonical: "NTT DATA",           re: /(^|[^A-Za-z0-9])NTT[ -]?DATA([^A-Za-z0-9]|$)/i },
  { canonical: "CGI",                re: /(^|[^A-Za-z0-9])CGI([^A-Za-z0-9]|$)/ },
  { canonical: "Kyndryl",            re: /(^|[^A-Za-z0-9])Kyndryl([^A-Za-z0-9]|$)/i },
  { canonical: "DXC Technology",     re: /(^|[^A-Za-z0-9])DXC([^A-Za-z0-9]|$)/ },
  { canonical: "TELUS International", re: /(^|[^A-Za-z0-9])TELUS([^A-Za-z0-9]|$)/i },
  { canonical: "Infosys",            re: /(^|[^A-Za-z0-9])Infosys([^A-Za-z0-9]|$)/i },
  { canonical: "Atos",               re: /(^|[^A-Za-z0-9])(Atos|Eviden)([^A-Za-z0-9]|$)/i },
  { canonical: "Capgemini",          re: /(^|[^A-Za-z0-9])Capgemini([^A-Za-z0-9]|$)/i },
  { canonical: "Cognizant",          re: /(^|[^A-Za-z0-9])Cognizant([^A-Za-z0-9]|$)/i },
];

// Different companies that merely contain a tracked vendor's name, plus
// Worldline (spun out of Atos in 2019 and independent since).
const NOT_THE_SAME_COMPANY = [/Hyperlink\s+InfoSystem/i, /Genex\s+Infosys/i, /Worldline/i];

function resolve(vendorRaw: string): string | null {
  if (NOT_THE_SAME_COMPANY.some(re => re.test(vendorRaw))) return null;
  return PRECEDENCE.find(p => p.re.test(vendorRaw))?.canonical ?? null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY (writing)\n" : "MODE: dry run (no writes)\n");

  // Entity ids for the canonical names
  const names = [...new Set(PRECEDENCE.map(p => p.canonical))];
  // Case-insensitive: the stored entity is "NTT Data", the tracked name is
  // "NTT DATA" — an exact match silently skips 66 contracts.
  const entities = await prisma.entity.findMany({
    where: { OR: names.map(n => ({ canonicalName: { equals: n, mode: "insensitive" as const } })) },
    select: { id: true, canonicalName: true, slug: true },
  });
  const byName = new Map<string, { id: string; canonicalName: string; slug: string }>();
  for (const n of names) {
    const hit = entities.find(e => e.canonicalName.toLowerCase() === n.toLowerCase());
    if (hit) byName.set(n, hit);
  }
  const missing = names.filter(n => !byName.has(n));
  if (missing.length) console.log("⚠ no Entity record for:", missing.join(", "), "— those will be skipped\n");

  // Unlinked contract rows only
  const rows = await prisma.contractDetails.findMany({
    where: { vendorId: null, vendorRaw: { not: null } },
    select: { id: true, canonicalEventId: true, vendorRaw: true },
  });
  console.log(`unlinked contract rows: ${rows.length}`);

  const plan = new Map<string, { ids: string[]; eventIds: string[]; samples: Set<string> }>();
  for (const r of rows) {
    const canon = resolve(r.vendorRaw!);
    if (!canon || !byName.has(canon)) continue;
    if (!plan.has(canon)) plan.set(canon, { ids: [], eventIds: [], samples: new Set() });
    const p = plan.get(canon)!;
    p.ids.push(r.id);
    p.eventIds.push(r.canonicalEventId);
    if (p.samples.size < 4) p.samples.add(r.vendorRaw!);
  }

  let total = 0;
  console.log("\nplanned attribution:");
  for (const { canonical } of PRECEDENCE) {
    const p = plan.get(canonical);
    if (!p) continue;
    total += p.ids.length;
    console.log(`  ${canonical.padEnd(20)} ${String(p.ids.length).padStart(4)} contracts  e.g. ${[...p.samples].slice(0,3).map(s=>`"${s}"`).join(", ")}`);
  }
  console.log(`\nTOTAL to attribute: ${total}`);

  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }

  for (const [canonical, p] of plan) {
    const e = byName.get(canonical)!;
    const a = await prisma.contractDetails.updateMany({ where: { id: { in: p.ids } }, data: { vendorId: e.id, vendorConfidence: 0.95 } });
    const b = await prisma.canonicalMarketEvent.updateMany({ where: { id: { in: p.eventIds }, primaryEntityId: null }, data: { primaryEntityId: e.id } });
    console.log(`  ✓ ${canonical.padEnd(20)} linked ${a.count} contracts, ${b.count} events`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
