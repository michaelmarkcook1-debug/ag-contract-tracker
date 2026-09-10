/**
 * Retrofill the tracker from the original contract-sources corpus
 * (~/Dev/ag-contract-sources/contracts_global.json — AusTender, Contracts
 * Finder, USAspending, TED, CanadaBuys, FTS award records).
 *
 * WHAT IT DOES. For every record whose supplier is a tracked vendor:
 *   1. dedup against the store — skipped when an event for the same provider
 *      and buyer sits within 45 days of the record's start date, or the same
 *      provider and stated value within 90 days, or the record was imported
 *      before (its synthetic URL exists). The dedup pass is never contravened.
 *   2. otherwise creates one CONTRACT event, its details and a source row,
 *      typed deterministically from the record: buyer PUBLIC_SECTOR, event
 *      type from the notice text where it says renewal/extension/etc, dates
 *      and value exactly as recorded (a zero value is UNDISCLOSED, not zero).
 *   3. for records that started within the last 24 months, fills what can be
 *      estimated and labels every estimate: TCV (value engine), contract
 *      length (median for the service line and population), end date (start +
 *      length, precision "estimated"). Older records carry stated data only.
 *
 * No model calls. Idempotent. Dry run by default.
 *
 *   npx tsx scripts/import-procurement.ts [--apply] [--limit N] [--file ~/Dev/ag-contract-sources/contracts_global.json]
 */
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { matchTrackedVendor } from "@/lib/ingestion/sources";
import { orgsMatch } from "@/lib/ingestion/dedup";
import { canonicalContractEventId } from "@/lib/ingestion/reader";
import { estimateContractValue } from "@/lib/tcv/engine";
import { canonicalServiceLine } from "@/lib/tcv/value-model";

interface Rec { "Award ID": string; "Start Date": string | null; "End Date": string | null; Description: string; "Awarding Agency": string; "Recipient Name": string; vendor_canonical: string; value_usd: number | null; source: string; country: string; macro_service: string | null; buyer_sector: string | null; status: string | null }

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
// The serverless database driver can reject asynchronously on a dropped socket
// after the awaiting call has resolved; a long pass must survive that.
process.on("unhandledRejection", err => { console.error(`unhandled (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`); });
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await f(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 700 * (i + 1))); } }
  throw last;
}
const IMPORT_VERSION = "procurement-import/1.0.0-2026-09-08";
const EVENT_RE: [RegExp, string][] = [
  [/\b(renew(al|ed|s)?|re-?award)\b/i, "RENEWAL"], [/\b(extension|extend(ed|s)?|option (period|year)|exercis(e|ed) (an )?option)\b/i, "EXTENSION"],
  [/\b(expan(sion|ded|ds)|additional (scope|services)|scope increase)\b/i, "EXPANSION"], [/\b(re-?compet(e|ition|ed)|re-?tender(ed)?)\b/i, "RECOMPETE"],
  [/\b(terminat(ed|ion)|cancel(led|lation))\b/i, "TERMINATION"], [/\b(variation|modification|amendment|change order)\b/i, "CONTRACT_CHANGE"],
];
const TYPE_TO_LEGACY: Record<string, string> = { NEW_WIN: "new_win", RENEWAL: "renewal", EXTENSION: "extension", EXPANSION: "expansion", RECOMPETE: "rebid_win", TERMINATION: "termination", CONTRACT_CHANGE: "contract_change" };
// A notice that does not mention AI does not establish that the work is not
// AI-related — it establishes nothing. Falling back to NOT_AI_SPECIFIC turned
// silence into a negative finding on 5,965 records and polluted every AI rate
// computed from the estate. Absence of the keyword now yields UNKNOWN.
const AI_RE = /\b(artificial intelligence|machine learning|generative ai|\bAI\b|large language|LLM|GenAI|agentic)\b/;
const parseDate = (s: string | null) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
const monthsBetween = (a: Date, b: Date) => Math.max(1, Math.round((b.getTime() - a.getTime()) / (30.44 * 86_400_000)));

