/**
 * Whole-article reader regression (AI Delivery Mandate §21). Deterministic
 * unit checks run first (segmentation, grounding, reconciliation, identity);
 * the semantic cases A–L + J then run through the live reader.
 * Run: npx tsx scripts/tests/reader-regression.ts [--unit-only]
 */
import { readArticle, segmentText, quoteOccurs, reconcile, ground, canonicalContractEventId, buyerKey, PROMPT_POLICY_VERSION, READER_MODEL, type GroundedEvent, type RawEventCandidate } from "../../src/lib/ingestion/reader";
import { FIXTURES, FIVE_REPORTS } from "./fixtures/regression-articles";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

console.log("=== Deterministic ===");
const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(120)}`).join("\n");
const segs = segmentText(long);
ok("long text is segmented in order with overlap", segs.length > 1 && segs.every(s => s.length <= 11_500) && long.startsWith(segs[0].slice(0, 100)) && segs[segs.length - 1].endsWith(long.slice(-50)), `${segs.length} segments`);
ok("short text is one segment", segmentText("short").length === 1);
const text = "Under the five-year agreement, valued at approximately €140 million, Capgemini will migrate Nordea's payments processing.";
ok("verbatim quote is found", quoteOccurs("valued at approximately €140 million", text));
ok("quote with curly quotes / whitespace still found", quoteOccurs("Nordea’s   payments processing", text));
ok("fabricated quote is not found", !quoteOccurs("worth $500 million over ten years", text));
const base: RawEventCandidate = { family: "CONTRACT", commercialEventType: "NEW_WIN", eventStatus: "ANNOUNCED", provider: "Capgemini", buyer: "Nordea", buyerDescriptor: null, buyerSector: "PRIVATE_SECTOR", buyerSectorQuote: null, aiRelevance: "NOT_AI_SPECIFIC", aiRelevanceQuote: null, eventQuote: "Capgemini will migrate Nordea's payments processing", announcementDate: null, effectiveDate: null, contractValue: 140_000_000, currency: "EUR", valueQuote: "valued at approximately €140 million", valueIsTcv: true, acv: null, durationMonths: 60, durationQuote: "five-year agreement", renewalPeriodMonths: null, expansionValue: null, serviceScope: null, serviceLine: null, industry: null, geography: [], pricingModel: null, outcomePricing: null, feeAtRisk: null, consumptionModel: null, commercialModelQuote: null, incumbent: null, displacedProvider: null, incumbentQuote: null, summary: null, title: null };
const g1 = ground(base, text)!;
ok("grounded value and duration survive", g1.contractValue === 140_000_000 && g1.durationMonths === 60 && g1.supporting.value !== undefined);
const g2 = ground({ ...base, valueQuote: "worth $500 million", durationQuote: null, incumbent: "DXC", incumbentQuote: "replacing DXC", commercialEventType: "COMPETITIVE_TAKEAWAY" }, text)!;
ok("unsupported value, duration and incumbent are dropped", g2.contractValue === null && g2.durationMonths === null && g2.incumbent === null && g2.commercialEventType === "UNKNOWN" && g2.dropped.includes("value") && g2.dropped.includes("incumbent"));
ok("event without a supported passage is discarded", ground({ ...base, eventQuote: "nothing like this appears" }, text) === null);
const r = reconcile([g1, { ...g1, contractValue: null, valueQuote: null, durationMonths: null, serviceScope: "payments platform modernisation", supporting: { event: g1.eventQuote! }, dropped: [] } as GroundedEvent]);
ok("segment results for one event reconcile to one, keeping filled fields", r.length === 1 && r[0].contractValue === 140_000_000 && r[0].serviceScope === "payments platform modernisation");
const idA = canonicalContractEventId("Serco", "UK Ministry of Defence", null, "NEW_WIN", new Date("2026-09-02"));
ok("identity is deterministic, URL-free and name-variant tolerant", idA === canonicalContractEventId("Serco", "Ministry of Defence (UK)", null, "NEW_WIN", new Date("2026-09-20")) && idA === canonicalContractEventId("Serco", "the Ministry of Defence", null, "NEW_WIN", new Date("2026-09-09")), idA);
ok("buyer key ignores generic words", buyerKey("Danske Bank A/S", null) === "danske" && buyerKey("UK Ministry of Justice", null) !== buyerKey("UK Ministry of Defence", null));
ok("a renewal is not the same identity as the new win", idA !== canonicalContractEventId("Serco", "UK Ministry of Defence", null, "RENEWAL", new Date("2026-09-02")));
ok("policy version and model are recorded constants", PROMPT_POLICY_VERSION.startsWith("reader/") && READER_MODEL === "claude-sonnet-5");

if (process.argv.includes("--unit-only") || !process.env.ANTHROPIC_API_KEY) { console.log(`\n${pass} passed, ${fail} failed (semantic cases skipped)`); process.exit(fail ? 1 : 0); }

(async () => {
  console.log("\n=== Semantic cases (live reader) ===");
  let cost = 0;
  const inRange = (v: number | null, [lo, hi]: [number, number]) => v != null && v >= lo && v <= hi;
  for (const f of FIXTURES) {
    const t0 = Date.now();
    const out = await readArticle({ title: f.title, text: f.text, provider: f.provider, sourceType: f.sourceType, publishedAt: "2026-09-02" });
    if (!out.ok) { ok(`${f.id} ${f.label} — read`, false, out.error); continue; }
    const rd = out.reading; cost += rd.usage.costUsd;
    const e = f.expect;
    const counted = e.contractEventsOnly ? rd.events.filter(x => x.family === "CONTRACT") : rd.events;
    const ev = counted[0];
    const checks: [string, boolean, string][] = [];
    if (e.articleType) checks.push(["articleType", rd.articleType === e.articleType, rd.articleType]);
    if (e.articleTypeIn) checks.push(["articleType", e.articleTypeIn.includes(rd.articleType), rd.articleType]);
    checks.push(["event count", counted.length === e.events, `${counted.length}`]);
    if (e.events > 0 && ev) {
      if (e.family) checks.push(["family", ev.family === e.family, ev.family]);
      if (e.eventType) checks.push(["eventType", ev.commercialEventType === e.eventType, ev.commercialEventType]);
      if (e.status) checks.push(["status", ev.eventStatus === e.status, ev.eventStatus]);
      if (e.buyer) checks.push(["buyer", (typeof e.buyer === "string" ? ev.buyer === e.buyer : e.buyer.test(ev.buyer ?? "")), `${ev.buyer}`]);
      if (e.buyerSector) checks.push(["buyerSector", ev.buyerSector === e.buyerSector, ev.buyerSector]);
      if (e.aiRelevance) checks.push(["aiRelevance", ev.aiRelevance === e.aiRelevance, ev.aiRelevance]);
      if (e.valueApprox === null || e.noValue) checks.push(["no value invented", ev.contractValue === null, `${ev.contractValue}`]);
      else if (e.valueApprox) checks.push(["value", inRange(ev.contractValue, e.valueApprox), `${ev.contractValue} ${ev.currency}`]);
      if (e.durationMonths !== undefined) checks.push(["duration", ev.durationMonths === e.durationMonths, `${ev.durationMonths}`]);
      if (e.incumbent) { const inc = ev.incumbent ?? ev.displacedProvider ?? ""; checks.push(["incumbent", typeof e.incumbent === "string" ? inc === e.incumbent : e.incumbent.test(inc), inc]); }
      checks.push(["event passage grounded", !!ev.supporting.event, ev.supporting.event?.slice(0, 60) ?? ""]);
    }
    const allOk = checks.every(c => c[1]);
    ok(`${f.id} ${f.label} (${rd.segments} seg, ${((Date.now() - t0) / 1000).toFixed(0)}s)`, allOk, allOk ? `${rd.articleType}` : checks.filter(c => !c[1]).map(c => `${c[0]}=${c[2]}`).join(", "));
    if (f.id === "H") ok("H fact after 4,000 chars was read (segmented)", rd.segments > 1 && ev?.contractValue === 410_000_000, `segments=${rd.segments} value=${ev?.contractValue}`);
    if (f.id === "I") ok("I both contract events grounded with their own passages", counted.length === 2 && counted.every(x => !!x.supporting.event) && counted[0].supporting.event !== counted[1].supporting.event, rd.events.map(x => `${x.family}:${x.commercialEventType}/${x.buyer}`).join(" + "));
  }
  console.log("\n=== J: five reports, one identity ===");
  const ids = new Set<string>();
  for (const a of FIVE_REPORTS) {
    const out = await readArticle({ title: a.title, text: a.text, provider: a.provider, sourceType: a.sourceType, publishedAt: "2026-09-02" });
    if (!out.ok || !out.reading.events[0]) { ok(`J read: ${a.title.slice(0, 40)}`, false, out.ok ? "no event" : out.error); continue; }
    const ev = out.reading.events[0]; cost += out.reading.usage.costUsd;
    ids.add(canonicalContractEventId(ev.provider ?? "Serco", ev.buyer, ev.buyerDescriptor, ev.commercialEventType, new Date("2026-09-02")));
  }
  ok("five reports resolve to one canonical identity", ids.size === 1, `${ids.size} identities: ${[...ids].join(", ")}`);
  console.log(`\nmodel spend: $${cost.toFixed(2)}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
