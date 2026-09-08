/**
 * Freeze an evaluation set for OLD PIPELINE vs NEW PIPELINE (AI Delivery
 * Mandate §31). Draws a stratified sample of stored articles with their OLD
 * verdicts and writes it to scripts/eval/frozen-set-<date>.json. Run once;
 * the file is the frozen set — do not regenerate it to change the numbers.
 *
 *   npx tsx scripts/eval/build-frozen-set.ts [--out scripts/eval/frozen-set-2026-09-08.json]
 */
import fs from "fs";
import { prisma } from "@/lib/db";

const STRATA: { key: string; sql: string; n: number }[] = [
  { key: "old_excluded_model", n: 70, sql: `s."processingStatus"='excluded' AND s."exclusionReason" LIKE 'model:%'` },
  { key: "old_excluded_rules", n: 20, sql: `s."processingStatus"='excluded' AND s."exclusionReason" LIKE 'rules:%'` },
  { key: "old_contract_published", n: 80, sql: `s."processingStatus"='extracted' AND EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e.family='CONTRACT' AND e."publicationStatus"='published')` },
  { key: "old_contract_noise", n: 30, sql: `s."processingStatus"='extracted' AND EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e.family='CONTRACT' AND e."publicationStatus"='excluded_noise') AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e."publicationStatus"='published')` },
  { key: "old_other_family_published", n: 30, sql: `s."processingStatus"='extracted' AND EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e.family<>'CONTRACT' AND e."publicationStatus"='published') AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e.family='CONTRACT')` },
  { key: "old_needs_review", n: 20, sql: `s."processingStatus"='extracted' AND EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j JOIN "CanonicalMarketEvent" e ON e.id=j."A" WHERE j."B"=s.id AND e."publicationStatus"='needs_review')` },
];

export interface FrozenItem {
  stratum: string;
  sourceEventId: string;
  url: string;
  publisherUrl: string | null;
  title: string;
  provider: string;
  sourceType: string;
  publishedAt: string | null;
  storedText: string | null;
  old: {
    processingStatus: string;
    exclusionReason: string | null;
    events: { id: string; family: string; eventType: string; publicationStatus: string; counterparty: string | null; tcvUsd: number | null; clientRaw: string | null }[];
  };
}

(async () => {
  const outArg = process.argv.indexOf("--out");
  const out = outArg > 0 ? process.argv[outArg + 1] : `scripts/eval/frozen-set-${new Date().toISOString().slice(0, 10)}.json`;
  if (fs.existsSync(out)) { console.error(`${out} exists — the frozen set is not regenerated. Delete it deliberately if you mean to.`); process.exit(1); }
  const items: FrozenItem[] = [];
  const populations: Record<string, number> = {};
  for (const st of STRATA) {
    const pop = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM "SourceEvent" s WHERE s."publicationDate" >= '2025-01-01' AND length(s."rawText") >= 400 AND ${st.sql}`);
    populations[st.key] = pop[0]?.n ?? 0;
    const ids = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT s.id FROM "SourceEvent" s WHERE s."publicationDate" >= '2025-01-01' AND length(s."rawText") >= 400 AND ${st.sql} ORDER BY random() LIMIT ${st.n}`);
    const rows = await prisma.sourceEvent.findMany({
      where: { id: { in: ids.map(i => i.id) } },
      select: { id: true, sourceUrl: true, publisherUrl: true, sourceTitle: true, sourceName: true, sourceType: true, publicationDate: true, rawText: true, processingStatus: true, exclusionReason: true,
        canonicalEvents: { select: { id: true, family: true, eventType: true, publicationStatus: true, counterpartyRaw: true, contractDetails: { select: { tcvCommittedUsd: true, clientRaw: true } } } } },
    });
    for (const r of rows) items.push({
      stratum: st.key, sourceEventId: r.id, url: r.sourceUrl, publisherUrl: r.publisherUrl, title: r.sourceTitle ?? "", provider: r.sourceName ?? "", sourceType: r.sourceType ?? "",
      publishedAt: r.publicationDate?.toISOString() ?? null, storedText: r.rawText,
      old: { processingStatus: r.processingStatus, exclusionReason: r.exclusionReason,
        events: r.canonicalEvents.map(e => ({ id: e.id, family: e.family, eventType: e.eventType, publicationStatus: e.publicationStatus, counterparty: e.counterpartyRaw, tcvUsd: e.contractDetails?.tcvCommittedUsd ?? null, clientRaw: e.contractDetails?.clientRaw ?? null })) },
    });
    console.log(`${st.key}: ${rows.length} sampled of ${populations[st.key]} in population`);
  }
  fs.mkdirSync("scripts/eval", { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ frozenAt: new Date().toISOString(), strata: STRATA.map(s => ({ key: s.key, requested: s.n, population: populations[s.key] })), items }, null, 1));
  console.log(`wrote ${items.length} items → ${out}`);
  await prisma.$disconnect();
})();