(async () => {
  const apply = process.argv.includes("--apply");
  const limit = process.argv.includes("--limit") ? Number(arg("--limit", "0")) : 0;
  const file = arg("--file", `${os.homedir()}/Dev/ag-contract-sources/contracts_global.json`);
  const recs = JSON.parse(fs.readFileSync(file, "utf8")) as Rec[];
  const tracked = recs.map(r => ({ r, vendor: matchTrackedVendor(`${r.vendor_canonical ?? ""} ${r["Recipient Name"] ?? ""}`) })).filter(x => !!x.vendor) as { r: Rec; vendor: string }[];
  console.log(`${recs.length} records; ${tracked.length} name a tracked vendor${apply ? " — importing" : " (dry run; pass --apply)"}`);

  // Existing events per vendor entity, for the dedup pass.
  const entities = await prisma.entity.findMany({ where: { canonicalName: { in: [...new Set(tracked.map(t => t.vendor))] } }, select: { id: true, canonicalName: true } });
  const entityId = new Map(entities.map(e => [e.canonicalName, e.id]));
  const existing = await prisma.canonicalMarketEvent.findMany({
    where: { family: "CONTRACT", primaryEntityId: { in: entities.map(e => e.id) }, publicationStatus: { not: "excluded_noise" } },
    select: { id: true, primaryEntityId: true, announcementDate: true, counterpartyRaw: true, contractDetails: { select: { clientRaw: true, tcvCommittedUsd: true, contractStartDate: true } } },
  });
  const byEntity = new Map<string, typeof existing>();
  for (const e of existing) { if (!e.primaryEntityId) continue; if (!byEntity.has(e.primaryEntityId)) byEntity.set(e.primaryEntityId, []); byEntity.get(e.primaryEntityId)!.push(e); }
  const alreadyImported = new Set((await prisma.sourceEvent.findMany({ where: { sourceUrl: { startsWith: "procurement://" } }, select: { sourceUrl: true } })).map(s => s.sourceUrl));

  // Median stated length per service line and population, for the length estimate.
  const lengthRows = await prisma.$queryRawUnsafe<{ line: string | null; months: number }[]>(`
    SELECT cd."primaryMacroServiceLine" AS line, cd."contractLengthMonths" AS months FROM "ContractDetails" cd JOIN "CanonicalMarketEvent" e ON e.id=cd."canonicalEventId"
    JOIN "_CanonicalMarketEventToSourceEvent" j ON j."A"=e.id JOIN "SourceEvent" se ON se.id=j."B"
    WHERE e.family='CONTRACT' AND cd."contractLengthMonths" > 0 AND (se."sourceType"='procurement_notice' OR se."sourceName"='GlobalData')`);
  const medianLen = (line: string | null) => { const pool = lengthRows.filter(l => canonicalServiceLine(l.line) === canonicalServiceLine(line)).map(l => l.months).sort((a, b) => a - b); const p = pool.length >= 12 ? pool : lengthRows.map(l => l.months).sort((a, b) => a - b); return p.length ? p[Math.floor(p.length / 2)] : 36; };

  const cutoff24 = new Date(); cutoff24.setUTCMonth(cutoff24.getUTCMonth() - 24);
  const counts = { duplicate: 0, imported: 0, noDate: 0, estimatedValue: 0, estimatedLength: 0, failed: 0 };
  const sample: string[] = [];
  let seen = 0;
  for (const { r, vendor } of tracked) {
    if (limit && seen++ >= limit) break;
    const start = parseDate(r["Start Date"]), end = parseDate(r["End Date"]);
    const url = `procurement://${r.source}/${encodeURIComponent(r["Award ID"] ?? crypto.createHash("sha1").update(`${vendor}|${r["Awarding Agency"]}|${r["Start Date"]}|${r.Description}`).digest("hex").slice(0, 16))}`;
    if (alreadyImported.has(url)) { counts.duplicate++; continue; }
    if (!start) { counts.noDate++; continue; }
    const vid = entityId.get(vendor);
    const value = r.value_usd && r.value_usd > 0 ? r.value_usd : null;
    // dedup pass: same provider + buyer within 45 days, or same provider + stated value within 90 days
    const dup = (byEntity.get(vid ?? "") ?? []).find(e => {
      const when = e.contractDetails?.contractStartDate ?? e.announcementDate; if (!when) return false;
      const days = Math.abs(when.getTime() - start.getTime()) / 86_400_000;
      const buyer = e.counterpartyRaw ?? e.contractDetails?.clientRaw ?? "";
      if (days <= 45 && buyer && orgsMatch(buyer, r["Awarding Agency"] ?? "")) return true;
      if (days <= 90 && value && e.contractDetails?.tcvCommittedUsd && Math.abs(e.contractDetails.tcvCommittedUsd - value) <= 0.01 * value) return true;
      return false;
    });
    if (dup) { counts.duplicate++; continue; }

    const type = EVENT_RE.find(([re]) => re.test(r.Description ?? ""))?.[1] ?? "NEW_WIN";
    const months = start && end && end > start ? monthsBetween(start, end) : null;
    const recent = start >= cutoff24;
    const ai = AI_RE.test(r.Description ?? "") ? "AI_MATERIAL" : "UNKNOWN";
    const line = r.macro_service ?? null;
    let estimate = null, estLength: number | null = null;
    if (recent) {
      if (!value) estimate = await estimateContractValue({ serviceLine: line, sourceType: "procurement_notice", sourceName: r.source, contractLengthMonths: months, provider: vendor, industry: r.buyer_sector ?? null, geography: [r.country], eventType: TYPE_TO_LEGACY[type], anonymised: false, announcementYear: start.getUTCFullYear(), text: r.Description });
      if (!months) estLength = medianLen(line);
    }
    if (estimate) counts.estimatedValue++; if (estLength) counts.estimatedLength++;
    const title = `${vendor} | ${type === "NEW_WIN" ? "Award" : type.replace(/_/g, " ").toLowerCase().replace(/^./, c => c.toUpperCase())} | ${r["Awarding Agency"] ?? "Unnamed buyer"} | ${(r.Description ?? "").slice(0, 80)}`;
    if (sample.length < 8) sample.push(`${title.slice(0, 90)} | ${value ? `$${(value / 1e6).toFixed(1)}m stated` : estimate ? `est $${(estimate.lowUsd / 1e6).toFixed(1)}m–$${(estimate.highUsd / 1e6).toFixed(1)}m` : "no value"} | ${months ? `${months}m` : estLength ? `~${estLength}m (est)` : "length ?"}`);
    counts.imported++;
    if (!apply) continue;
    try {
      const endDate = end ?? (estLength ? new Date(start.getTime() + estLength * 30.44 * 86_400_000) : null);
      const idKey = canonicalContractEventId(vendor, r["Awarding Agency"] ?? null, null, type, start);
      const collision = await prisma.canonicalMarketEvent.findUnique({ where: { canonicalContractEventId: idKey }, select: { id: true } });
      await retry(() => prisma.$transaction(async tx => {
        const src = await tx.sourceEvent.create({ data: {
          sourceUrl: url, rawTextHash: crypto.createHash("sha256").update(url).digest("hex").slice(0, 16), sourceTitle: title.slice(0, 300), sourceName: r.source, sourceType: "procurement_notice",
          publicationDate: start, rawText: r.Description ?? null, processingStatus: "extracted", extractedFamily: "CONTRACT", extractionConfidence: 1,
          articleType: "PROCUREMENT_NOTICE", articleTextChars: (r.Description ?? "").length, promptPolicyVersion: IMPORT_VERSION, analysedAt: new Date(),
        }, select: { id: true } });
        if (collision) { await tx.canonicalMarketEvent.update({ where: { id: collision.id }, data: { sourceEvents: { connect: { id: src.id } } } }); return; }
        const ev = await tx.canonicalMarketEvent.create({ data: {
          family: "CONTRACT", eventType: TYPE_TO_LEGACY[type] ?? "new_win", canonicalTitle: title.slice(0, 500), announcementDate: start,
          // The source corpus carries Start Date and End Date and NO award or
          // publication date, so this value is the contract start, not an
          // announcement. Labelling it "explicit" told the gap-causation
          // classifier the source stated it, which it never did.
          announcementDateBasis: "contract_start",
          effectiveDate: start, geography: JSON.stringify([r.country]), industry: r.buyer_sector ?? null, industryBasis: r.buyer_sector ? "classified" : "unavailable",
          // Asserted, not measured: the importer maps structured fields and does
          // not assess anything. Stamping the basis is what stops this value
          // being read downstream as if a person or a model had judged it.
          confidenceScore: 1, confidenceBasis: "asserted",
          commercialRelevanceScore: value ? 0.9 : 0.7, humanReviewRequired: false, publicationStatus: "published",
          counterpartyRaw: r["Awarding Agency"] ?? null, originalArticleUrl: null, primaryEntityId: vid ?? null,
          canonicalContractEventId: idKey, commercialEventType: type, eventStatus: "ANNOUNCED", buyerSector: "PUBLIC_SECTOR", aiRelevance: ai,
          supportingText: JSON.stringify({ event: (r.Description ?? "").slice(0, 300), buyerSector: r["Awarding Agency"] ?? "" }), readerVersion: IMPORT_VERSION,
          sourceEvents: { connect: { id: src.id } },
        } });
        await tx.contractDetails.create({ data: {
          canonicalEventId: ev.id, vendorId: vid ?? undefined, vendorRaw: r.vendor_canonical ?? r["Recipient Name"], vendorConfidence: 0.95,
          clientRaw: r["Awarding Agency"] ?? null, clientConfidence: 0.9, clientAnonymised: false,
          contractEventType: TYPE_TO_LEGACY[type] ?? "new_win",
          contractStartDate: start, contractStartDatePrecision: "day", contractEndDate: endDate, contractEndDatePrecision: end ? "day" : estLength ? "estimated" : "unknown",
          contractLengthMonths: months ?? estLength, contractLengthDescriptor: months ? "derived_from_dates" : estLength ? `estimated:median for ${canonicalServiceLine(line)} (${r.source})` : null,
          tcvCommittedUsd: value, tcvOriginalCurrency: value ? "USD" : null, tcvOriginalValue: value, tcvBasis: value ? "official_disclosed" : "undisclosed", tcvIsEstimate: false, tcvConfidence: value ? "known" : "not_reliably_estimable",
          ...(estimate ? { tcvEstimateLowUsd: estimate.lowUsd, tcvEstimateMidUsd: estimate.midUsd, tcvEstimateHighUsd: estimate.highUsd, tcvBasis: estimate.basis, tcvIsEstimate: true, tcvConfidence: "estimated", tcvEstimateMethod: estimate.method, tcvEstimateInputs: JSON.stringify(estimate.inputs), tcvEstimateExplanation: estimate.explanation, tcvEstimateVersion: estimate.version } : {}),
          primaryMacroServiceLine: line, scopeSummary: (r.Description ?? "").slice(0, 1000),
          platformsUsed: "[]", clientServiceCoverageLocation: JSON.stringify([r.country]), secondaryMacroServiceLines: "[]", secondaryMicroServiceLines: "[]",
        } });
        byEntity.get(vid ?? "")?.push({ id: ev.id, primaryEntityId: vid ?? null, announcementDate: start, counterpartyRaw: r["Awarding Agency"] ?? null, contractDetails: { clientRaw: r["Awarding Agency"] ?? null, tcvCommittedUsd: value, contractStartDate: start } });
      }, { timeout: 20_000, maxWait: 10_000 }));
      alreadyImported.add(url);
      if (counts.imported % 250 === 0) process.stdout.write(`\r imported ${counts.imported}`);
    } catch (err) { counts.failed++; if (counts.failed <= 5) console.log(`  failed: ${title.slice(0, 60)}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`); }
  }
  console.log(`\nwould import ${counts.imported} · duplicates of stored events ${counts.duplicate} · no start date ${counts.noDate} · value estimated (≤24 months) ${counts.estimatedValue} · length estimated (≤24 months) ${counts.estimatedLength}${apply ? ` · failed ${counts.failed} — written` : " — dry run, nothing written"}`);
  sample.forEach(s => console.log(`  ${s}`));
  await prisma.$disconnect();
})();
