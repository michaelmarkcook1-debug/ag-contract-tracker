import { prisma } from "@/lib/db";
/**
 * Predecessor-import repair: 7,147 SourceEvent rows and 7,183 CanonicalMarketEvent rows
 * were imported without the join row that links them. Each orphan source URL matches
 * exactly one orphan event's originalArticleUrl (verified: 0 ambiguous). Re-link only
 * those exact 1:1 pairs; touch nothing else.
 */
(async () => {
  const apply = process.argv.includes("--apply");
  // Grouped counts, not correlated subqueries — the correlated form times the connection out.
  const pairs = await prisma.$queryRawUnsafe<{ sid: string; eid: string }[]>(`
    WITH os AS (SELECT s.id, s."sourceUrl" AS url FROM "SourceEvent" s
                WHERE s."processingStatus"='extracted' AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j WHERE j."B"=s.id)),
         oe AS (SELECT e.id, e."originalArticleUrl" AS url FROM "CanonicalMarketEvent" e
                WHERE e."originalArticleUrl" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j WHERE j."A"=e.id)),
         su AS (SELECT url FROM os GROUP BY url HAVING COUNT(*)=1),
         eu AS (SELECT url FROM oe GROUP BY url HAVING COUNT(*)=1)
    SELECT os.id AS sid, oe.id AS eid
    FROM os JOIN su ON su.url=os.url JOIN eu ON eu.url=os.url JOIN oe ON oe.url=os.url`);
  console.log(`unambiguous 1:1 pairs: ${pairs.length}${apply ? " — linking" : " (dry run, pass --apply)"}`);
  if (!apply) { await prisma.$disconnect(); return; }
  let n = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    const values = chunk.map(p => `('${p.eid}','${p.sid}')`).join(",");
    n += await prisma.$executeRawUnsafe(`INSERT INTO "_CanonicalMarketEventToSourceEvent" ("A","B") VALUES ${values} ON CONFLICT DO NOTHING`);
    process.stdout.write(`\r linked ${n}`);
  }
  const left = await prisma.sourceEvent.count({ where: { processingStatus: "extracted", canonicalEvents: { none: {} } } });
  const leftE = await prisma.canonicalMarketEvent.count({ where: { sourceEvents: { none: {} } } });
  console.log(`\nlinked ${n}; orphan sources left ${left}; orphan events left ${leftE}`);
  await prisma.$disconnect();
})();
