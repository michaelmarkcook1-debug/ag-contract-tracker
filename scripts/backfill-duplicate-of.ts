/**
 * Stamps `reviewReason: duplicate_of:<id>` on every excluded_noise event that has no reason recorded, using the
 * DedupDecision rows that excluded it (SAME or merged_deterministic). The kept copy is the other side of the decision,
 * preferring one that is still published; a loser whose counterpart is itself a stamped loser chains to that
 * counterpart's winner. Events with no matching decision are left untouched and counted.
 *
 *   npx tsx scripts/backfill-duplicate-of.ts            dry run
 *   npx tsx scripts/backfill-duplicate-of.ts --apply    write the reasons
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local", override: true });
import { PrismaNeon } from "@prisma/adapter-neon"; import { PrismaClient } from "../src/generated/prisma/client";
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) } as any);
const apply = process.argv.includes("--apply");

async function main() {
  const losers = await prisma.canonicalMarketEvent.findMany({ where: { publicationStatus: "excluded_noise", reviewReason: null }, select: { id: true } });
  const ids = new Set(losers.map((l: any) => l.id));
  console.log(`excluded_noise with no reason: ${ids.size}`);
  const decisions = await prisma.dedupDecision.findMany({ where: { decision: { in: ["SAME", "merged_deterministic"] } }, select: { eventAId: true, eventBId: true, decision: true, confidence: true } });
  const status = new Map<string, { publicationStatus: string; reviewReason: string | null }>();
  const pageIds = [...new Set(decisions.flatMap((d: any) => [d.eventAId, d.eventBId]))];
  for (let i = 0; i < pageIds.length; i += 500) {
    const rows = await prisma.canonicalMarketEvent.findMany({ where: { id: { in: pageIds.slice(i, i + 500) } }, select: { id: true, publicationStatus: true, reviewReason: true } });
    for (const r of rows) status.set(r.id, { publicationStatus: r.publicationStatus, reviewReason: r.reviewReason });
  }
  const winnerOf = new Map<string, string>();
  const chain = (id: string, depth = 0): string => {
    const m = status.get(id)?.reviewReason?.match(/^duplicate_of:(\S+)$/);
    return m && depth < 5 ? chain(m[1], depth + 1) : id;
  };
  for (const d of decisions as any[]) {
    for (const [me, other] of [[d.eventAId, d.eventBId], [d.eventBId, d.eventAId]]) {
      if (!ids.has(me) || winnerOf.has(me)) continue;
      const o = status.get(other);
      if (!o) continue;
      if (o.publicationStatus === "published") winnerOf.set(me, other);
      else if (o.reviewReason?.startsWith("duplicate_of:")) winnerOf.set(me, chain(other));
    }
  }
  // Second pass for losers whose only counterpart is another unstamped loser: pick the counterpart (it becomes the anchor).
  for (const d of decisions as any[]) {
    for (const [me, other] of [[d.eventAId, d.eventBId], [d.eventBId, d.eventAId]]) {
      if (!ids.has(me) || winnerOf.has(me) || !status.has(other)) continue;
      winnerOf.set(me, winnerOf.get(other) ?? other);
    }
  }
  console.log(`winner found for ${winnerOf.size}; no decision found for ${ids.size - winnerOf.size}`);
  if (!apply) { console.log("(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }
  let n = 0;
  for (const [id, keep] of winnerOf) {
    await prisma.canonicalMarketEvent.update({ where: { id }, data: { reviewReason: `duplicate_of:${keep}` } }); n++;
    if (n % 500 === 0) console.log(`  stamped ${n}`);
  }
  console.log(`✓ stamped ${n} events`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
