/**
 * Deterministic tests for the evidence gate and organisation matching.
 * Run: npx tsx scripts/tests/gate-and-dedup.ts
 */
import { decidePublication } from "../../src/lib/ingestion/gate";
import { normaliseOrg, orgsMatch, titleCounterparty, withinDays, titleSimilarity, titleAmount, amountsConflict } from "../../src/lib/ingestion/dedup";
import type { ExtractionResult } from "../../src/lib/ingestion/classifier";
import { EMPTY_USAGE } from "../../src/lib/ingestion/classifier";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const res = (o: Partial<ExtractionResult>): ExtractionResult => ({
  family: "CONTRACT", eventType: "new_win", canonicalTitle: "t", vendorRaw: "TCS", clientRaw: "Porsche", tcvUsd: null, tcvIsEstimate: false,
  contractLengthMonths: null, primaryMacroServiceLine: null, geography: [], industry: null, confidenceScore: 0.55,
  extractionMethod: "llm", summary: null, analystInsight: null, missingCritical: [], eventTypeValid: true, exclusionReason: null, usage: EMPTY_USAGE, ...o,
});

console.log("\n=== Publication gate (on the model's reading) ===");
const announced = res({ eventStatus: "announced", articleType: "news_report" });
ok("announced contract with undisclosed value PUBLISHES at 0.55", decidePublication(announced, "ent_1").status === "published", `${decidePublication(announced, "ent_1").reason}`);
ok("stock note that reports a deal publishes (genre is not the event)", decidePublication(res({ eventStatus: "announced", articleType: "stock_or_analyst_note" }), "e").status === "published");
ok("unresolved vendor → review", decidePublication(announced, null).reason === "vendor_unresolved");
ok("no counterparty → review", decidePublication(res({ eventStatus: "announced", clientRaw: null }), "e").reason === "no_counterparty");
ok("invalid event type → review", decidePublication(res({ eventStatus: "announced", eventType: "technology_alliance", eventTypeValid: false }), "e").reason?.startsWith("event_type_invalid:technology_alliance") === true);
ok("rule-based extraction → review", decidePublication(res({ eventStatus: "announced", extractionMethod: "rule_fallback" }), "e").reason === "rule_based_extraction");
ok("tender → review", decidePublication(res({ eventStatus: "opportunity" }), "e").reason === "opportunity_not_award");
ok("terminated contract → review", decidePublication(res({ eventStatus: "terminated" }), "e").reason === "contract_terminated");
ok("disputed contract → review", decidePublication(res({ eventStatus: "disputed" }), "e").reason === "contract_disputed");
ok("loss to a named competitor publishes as displacement", decidePublication(res({ eventStatus: "terminated", eventType: "incumbent_displacement" }), "e").status === "published");
ok("no status → review", decidePublication(res({ eventStatus: null }), "e").reason === "no_event_status");
ok("very low confidence → review", decidePublication(res({ eventStatus: "announced", confidenceScore: 0.3 }), "e").reason === "low_confidence:0.30");
ok("multiple reasons are all reported", decidePublication(res({ eventStatus: "opportunity", confidenceScore: 0.3, clientRaw: null }), null).reason === "vendor_unresolved,no_counterparty,opportunity_not_award,low_confidence:0.30");
ok("partnership needs a counterparty", decidePublication(res({ family: "PARTNERSHIP", eventType: "technology_alliance", eventStatus: "announced", clientRaw: null }), "e").reason === "no_counterparty");
ok("results publish without counterparty", decidePublication(res({ family: "FINANCIAL_RESULTS", eventType: "quarterly_results", eventStatus: "announced", clientRaw: null, confidenceScore: 0.9 }), "e").status === "published");
ok("M&A publishes on entity + target", decidePublication(res({ family: "M_AND_A", eventType: "acquisition", eventStatus: "announced", clientRaw: "Healthcare IT Leaders", confidenceScore: 0.6 }), "e").status === "published");
ok("described-but-unnamed client publishes as anonymised", decidePublication(res({ eventStatus: "announced", clientRaw: null, clientDescriptor: "a leading European automotive OEM" }), "e").status === "published");
ok("completed counts as publishable", decidePublication(res({ eventStatus: "completed" }), "e").status === "published");

