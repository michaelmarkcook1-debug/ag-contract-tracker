import { prisma } from "../src/lib/db";
import { trackedEventScope } from "../src/lib/data";

const FAMS = ["CONTRACT", "M_AND_A", "PARTNERSHIP", "FINANCIAL_RESULTS", "ORG_CHANGE", "NEW_OFFERING"];
const SHORT: Record<string,string> = { CONTRACT:"Contract", M_AND_A:"M&A", PARTNERSHIP:"Partner", FINANCIAL_RESULTS:"Financial", ORG_CHANGE:"OrgChg", NEW_OFFERING:"NewOffer" };

async function main() {
  const scope = await trackedEventScope();
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: { in: ["published", "needs_review"] }, ...scope },
    select: { family: true, announcementDate: true, publicationStatus: true },
  });

  const pub: Record<string, Record<string, number>> = {};
  const rev: Record<string, Record<string, number>> = {};
  let noDate = 0;
  for (const r of rows) {
    if (!r.announcementDate) { noDate++; continue; }
    const y = String(r.announcementDate.getUTCFullYear());
    const t = r.publicationStatus === "published" ? pub : rev;
    (t[y] ??= {})[r.family] = ((t[y] ?? {})[r.family] ?? 0) + 1;
  }

  const years = [...new Set([...Object.keys(pub), ...Object.keys(rev)])].sort();
  const hdr = "Year  " + FAMS.map(f => SHORT[f].padStart(9)).join("") + "     TOTAL";
  console.log("PUBLISHED (live in the tracker)");
  console.log(hdr); console.log("-".repeat(hdr.length));
  let gt = 0;
  for (const y of years) {
    const row = pub[y] ?? {};
    const tot = FAMS.reduce((s,f)=>s+(row[f]??0),0); gt += tot;
    if (tot === 0) continue;
    console.log(y.padEnd(6) + FAMS.map(f=>String(row[f]??0).padStart(9)).join("") + String(tot).padStart(10));
  }
  console.log("-".repeat(hdr.length));
  const pubTotals = FAMS.map(f => years.reduce((s,y)=>s+((pub[y]??{})[f]??0),0));
  console.log("ALL   " + pubTotals.map(n=>String(n).padStart(9)).join("") + String(gt).padStart(10));

  console.log("\n\nAWAITING REVIEW (publishable pool)");
  console.log(hdr); console.log("-".repeat(hdr.length));
  let gr = 0;
  for (const y of years) {
    const row = rev[y] ?? {};
    const tot = FAMS.reduce((s,f)=>s+(row[f]??0),0); gr += tot;
    if (tot === 0) continue;
    console.log(y.padEnd(6) + FAMS.map(f=>String(row[f]??0).padStart(9)).join("") + String(tot).padStart(10));
  }
  console.log("-".repeat(hdr.length));
  const revTotals = FAMS.map(f => years.reduce((s,y)=>s+((rev[y]??{})[f]??0),0));
  console.log("ALL   " + revTotals.map(n=>String(n).padStart(9)).join("") + String(gr).padStart(10));

  console.log(`\nmax publishable if the whole queue were approved: ${gt + gr}`);
  if (noDate) console.log(`(events with no announcement date, excluded above: ${noDate})`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,300)); process.exit(1); });
