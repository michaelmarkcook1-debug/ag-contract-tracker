/**
 * For excluded_noise events that still have no reason and no DedupDecision row, finds the published event they
 * duplicate by clustering them with the vendor's published events of the same family (date window, counterparty,
 * weighted title similarity — scripts/lib/dedupe.ts). A match is stamped `duplicate_of:<id> (matched by title)` so the
 * basis is visible; events with no match are left untouched and counted as unexplained.
 *
 *   npx tsx scripts/backfill-duplicate-of-by-title.ts            dry run, per-vendor counts
 *   npx tsx scripts/backfill-duplicate-of-by-title.ts --apply    write the reasons
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local", override: true });
import { PrismaNeon } from "@prisma/adapter-neon"; import { PrismaClient } from "../src/generated/prisma/client";
import { clusterEvents } from "./lib/dedupe";
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) } as any);
const apply = process.argv.includes("--apply");
const sel = { id: true, family: true, announcementDate: true, canonicalTitle: true, originalArticleUrl: true, publicationStatus: true, primaryEntityId: true, counterpartyRaw: true,
  contractDetails: { select: { clientRaw: true, contractEventType: true } } } as const;

async function main() {
  const losers = await prisma.canonicalMarketEvent.findMany({ where: { publicationStatus: "excluded_noise", reviewReason: null, primaryEntityId: { not: null } }, select: sel });
  const byVendor = new Map<string, any[]>();
  for (const l of losers) { const k = l.primaryEntityId!; if (!byVendor.has(k)) byVendor.set(k, []); byVendor.get(k)!.push(l); }
  const ents = await prisma.entity.findMany({ where: { id: { in: [...byVendor.keys()] } }, select: { id: true, slug: true } });
  const slug = new Map(ents.map((e: any) => [e.id, e.slug]));
  let matched = 0, unexplained = 0; const stamps: [string, string][] = [];
  for (const [vid, ls] of byVendor) {
    const pub = await prisma.canonicalMarketEvent.findMany({ where: { primaryEntityId: vid, publicationStatus: "published" }, select: sel });
    const all = [...pub, ...ls].map((e: any) => ({ id: e.id, family: e.family, announcementDate: e.announcementDate ? new Date(e.announcementDate).toISOString() : null,
      canonicalTitle: e.canonicalTitle, originalArticleUrl: e.originalArticleUrl, clientName: e.contractDetails?.clientRaw ?? e.counterpartyRaw ?? null,
      contractEventType: e.contractDetails?.contractEventType ?? null, _pub: e.publicationStatus === "published" }));
    const r = clusterEvents(all, slug.get(vid) ?? "vendor");
    let m = 0, u = 0;
    for (const c of r.clusters) {
      const winner = c.reports.find((x: any) => x._pub);
      for (const x of c.reports as any[]) {
        if (x._pub) continue;
        if (winner) { stamps.push([x.id, winner.id]); m++; } else u++;
      }
    }
    matched += m; unexplained += u;
    console.log(`${(slug.get(vid) ?? vid).padEnd(22)} no-reason ${String(ls.length).padStart(4)}  matched to a published event ${String(m).padStart(4)}  unexplained ${String(u).padStart(4)}`);
  }
  console.log(`\ntotal: matched ${matched}, unexplained ${unexplained}`);
  if (!apply) { console.log("(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }
  let n = 0;
  for (const [id, keep] of stamps) { await prisma.canonicalMarketEvent.update({ where: { id }, data: { reviewReason: `duplicate_of:${keep} (matched by title)` } }); n++; }
  console.log(`✓ stamped ${n}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