console.log("\n=== Organisation matching ===");
ok("normalise strips suffixes", normaliseOrg("Porsche AG") === "porsche" && normaliseOrg("Tata Consultancy Services Ltd.") === "tata consultancy services");
ok("parenthetical kept as a token", normaliseOrg("Millicom (Tigo)") === "millicom tigo" && orgsMatch("Millicom (Tigo)", "Millicom") && orgsMatch("Porsche (MHP)", "MHP"));
ok("Porsche vs Porsche AG", orgsMatch("Porsche", "Porsche AG"));
ok("Porsche vs Porsche (MHP)", orgsMatch("Porsche (MHP)", "Porsche"));
ok("ITC Infotech vs ITC Infotech India Ltd", orgsMatch("ITC Infotech", "ITC Infotech India Ltd"));
ok("UK MoD vs Ministry of Defence — no false merge from 'ministry' alone", !orgsMatch("UK Ministry of Justice", "UK Ministry of Defence") || false);
ok("different clients do not match", !orgsMatch("Deutsche Bank", "Danske Bank"));
ok("short names need containment, not tokens", !orgsMatch("ABB", "ABB Capital Markets Advisory Group Ltd") === false);
ok("empty never matches", !orgsMatch("", "Porsche") && !orgsMatch(null, null));
ok("title counterparty parsed", titleCounterparty("TCS | New Win | Porsche | Engineering IT") === "Porsche");
ok("title without counterparty", titleCounterparty("Bechtle Q2 results") === null);
ok("buyer from procurement wording", titleCounterparty("CGI Group has been awarded a five-year contract by Energy Queensland (Ergon) to provide managed services") === "Energy Queensland");
ok("buyer from 'contract with'", titleCounterparty("Amdocs signs multi-year agreement with Telefónica Chile to accelerate AI operations") === "Telefónica Chile");
ok("buyer from 'selected by'", titleCounterparty("Infosys selected by Danske Bank as strategic partner") === "Danske Bank");
ok("different buyers do not match", !orgsMatch("U.S. Department of Energy", "Energy Queensland") && !orgsMatch("SolarisBank AG", "RBL Bank"));
ok("withinDays", withinDays(new Date("2026-09-01"), new Date("2026-09-10"), 14) && !withinDays(new Date("2026-09-01"), new Date("2026-10-01"), 14) && !withinDays(null, new Date(), 14));

console.log("\n=== Title similarity (no-counterparty families) ===");
ok("re-reported results match", titleSimilarity("Serco stock holds steady as investors eye recent profit growth", "Serco stock holds steady as 2026 profit growth improves") >= 0.5);
ok("different launches do not", titleSimilarity("NTT DATA launches AI Factory Lab in Riyadh", "NTT DATA partners with US company on AI enterprise cybersecurity") < 0.5);
ok("same launch, different wording", titleSimilarity("NTT DATA Launches Riyadh Lab for MEA AI Adoption", "NTT DATA launches AI factory Lab in Riyadh") >= 0.5);

ok("stemming matches appoints/appointed re-reports", titleSimilarity("Hexaware appoints Vivek Jetley as new CEO", "Hexaware Technologies Appointed Vivek Jetley As CEO") >= 0.5);
ok("results release vs same-week fundraise stay apart", titleSimilarity("Persistent Systems Q1 FY27 Results: $452.4M Revenue, 16.1% YoY Growth", "Persistent Systems board approves $1.25B fundraise via debt and equity") < 0.25);
ok("different counterparties in canonical titles stay below the fallback threshold", titleSimilarity("Serco | New Win | Fiona Stanley Hospital | ICT Services", "Serco | New Win | Royal Navy | ICT Services") < 0.6);

console.log("\n=== Amount guard ===");
ok("parses AUD m", titleAmount("Keane Consulting has been awarded an AUD 0.79m ($0.62m) contract") === 790_000);
ok("parses £ million", titleAmount("Capita awarded £456 million contract") === 456_000_000);
ok("parses crore", titleAmount("ITC Infotech to buy stake for ₹1,330 crore") === 1_330e7);
ok("no amount → null", titleAmount("Serco wins RAF Fylingdales contract") === null);
ok("different amounts conflict", amountsConflict("X awarded AUD 0.33m contract", "X awarded AUD 0.35m contract") === false && amountsConflict("X awarded AUD 0.79m contract", "X awarded AUD 0.34m contract") === true);
ok("missing amount never conflicts", !amountsConflict("X awarded contract", "X awarded £5m contract"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
