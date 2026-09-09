/**
 * Enrich imported procurement events from the collector's RAW feed files,
 * which carry two things the merged corpus drops (MEASURE-FIT.md):
 *
 *   1. `end_date_estimated` — UK FTS (and some Contracts Finder) notices state
 *      an ESTIMATED end date. A contract length derived from one is an
 *      estimate and is marked so; the merged corpus lost the flag.
 *   2. `value_amount` + `value_currency` — the reporting currency and original
 *      amount, which the merge converted to dollars and discarded.
 *
 * Idempotent; touches only events created by scripts/import-procurement.ts.
 *
 *   npx tsx scripts/enrich-procurement-from-raw.ts [--apply]
 */
import fs from "fs";
import os from "os";
import { prisma } from "@/lib/db";

interface RawRow { id?: string; ocid?: string; end_date?: string | null; end_date_estimated?: boolean | null; value_amount?: number | null; value_currency?: string | null }
const FILES: [string, string][] = [["fts_raw.json", "UK_FTS"], ["contracts_finder_raw.json", "UK_ContractsFinder"], ["canadabuys_raw.json", "CA_CanadaBuys"], ["austender_raw.json", "AU_AusTender"]];

(async () => {
  const apply = process.argv.includes("--apply");
  const dir = `${os.homedir()}/Dev/ag-contract-sources`;
  const raw = new Map<string, RawRow>();
  for (const [file, source] of FILES) {
    const rows = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")) as RawRow[] | { records?: RawRow[] };
    for (const r of Array.isArray(rows) ? rows : rows.records ?? []) { const k = r.id ?? r.ocid; if (k) raw.set(`${source}/${encodeURIComponent(String(k))}`, r); }
  }
  const events = await prisma.canonicalMarketEvent.findMany({
    where: { readerVersion: { startsWith: "procurement-import/" } },
    select: { id: true, sourceEvents: { select: { sourceUrl: true }, take: 1 }, contractDetails: { select: { id: true, contractEndDatePrecision: true, contractLengthDescriptor: true, tcvOriginalCurrency: true, tcvCommittedUsd: true } } },
  });
  let matched = 0, flaggedEstimated = 0, currency = 0;
  for (const e of events) {
    const url = e.sourceEvents[0]?.sourceUrl ?? ""; const key = url.replace(/^procurement:\/\//, "");
    const r = raw.get(key); const cd = e.contractDetails; if (!r || !cd) continue;
    matched++;
    const data: Record<string, unknown> = {};
    if (r.end_date_estimated && cd.contractEndDatePrecision === "day") {
      data.contractEndDatePrecision = "estimated";
      data.contractLengthDescriptor = "derived_from_estimated_end_date (source notice flags the end date as an estimate)";
      flaggedEstimated++;
    }
    if (r.value_currency && r.value_amount && cd.tcvCommittedUsd != null && (cd.tcvOriginalCurrency === "USD" || !cd.tcvOriginalCurrency) && r.value_currency !== "USD") {
      data.tcvOriginalCurrency = r.value_currency; data.tcvOriginalValue = r.value_amount;
      currency++;
    }
    if (apply && Object.keys(data).length) await prisma.contractDetails.update({ where: { id: cd.id }, data });
  }
  console.log(`${events.length} imported events; ${matched} matched a raw record; end date marked ESTIMATED on ${flaggedEstimated}; original currency restored on ${currency}${apply ? " — written" : " — dry run, pass --apply"}`);
  await prisma.$disconnect();
})();
