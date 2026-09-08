/**
 * Article census, and the private/public contract-event census for the 25
 * tracked providers (AI Delivery Mandate §17–§18, and the ARTICLE CENSUS /
 * PRIVATE-SECTOR / PUBLIC-SECTOR sections of the required report).
 *
 * Read-only. Writes a markdown file next to the eval report.
 *
 *   npx tsx scripts/eval/census.ts [--out scripts/eval/census-2026-09-08.md]
 */
import fs from "fs";
import { prisma } from "@/lib/db";

interface Row { k: string; n: number }
const q = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);

(async () => {
  const outArg = process.argv.indexOf("--out");
  const out = outArg > 0 ? process.argv[outArg + 1] : `scripts/eval/census-${new Date().toISOString().slice(0, 10)}.md`;
  const L: string[] = [`# Census — ${new Date().toISOString().slice(0, 16)}Z`, ""];

  const total = await prisma.sourceEvent.count();
  const status = await q<Row>(`SELECT "processingStatus" AS k, COUNT(*)::int AS n FROM "SourceEvent" GROUP BY 1 ORDER BY 2 DESC`);
  const reasons = await q<Row>(`SELECT COALESCE("exclusionReason",'(none)') AS k, COUNT(*)::int AS n FROM "SourceEvent" WHERE "processingStatus"='excluded' GROUP BY 1 ORDER BY 2 DESC LIMIT 25`);
  L.push(`## Article census`, "", `Stored articles: **${total}**`, "", `| processing status | n |`, `|---|---|`, ...status.map(r => `| ${r.k} | ${r.n} |`), "",
    `### Exclusion reasons (top 25)`, "", `| reason | n |`, `|---|---|`, ...reasons.map(r => `| ${r.k} | ${r.n} |`), "");

  const read = await q<Row>(`SELECT COALESCE("articleType",'(not read by the mandate reader)') AS k, COUNT(*)::int AS n FROM "SourceEvent" GROUP BY 1 ORDER BY 2 DESC LIMIT 20`);
  L.push(`### Article type, as read (rows the new reader has processed)`, "", `| article type | n |`, `|---|---|`, ...read.map(r => `| ${r.k} | ${r.n} |`), "");

  const fam = await q<{ family: string; status: string; n: number }>(`SELECT family, "publicationStatus" AS status, COUNT(*)::int AS n FROM "CanonicalMarketEvent" GROUP BY 1,2 ORDER BY 1,3 DESC`);
  L.push(`## Events by family and publication status`, "", `| family | status | n |`, `|---|---|---|`, ...fam.map(r => `| ${r.family} | ${r.status} | ${r.n} |`), "");

  // Contract events per tracked provider, split by buyer sector. Legacy rows
  // carry no buyerSector: they are counted as UNRECORDED, never as UNKNOWN,
  // so an unread backlog can never be mistaken for a reader verdict.
  const prov = await q<{ provider: string; total: number; priv: number; pub: number; soe: number; nonprof: number; unk: number; unrec: number; withvalue: number; tcv: number | null }>(`
    SELECT COALESCE(en."canonicalName", cd."vendorRaw", '(unattributed)') AS provider,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE e."buyerSector"='PRIVATE_SECTOR')::int AS priv,
           COUNT(*) FILTER (WHERE e."buyerSector"='PUBLIC_SECTOR')::int AS pub,
           COUNT(*) FILTER (WHERE e."buyerSector"='STATE_OWNED_OR_MIXED')::int AS soe,
           COUNT(*) FILTER (WHERE e."buyerSector"='NON_PROFIT')::int AS nonprof,
           COUNT(*) FILTER (WHERE e."buyerSector"='UNKNOWN')::int AS unk,
           COUNT(*) FILTER (WHERE e."buyerSector" IS NULL)::int AS unrec,
           COUNT(*) FILTER (WHERE cd."tcvCommittedUsd" IS NOT NULL)::int AS withvalue,
           SUM(cd."tcvCommittedUsd")::bigint AS tcv
    FROM "CanonicalMarketEvent" e
    LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId"=e.id
    LEFT JOIN "Entity" en ON en.id=e."primaryEntityId"
    WHERE e.family='CONTRACT' AND e."publicationStatus"='published'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 40`);
  const m = (v: number | null) => v == null ? "—" : `$${(Number(v) / 1e9).toFixed(2)}bn`;
  L.push(`## Published contract events by provider and buyer sector`, "",
    `\`unrecorded\` = stored before the mandate reader, so no sector was ever recorded. It is not a reader verdict of UNKNOWN.`, "",
    `| provider | events | private | public | state-owned | non-profit | unknown | unrecorded | with a stated value | disclosed TCV |`, `|---|---|---|---|---|---|---|---|---|---|`,
    ...prov.map(r => `| ${r.provider} | ${r.total} | ${r.priv} | ${r.pub} | ${r.soe} | ${r.nonprof} | ${r.unk} | ${r.unrec} | ${r.withvalue} | ${m(r.tcv)} |`), "");

  const sector = await q<Row>(`SELECT COALESCE(e."buyerSector",'(unrecorded)') AS k, COUNT(*)::int AS n FROM "CanonicalMarketEvent" e WHERE e.family='CONTRACT' GROUP BY 1 ORDER BY 2 DESC`);
  const ai = await q<Row>(`SELECT COALESCE(e."aiRelevance",'(unrecorded)') AS k, COUNT(*)::int AS n FROM "CanonicalMarketEvent" e WHERE e.family='CONTRACT' GROUP BY 1 ORDER BY 2 DESC`);
  const cet = await q<Row>(`SELECT COALESCE(e."commercialEventType",'(unrecorded)') AS k, COUNT(*)::int AS n FROM "CanonicalMarketEvent" e WHERE e.family='CONTRACT' GROUP BY 1 ORDER BY 2 DESC`);
  const est = await q<Row>(`SELECT CASE WHEN cd."tcvCommittedUsd" IS NOT NULL THEN 'disclosed value' WHEN cd."tcvEstimateLowUsd" IS NOT NULL THEN 'labelled estimate only' ELSE 'no value' END AS k, COUNT(*)::int AS n FROM "CanonicalMarketEvent" e JOIN "ContractDetails" cd ON cd."canonicalEventId"=e.id WHERE e.family='CONTRACT' GROUP BY 1 ORDER BY 2 DESC`);
  L.push(`## Contract events — mandate dimensions`, "",
    `| buyer sector | n |`, `|---|---|`, ...sector.map(r => `| ${r.k} | ${r.n} |`), "",
    `| AI relevance | n |`, `|---|---|`, ...ai.map(r => `| ${r.k} | ${r.n} |`), "",
    `| commercial event type | n |`, `|---|---|`, ...cet.map(r => `| ${r.k} | ${r.n} |`), "",
    `| value disclosure | n |`, `|---|---|`, ...est.map(r => `| ${r.k} | ${r.n} |`), "");

  const dedup = await q<{ k: string; n: number }>(`
    SELECT 'events with >1 source article' AS k, COUNT(*)::int AS n FROM (SELECT j."A" FROM "_CanonicalMarketEventToSourceEvent" j GROUP BY 1 HAVING COUNT(*)>1) x
    UNION ALL SELECT 'events with exactly 1 source', COUNT(*)::int FROM (SELECT j."A" FROM "_CanonicalMarketEventToSourceEvent" j GROUP BY 1 HAVING COUNT(*)=1) y
    UNION ALL SELECT 'events with no source article', COUNT(*)::int FROM "CanonicalMarketEvent" e WHERE NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j WHERE j."A"=e.id)
    UNION ALL SELECT 'source articles linked to no event (status extracted)', COUNT(*)::int FROM "SourceEvent" s WHERE s."processingStatus"='extracted' AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j WHERE j."B"=s.id)
    UNION ALL SELECT 'events carrying a deterministic canonical identity', COUNT(*)::int FROM "CanonicalMarketEvent" WHERE "canonicalContractEventId" IS NOT NULL`);
  L.push(`## Deduplication state`, "", `| | n |`, `|---|---|`, ...dedup.map(r => `| ${r.k} | ${r.n} |`), "");

  fs.writeFileSync(out, L.join("\n"));
  console.log(L.join("\n"));
  console.log(`\ncensus → ${out}`);
  await prisma.$disconnect();
})();
