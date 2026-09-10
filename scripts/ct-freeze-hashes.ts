/**
 * ContractTracker substantive hashes (AI Delivery Mandate §19).
 *
 * Hashes CONTENT, never operational state. createdAt, updatedAt, heartbeats,
 * run ids, attempt counters and fetch timestamps are all excluded by
 * construction: a refresh that changes nothing substantive must not move a
 * hash, or the downstream dependency mechanism fires on noise.
 *
 *   npx tsx --env-file=.env --env-file=.env.local scripts/ct-freeze-hashes.ts
 */
import crypto from "crypto";
import fs from "fs";
import { prisma } from "@/lib/db";
import { PROMPT_POLICY_VERSION, READER_MODEL, READER_MAX_OUTPUT_TOKENS } from "@/lib/ingestion/reader";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const rows = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);

/** The substantive columns. Anything not here is operational and cannot move a hash. */
const EVENT_COLS = `c.id, c.family, c."eventType", c."canonicalTitle", c."announcementDate", c."announcementDateBasis",
  c."effectiveDate", c.geography, c.industry, c."canonicalContractEventId", c."commercialEventType", c."eventStatus",
  c."buyerSector", c."aiRelevance", c."readerVersion", c."confidenceBasis", c."counterpartyRaw", c."primaryEntityId"`;
const DETAIL_COLS = `d."vendorRaw", d."clientRaw", d."contractEventType", d."previousVendorRaw", d."incumbentDisplaced",
  d."contractStartDate", d."contractEndDate", d."contractLengthMonths", d."pricingModel", d."outcomePricing",
  d."feeAtRisk", d."consumptionModel", d."tcvCommittedUsd", d."tcvEstimateMidUsd", d."tcvBasis", d."tcvIsEstimate",
  d."acvUsd", d."expansionValueUsd", d."scopeSummary", d."primaryMacroServiceLine"`;

(async () => {
  const digest = async (label: string, sql: string) => {
    const r = await rows<{ h: string }>(sql);
    return { label, hash: sha(r.map(x => x.h).join("\n")), n: r.length };
  };

  const estate = await digest("estate", `select md5(concat_ws('|', ${EVENT_COLS}, ${DETAIL_COLS})) h
    from "CanonicalMarketEvent" c left join "ContractDetails" d on d."canonicalEventId" = c.id order by c.id`);
  const contracts = await digest("contract_events", `select md5(concat_ws('|', ${EVENT_COLS}, ${DETAIL_COLS})) h
    from "CanonicalMarketEvent" c left join "ContractDetails" d on d."canonicalEventId" = c.id
    where c.family = 'CONTRACT' order by c.id`);
  const semantic = await digest("semantic_content", `select md5(concat_ws('|', c.id, c."commercialEventType", c."eventStatus",
    c."buyerSector", c."aiRelevance", c."supportingText", c."readerVersion")) h
    from "CanonicalMarketEvent" c where c."readerVersion" is not null order by c.id`);

  const families = await rows<{ family: string; h: string; n: bigint }>(`select c.family,
    md5(string_agg(md5(concat_ws('|', ${EVENT_COLS}, ${DETAIL_COLS})), '' order by c.id)) h, count(*) n
    from "CanonicalMarketEvent" c left join "ContractDetails" d on d."canonicalEventId" = c.id group by c.family order by c.family`);

  const out = {
    frozenAt: new Date().toISOString(),
    policy: { promptPolicyVersion: PROMPT_POLICY_VERSION, readerModel: READER_MODEL, readerMaxOutputTokens: READER_MAX_OUTPUT_TOKENS },
    estate, contracts, semantic,
    families: families.map(f => ({ family: f.family, n: Number(f.n), hash: f.h })),
    note: "Substantive content only. Operational state (createdAt, updatedAt, heartbeats, run ids, fetch attempts and timestamps) is excluded by construction, so a refresh that changes nothing substantive leaves every hash unmoved.",
  };
  fs.mkdirSync("_scratch", { recursive: true });
  fs.writeFileSync("_scratch/ct-freeze-hashes.json", JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await prisma.$disconnect();
})();
