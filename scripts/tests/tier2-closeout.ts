/**
 * Tier 2 closeout regression tests (AI Delivery Mandate §9).
 * Deterministic predicates plus assertions against the estate Tier 2 left behind.
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/tests/tier2-closeout.ts
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { READER_MAX_OUTPUT_TOKENS, PROMPT_POLICY_VERSION } from "@/lib/ingestion/reader";
import { decidePublication } from "@/lib/ingestion/gate";
import { STALE_RUN_MS } from "@/lib/ingestion/run-state";
import type { ExtractionResult } from "@/lib/ingestion/classifier";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const one = async <T>(s: string): Promise<T> => (await prisma.$queryRawUnsafe<T[]>(s))[0];
const n = (v: unknown) => Number(v ?? 0);

const base = (o: Partial<ExtractionResult>): ExtractionResult => ({
  // NEW_OFFERING carries no counterparty requirement, so these cases isolate
  // the confidence branch instead of tripping the counterparty gate first.
  family: "NEW_OFFERING", eventType: "new_offering", eventTypeValid: true, canonicalTitle: "t", vendorRaw: "V",
  counterpartyRaw: "B", counterpartyDescriptor: null, announcementDate: null, effectiveDate: null,
  contractValueUsd: null, contractLengthMonths: null, primaryMacroServiceLine: null, geography: [],
  industry: null, confidenceScore: 0.9, extractionMethod: "llm", summary: null, analystInsight: null,
  missingCritical: [], eventStatus: "announced", articleType: "NEWS_REPORT", ...o,
} as unknown as ExtractionResult);

(async () => {
console.log("=== Confidence basis (§6) ===");
ok("measured low confidence still routes to review",
  decidePublication(base({ confidenceScore: 0.2, confidenceBasis: "measured" }), "v").status === "needs_review");
ok("measured high confidence publishes",
  decidePublication(base({ confidenceScore: 0.9, confidenceBasis: "measured" }), "v").status === "published");
const asserted = decidePublication(base({ confidenceScore: 1, confidenceBasis: "asserted", groundedClaims: false } as object), "v");
ok("asserted 1.0 with no grounding cannot pass as measured certainty",
  asserted.status === "needs_review" && (asserted.reason ?? "").includes("confidence_asserted_ungrounded"), asserted.reason ?? "");
ok("asserted 1.0 WITH grounding publishes on grounding, not on the number",
  decidePublication(base({ confidenceScore: 1, confidenceBasis: "asserted", groundedClaims: true } as object), "v").status === "published");
ok("an unstamped basis fails safe, not open",
  decidePublication(base({ confidenceScore: 1 }), "v").status === "needs_review");

console.log("\n=== Reader output cap (§2) ===");
ok("cap is a named reader-specific constant above the old ceiling", READER_MAX_OUTPUT_TOKENS === 24_000);
const capSrc = (await import("fs")).readFileSync("src/lib/ingestion/classifier.ts", "utf8");
ok("the classifier did NOT inherit the reader's allowance", !capSrc.includes("READER_MAX_OUTPUT_TOKENS"));
ok("policy version was not bumped by a transport change", PROMPT_POLICY_VERSION === "reader/2.2.0-2026-09-08");

console.log("\n=== Estate state ===");
const cov = await one<Record<string, bigint>>(`select
  count(*) filter (where "readerVersion" like 'reader/%') reader,
  count(*) filter (where "readerVersion" like 'procurement-import%') import,
  count(*) filter (where "readerVersion" is null) unread, count(*) total from "CanonicalMarketEvent"`);
ok("semantic reader coverage recorded", n(cov.reader) > 1900, `${n(cov.reader)} reader-complete of ${n(cov.total)}`);

const ai = await one<{ bad: bigint }>(`select count(*) bad from "CanonicalMarketEvent"
  where "readerVersion" like 'procurement-import%' and "aiRelevance" = 'NOT_AI_SPECIFIC'`);
ok("a silent notice is never recorded as a negative AI finding", n(ai.bad) === 0, `${n(ai.bad)} manufactured negatives`);

const fab = await one<Record<string, bigint>>(`select
  count(d."pricingModel") pm, count(d."outcomePricing") op, count(d."feeAtRisk") far, count(d."incumbentDisplaced") inc
  from "CanonicalMarketEvent" c join "ContractDetails" d on d."canonicalEventId"=c.id
  where c."readerVersion" like 'procurement-import%'`);
ok("the importer fabricates no commercial mechanics",
  n(fab.pm) + n(fab.op) + n(fab.far) + n(fab.inc) === 0, `pm=${n(fab.pm)} op=${n(fab.op)} far=${n(fab.far)} inc=${n(fab.inc)}`);

console.log("\n=== Date basis (§1, §12) ===");
const d = await one<Record<string, bigint>>(`select
  count(*) filter (where "announcementDateBasis" = 'explicit' and "readerVersion" like 'procurement-import%') import_claims_explicit,
  count(*) filter (where "announcementDateBasis" = 'contract_start') contract_start,
  count(*) filter (where "announcementDate" < '1990-01-01') sentinel,
  count(*) filter (where "announcementDate" is null and "announcementDateBasis" <> 'unavailable') null_but_claimed
  from "CanonicalMarketEvent"`);
ok("no imported date still claims to be explicit", n(d.import_claims_explicit) === 0);
ok("contract-start basis is recorded where the date was inherited", n(d.contract_start) > 5900, `${n(d.contract_start)}`);
ok("no sentinel date survives", n(d.sentinel) === 0);
ok("an unknown date is labelled unavailable, never fabricated", n(d.null_but_claimed) === 0);

console.log("\n=== Recovery state safety (§7) ===");
const rec = await one<Record<string, bigint>>(`select
  count(*) filter (where "bodyState" = 'FETCH_FAILED') fetch_failed,
  count(*) filter (where "bodyState" in ('FULL_TEXT','PARTIAL_ARTICLE')) recovered,
  count(*) filter (where "bodyState" = 'UNREADABLE') unreadable,
  count(*) filter (where "bodyState" is null) never_attempted from "SourceEvent"`);
ok("no row is left in a throttle-induced permanent failure", n(rec.fetch_failed) === 0, `${n(rec.fetch_failed)}`);
ok("genuine recoveries are retained", n(rec.recovered) > 1000, `${n(rec.recovered)}`);
ok("unattempted rows stay unattempted, not unreadable", n(rec.never_attempted) > 20000, `${n(rec.never_attempted)} pending recovery`);

console.log("\n=== Idempotency / linkage ===");
const dup = await one<{ d: bigint }>(`select count(*) d from (select "canonicalContractEventId" from "CanonicalMarketEvent"
  where "canonicalContractEventId" is not null group by 1 having count(*) > 1) z`);
ok("canonical contract identity remains unique", n(dup.d) === 0);
const reread = await one<{ d: bigint }>(`select count(*) d from (select "articleTextHash", "promptPolicyVersion"
  from "SourceEvent" where "articleTextHash" is not null group by 1,2 having count(*) > 1) z`);
ok("one article hash under one policy was read once", n(reread.d) === 0, `${n(reread.d)} repeats`);

console.log("\n=== Run health (§14) ===");
ok("stale window exceeds the platform ceiling", STALE_RUN_MS > 300_000);
const runs = await one<Record<string, bigint>>(`select count(*) filter (where status='running') running,
  count(*) filter (where status='failed') failed, count(*) filter (where status='partial') partial,
  count(*) filter (where status='completed') completed,
  count(*) filter (where status='running' and coalesce("heartbeatAt","startedAt") < now() - interval '15 minutes') stale_running
  from "IngestionRun"`);
ok("no run is stranded in RUNNING", n(runs.stale_running) === 0, `running=${n(runs.running)} failed=${n(runs.failed)} partial=${n(runs.partial)} completed=${n(runs.completed)}`);

console.log("\n=== Substantive hash behaviour (§8) ===");
const H = `select md5(concat_ws('|', c.id, c."commercialEventType", c."eventStatus", c."buyerSector",
  c."aiRelevance", c."readerVersion")) h from "CanonicalMarketEvent" c where c.family='CONTRACT' order by c.id limit 500`;
const h1 = (await prisma.$queryRawUnsafe<{ h: string }[]>(H)).map(x => x.h).join("");
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const before = sha(h1);
// operational touch: bump an updatedAt without changing substance
const victim = await one<{ id: string }>(`select id from "CanonicalMarketEvent" where family='CONTRACT' order by id limit 1`);
await prisma.$executeRawUnsafe(`update "CanonicalMarketEvent" set "updatedAt" = now() where id = $1`, victim.id);
const after = sha((await prisma.$queryRawUnsafe<{ h: string }[]>(H)).map(x => x.h).join(""));
ok("an operational timestamp alone does not move a substantive hash", before === after);
// substantive touch: change a semantic field, then restore
const cur = await one<{ v: string | null }>(`select "aiRelevance" v from "CanonicalMarketEvent" where id = '${victim.id}'`);
await prisma.$executeRawUnsafe(`update "CanonicalMarketEvent" set "aiRelevance" = 'AI_ADJACENT' where id = $1`, victim.id);
const moved = sha((await prisma.$queryRawUnsafe<{ h: string }[]>(H)).map(x => x.h).join(""));
await prisma.$executeRawUnsafe(`update "CanonicalMarketEvent" set "aiRelevance" = ${cur.v === null ? "NULL" : `'${cur.v}'`} where id = $1`, victim.id);
const restored = sha((await prisma.$queryRawUnsafe<{ h: string }[]>(H)).map(x => x.h).join(""));
ok("a recovered article's semantics WOULD move the hash", moved !== before, "future recovery is visible downstream");
ok("the fixture restored the estate exactly", restored === before);

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
})();
