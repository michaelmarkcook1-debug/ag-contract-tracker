/**
 * ContractTracker → shared analytical variable catalogue (AI Delivery Mandate §1–§5).
 *
 * Emits variable METADATA and coverage, not values, into the same estate the AG
 * catalogue already scans. ContractTracker keeps its own database; the catalogue
 * stays one system by reading an exported summary, exactly as it reads the AG
 * canonical estate — not by opening a second live connection.
 *
 * Every entry carries what a future analyst editor needs to judge it: unit,
 * temporal shape, provider coverage, population, data type and current consumer.
 * It carries no polarity, scale or transformation — those are governance.
 */
import fs from "fs";
import { prisma } from "@/lib/db";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]
  : "_scratch/ct_variables.json";

interface Spec { id: string; name: string; unit: string; temporalShape: string; dataType: string; sql: string; note?: string }

/** Substantive CT intelligence. Coverage is measured, never assumed. */
const SPECS: Spec[] = [
  { id: "ct::contract.tcv", name: "Contract total value", unit: "USD", temporalShape: "point", dataType: "number",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where coalesce(d."tcvCommittedUsd",d."tcvEstimateMidUsd") is not null` },
  { id: "ct::contract.duration_months", name: "Contract duration", unit: "months", temporalShape: "point", dataType: "number",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."contractLengthMonths" is not null` },
  { id: "ct::contract.start_date", name: "Contract start", unit: "date", temporalShape: "point", dataType: "date",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."contractStartDate" is not null` },
  { id: "ct::contract.end_date", name: "Contract end", unit: "date", temporalShape: "point", dataType: "date",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."contractEndDate" is not null` },
  { id: "ct::event.renewal", name: "Renewal events", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "commercialEventType"='RENEWAL'` },
  { id: "ct::event.extension", name: "Extension events", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "commercialEventType"='EXTENSION'` },
  { id: "ct::event.expansion", name: "Expansion events", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "commercialEventType"='EXPANSION'` },
  { id: "ct::event.termination", name: "Termination events", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "commercialEventType"='TERMINATION'` },
  { id: "ct::event.competitive_takeaway", name: "Competitive takeaway events", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "commercialEventType"='COMPETITIVE_TAKEAWAY'` },
  { id: "ct::event.frequency", name: "Contract event frequency", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where family='CONTRACT'` },
  { id: "ct::relationship.count", name: "Provider-client relationships", unit: "count", temporalShape: "point", dataType: "count",
    sql: `select count(distinct md5(concat_ws('|',lower(btrim(d."vendorRaw")),lower(btrim(d."clientRaw")),lower(coalesce(d."primaryMacroServiceLine",''))))) n,
      count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId"
      where d."vendorRaw" is not null and d."clientRaw" is not null` },
  { id: "ct::relationship.tcv_movement", name: "Relationship TCV movement", unit: "count", temporalShape: "series", dataType: "count",
    sql: `select count(*) n, 0 providers from (select md5(concat_ws('|',lower(btrim(d."vendorRaw")),lower(btrim(d."clientRaw")),lower(coalesce(d."primaryMacroServiceLine",'')))) r
      from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."vendorRaw" is not null and d."clientRaw" is not null
      group by 1 having count(*)>1 and count(distinct coalesce(d."tcvCommittedUsd",d."tcvEstimateMidUsd"))>1) z` },
  { id: "ct::semantic.ai_relevance", name: "AI relevance of commercial event", unit: "category", temporalShape: "point", dataType: "enum",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "aiRelevance" is not null and "aiRelevance" <> 'UNKNOWN'` },
  { id: "ct::semantic.ai_tcv", name: "AI-relevant contract value", unit: "USD", temporalShape: "point", dataType: "number",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "CanonicalMarketEvent" c join "ContractDetails" d on d."canonicalEventId"=c.id
      where c."aiRelevance" in ('EXPLICIT_AI','AI_MATERIAL') and coalesce(d."tcvCommittedUsd",d."tcvEstimateMidUsd") is not null` },
  { id: "ct::semantic.buyer_sector", name: "Buyer sector", unit: "category", temporalShape: "point", dataType: "enum",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "buyerSector" is not null and "buyerSector" <> 'UNKNOWN'` },
  { id: "ct::semantic.private_share", name: "Private-sector event share", unit: "ratio", temporalShape: "point", dataType: "number",
    sql: `select count(*) n, count(distinct "primaryEntityId") providers from "CanonicalMarketEvent" where "buyerSector"='PRIVATE_SECTOR'` },
  { id: "ct::commercial.pricing_model", name: "Pricing model", unit: "category", temporalShape: "point", dataType: "enum",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."pricingModel" is not null` },
  { id: "ct::commercial.outcome_pricing", name: "Outcome-based pricing", unit: "boolean", temporalShape: "point", dataType: "boolean",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."outcomePricing" is true` },
  { id: "ct::commercial.fee_at_risk", name: "Fee at risk", unit: "boolean", temporalShape: "point", dataType: "boolean",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."feeAtRisk" is true` },
  { id: "ct::commercial.incumbent_displaced", name: "Incumbent displacement", unit: "boolean", temporalShape: "point", dataType: "boolean",
    sql: `select count(*) n, count(distinct c."primaryEntityId") providers from "ContractDetails" d join "CanonicalMarketEvent" c on c.id=d."canonicalEventId" where d."incumbentDisplaced" is true` },
];

(async () => {
  const out = [];
  for (const s of SPECS) {
    const r = (await prisma.$queryRawUnsafe<{ n: bigint; providers: bigint }[]>(s.sql))[0];
    out.push({ id: s.id, name: s.name, unit: s.unit, temporalShape: s.temporalShape,
      dataType: s.dataType, population: Number(r?.n ?? 0), providerCoverage: Number(r?.providers ?? 0),
      source: "Contract Tracker", consumers: [] as string[] });
  }
  const meta = { generatedAt: new Date().toISOString(), estate: "contracttracker", variables: out };
  fs.mkdirSync(require("path").dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(meta, null, 1));
  console.log(`exported ${out.length} ContractTracker variables -> ${OUT}`);
  for (const v of out) console.log(`  ${String(v.population).padStart(6)}  ${String(v.providerCoverage).padStart(4)} providers  ${v.id}`);
  await prisma.$disconnect();
})();
