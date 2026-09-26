/**
 * Tier 1 semantic read — acceptance tests (§19).
 *
 * Deterministic predicate checks first, then assertions against the state the
 * Tier 1 run actually left behind. No model spend: live reader semantics are
 * covered by scripts/tests/reader-regression.ts.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/tests/tier1-semantic-read.ts
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { segmentText, BUYER_SECTORS, AI_RELEVANCE, COMMERCIAL_EVENT_TYPES, EVENT_STATUSES, PROMPT_POLICY_VERSION, READER_MODEL } from "@/lib/ingestion/reader";
import { orgsMatch } from "@/lib/ingestion/dedup";

const ARTICLE_GRADE_MIN = 800, FULL_TEXT_MIN = 1500;
const RUN_AT = "2026-09-10T16:40:00Z";
// The batch finished before the next daily cron (09-11 07:00). Without an upper
// bound these assertions counted the production cron's later reads and events —
// legitimate work under different rules — as violations of the batch's rules.
const RUN_END = "2026-09-11T00:00:00Z";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const one = async <T>(sql: string): Promise<T> => ((await prisma.$queryRawUnsafe<T[]>(sql))[0]);
const n = (v: unknown) => Number(v ?? 0);

(async () => {
console.log("=== Deterministic predicates ===");

// 1 / 2 — article-grade selection and snippet exclusion
const grade = (len: number) => len >= FULL_TEXT_MIN ? "FULL_TEXT" : len >= ARTICLE_GRADE_MIN ? "ARTICLE_GRADE_PARTIAL" : "SNIPPET_ONLY";
ok("article-grade selection: thresholds classify at the boundaries",
  grade(1500) === "FULL_TEXT" && grade(1499) === "ARTICLE_GRADE_PARTIAL" && grade(800) === "ARTICLE_GRADE_PARTIAL" && grade(799) === "SNIPPET_ONLY");
ok("snippet exclusion: a 196-char Google News snippet is never article-grade", grade(196) === "SNIPPET_ONLY");

// 3 — idempotency predicate
const skip = (h: string, m: string, p: string, curH: string) => h === curH && m === READER_MODEL && p === PROMPT_POLICY_VERSION;
ok("idempotency: same hash + model + policy is skipped", skip("abc", READER_MODEL, PROMPT_POLICY_VERSION, "abc"));
ok("idempotency: changed text is re-read", !skip("abc", READER_MODEL, PROMPT_POLICY_VERSION, "def"));
ok("idempotency: same text under a new policy is re-read", !skip("abc", READER_MODEL, "reader/9.9.9", "abc"));

// 4 — full-text processing
const long = Array.from({ length: 60 }, (_, i) => `Para ${i}. ${"word ".repeat(120)}`).join("\n");
const segs = segmentText(long);
ok("full text: a long article segments rather than truncates",
  segs.length > 1 && long.startsWith(segs[0].slice(0, 80)) && long.endsWith(segs[segs.length - 1].slice(-40)), `${segs.length} segments`);

// 11 — incumbent displacement predicate (the regression this suite exists for)
const displaced = (incumbent: string | null, provider: string | null) => !!incumbent && !orgsMatch(incumbent, provider);
ok("displacement: a renewal whose incumbent IS the winner is not a displacement", !displaced("Kyndryl", "Kyndryl"));
ok("displacement: name variants of the winner are not a displacement", !displaced("Tata Consultancy Services (TCS)", "Tata Consultancy Services"));
ok("displacement: a different incumbent IS a displacement", displaced("DXC Technology", "Capgemini"));
ok("displacement: no incumbent is not a displacement", !displaced(null, "Atos"));

console.log("\n=== State left by the Tier 1 run ===");
const READ = `c."readerVersion" = '${PROMPT_POLICY_VERSION}' and c."updatedAt" > '${RUN_AT}'`;

// 1 — nothing below article grade was read
const sn = await one<{ bad: bigint }>(`select count(*) bad from "SourceEvent" s
  where s."analysedAt" > '${RUN_AT}' and s."analysedAt" < '${RUN_END}' and s."promptPolicyVersion" = '${PROMPT_POLICY_VERSION}'
    and (s."articleTextChars" is null or s."articleTextChars" < ${ARTICLE_GRADE_MIN})`);
ok("no source below the article-grade floor was read", n(sn.bad) === 0, `${n(sn.bad)} offenders`);

// 2 — structured sources were excluded as article sources
const st = await one<{ bad: bigint }>(`select count(*) bad from "SourceEvent" s
  where s."analysedAt" > '${RUN_AT}' and s."sourceType" in ('procurement_notice','trusted_structured_dataset','structured_primary_source')`);
ok("structured sources were not read as articles", n(st.bad) === 0, `${n(st.bad)} offenders`);

// 4 — stored provenance matches what was analysed
const pv = await one<{ tot: bigint; bad: bigint }>(`select count(*) tot,
  count(*) filter (where s."articleTextHash" is null or s."modelId" is null or s."promptPolicyVersion" is null) bad
  from "SourceEvent" s where s."analysedAt" > '${RUN_AT}' and s."analysedAt" < '${RUN_END}'`);
ok("every read source carries hash, model and policy", n(pv.bad) === 0, `${n(pv.tot)} read`);

// 5 — multi-event articles created no new canonical events
const res = JSON.parse(fs.readFileSync("_scratch/tier1-result.json", "utf8")).result as Record<string, number>;
const created = await one<{ c: bigint }>(`select count(*) c from "CanonicalMarketEvent" where "createdAt" > '${RUN_AT}' and "createdAt" < '${RUN_END}'`);
ok("multi-event articles did not create canonical events", n(created.c) === 0,
  `${res.multiEventArticles} multi-event articles, ${res.extraEventsSeen} extra events counted, ${n(created.c)} created`);

// 6 — deduplication: canonical identity stays unique
const dup = await one<{ d: bigint }>(`select count(*) d from (
  select "canonicalContractEventId" from "CanonicalMarketEvent"
  where "canonicalContractEventId" is not null group by 1 having count(*) > 1) z`);
ok("canonical contract event identity is unique", n(dup.d) === 0, `${n(dup.d)} collisions`);

// 7 / 8 — enum integrity
const en = await one<{ sec: bigint; ai: bigint; typ: bigint; sta: bigint }>(`select
  count(*) filter (where "buyerSector" is not null and "buyerSector" not in (${BUYER_SECTORS.map(v => `'${v}'`).join(",")})) sec,
  count(*) filter (where "aiRelevance" is not null and "aiRelevance" not in (${AI_RELEVANCE.map(v => `'${v}'`).join(",")})) ai,
  count(*) filter (where "commercialEventType" is not null and "commercialEventType" not in (${COMMERCIAL_EVENT_TYPES.map(v => `'${v}'`).join(",")})) typ,
  count(*) filter (where "eventStatus" is not null and "eventStatus" not in (${EVENT_STATUSES.map(v => `'${v}'`).join(",")})) sta
  from "CanonicalMarketEvent" c where ${READ}`);
ok("buyer sector values are all in the declared set", n(en.sec) === 0);
ok("AI relevance values are all in the declared set", n(en.ai) === 0);
ok("commercial event types are all in the declared set", n(en.typ) === 0);
ok("event statuses are all in the declared set", n(en.sta) === 0);

// 9 / 10 — commercial model and outcome pricing
const cm = await one<{ blankpm: bigint; optrue: bigint; opnosupport: bigint }>(`select
  count(*) filter (where d."pricingModel" is not null and btrim(d."pricingModel") = '') blankpm,
  count(*) filter (where d."outcomePricing" is true) optrue,
  count(*) filter (where d."outcomePricing" is true and (c."supportingText" is null or c."supportingText" = '{}')) opnosupport
  from "CanonicalMarketEvent" c join "ContractDetails" d on d."canonicalEventId" = c.id where ${READ}`);
ok("no blank pricing-model strings were stored", n(cm.blankpm) === 0);
ok("outcome pricing was extracted at all", n(cm.optrue) > 0, `${n(cm.optrue)} events`);
ok("every outcome-priced event carries supporting text", n(cm.opnosupport) === 0);

// 11 — the displacement regression, in the data
const dp = await one<{ bad: bigint; ok_: bigint }>(`select
  count(*) filter (where lower(btrim(d."previousVendorRaw")) = lower(btrim(coalesce(e."canonicalName", d."vendorRaw", '')))) bad,
  count(*) ok_ from "ContractDetails" d
  join "CanonicalMarketEvent" c on c.id = d."canonicalEventId"
  left join "Entity" e on e.id = c."primaryEntityId"
  where d."incumbentDisplaced" is true`);
ok("no displacement flag names the winning provider as the displaced incumbent", n(dp.bad) === 0,
  `${n(dp.ok_)} displacements estate-wide, ${n(dp.bad)} self-referential`);

// 12 — reader / importer are disjoint populations
const dj = await one<{ both: bigint }>(`select count(*) both from "CanonicalMarketEvent"
  where "readerVersion" like 'reader/%' and "supportingText" like '%procurement-import%'`);
ok("no event carries both an importer and a reader classification", n(dj.both) === 0,
  "reader and importer cohorts are disjoint — no head-to-head row exists");

// 13 — cost accounting
ok("cost accounting recorded tokens and spend", res.costUsd > 0 && res.inputTokens > 0 && res.outputTokens > 0,
  `$${res.costUsd.toFixed(2)}, ${res.inputTokens} in / ${res.outputTokens} out`);
ok("realised cost per read is within a sane band", (res.costUsd / res.read) > 0.001 && (res.costUsd / res.read) < 0.20,
  `$${(res.costUsd / res.read).toFixed(4)}/read`);

// 14 — failure state is visible and never silently enriched
const fl = await one<{ err: bigint; poisoned: bigint }>(`select
  count(*) filter (where s."processingError" is not null) err,
  count(*) filter (where s."processingError" is not null and s."analysedAt" > '${RUN_AT}') poisoned
  from "SourceEvent" s`);
ok("failures are recorded, not swallowed", n(fl.err) > 0, `${n(fl.err)} error rows`);
ok("a failed read never wrote reading provenance", n(fl.poisoned) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
})();
