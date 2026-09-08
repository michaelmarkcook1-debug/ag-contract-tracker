/**
 * Deterministic tests for article selection and categorisation rules.
 * No network, no model. Run: npx tsx scripts/tests/selection-rules.ts
 *
 * Covers the 2026-09 audit fixes: noise patterns must catch the junk the triage
 * model was keeping WITHOUT catching real contract headlines; event types are
 * validated per family; Google News queries are date-bounded.
 */
import { isRelevantArticle, GOOGLE_NEWS_SOURCES, TRACKED_VENDORS, GNEWS_WINDOW_DAYS } from "../../src/lib/ingestion/sources";
import { isValidEventType, defaultEventType, FAMILY_EVENT_TYPES, ruleBasedExtract } from "../../src/lib/ingestion/classifier";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

console.log("\n=== Noise rules: junk the model was keeping must be rejected by rules ===");
const junk: [string, string][] = [
  ["stock award filing",   "Conduent (NASDAQ: CNDT) ties executive stock award to share-price targets - Stock Titan"],
  ["RSU grant",            "ADP (NASDAQ: ADP) CFO gets 6,464 RSUs vesting over 3 years - Stock Titan"],
  ["stock surge",          "Conduent (CNDT) Stock Surges on Google Gemini AI Partnership for Legal Tech"],
  ["stock steady",         "Serco stock holds steady as investors await fresh earnings signals - AD HOC NEWS"],
  ["sponsorship",          "Accenture and Salford City Football Club Announce Partnership to Accelerate a New Era"],
  ["sports tie-up",        "TCS makes a fresh push into cricket with new digital partnership - The Times of India"],
  ["vendor award",         "Atos-Flender Solution Wins IDC China Best Agentic AI Practice Award - BernamaBiz"],
  ["innovation award",     "Atos-powered agentic AI solution wins IDC AI Innovation Award"],
  ["conference showcase",  "NTT Data leaders to showcase firm's services and solutions at LEAP 2026 - Consultancy"],
  ["buyback",              "Cancom stock prepares new share buyback as capital market notice specifies price"],
  ["mutual fund stake",    "Nippon India Mutual Fund raises Cyient stake to 5.22% via open market buys"],
  ["price target",         "BofA raises Somnigroup stock price target on Leggett acquisition By Investing.com"],
];
for (const [label, title] of junk) {
  const v = isRelevantArticle(title, "wire_service");
  ok(`rejects ${label}`, !v.relevant && (v.reason === "rules:noise" || v.reason === "rules:hard_exclude"), `relevant=${v.relevant} reason=${v.reason}`);
}

console.log("\n=== Real events must still pass the rules ===");
const real: string[] = [
  "Capita awarded £456m civil service training contracts by Cabinet Office",
  "TTEC wins $21 million IRS contact center contract - Investing.com",
  "Infosys selected by Danske Bank as strategic partner for cloud transformation",
  "Wipro signs five-year deal with ABB for global digital workplace services",
  "ABB Extends Engagement with Wipro to Deliver and Enhance Global Digital Workplace",
  "Serco secures extension of Royal Navy maritime support contract",
  "Kyndryl to buy Healthcare IT Leaders in AI modernization push - Dealroom",
  "Telefónica Chile and Amdocs Establish Strategic Multi-Year Agreement to Accelerate AI operations",
  "NEC Secures Japan Defense Contract to Build First AI That Hears Submarines",
  "Vietcombank Taps Virtusa to Build AI-Native Corporate Banking Platform",
  "TCS secures €1.25 billion five-year strategic deal with Porsche - The Economic Times",
  "Coforge expands partnership with Pegasystems for AI solutions - Investing.com",
  // share-price headlines that REPORT a transaction go to the model (retest 2026-09-08)
  "L&T Technology Services shares jump 3% after bagging $75 million deal - The Economic Times",
  "TCS Selected By METRO For IT Transformation; Shares Fall 0.72% - HDFC Sky",
  "Mphasis Signs Japan Tech Pact; Shares Fall 2.85% In Early Trade - hdfcsky.com",
  "Palantir Stock Jumps on Expanded PwC AI Deal - GuruFocus",
  "Happiest Minds shares plunge over 8% after ITC Infotech merger deal; among top losers",
];
for (const title of real) {
  const v = isRelevantArticle(title, "wire_service");
  ok(`keeps "${title.slice(0, 60)}"`, v.relevant, `reason=${v.reason}`);
}

console.log("\n=== Exclusion reasons are machine-readable ===");
ok("hard exclude reason", isRelevantArticle("Atos Named Leader in the ISG Provider Lens for AI Managed Services", "wire_service").reason === "rules:hard_exclude");
ok("no-signal reason for vendor press", isRelevantArticle("AI Agents Need an Offboarding Plan Too", "vendor_press_release").reason === "rules:no_signal");
ok("vendor-feed M&A announcement passes", isRelevantArticle("Kyndryl announces agreement to purchase Healthcare IT Leaders, LLC, to accelerate AI-led modernization", "investor_relations_release").relevant);
ok("vendor-feed results pass", isRelevantArticle("Kyndryl Reports Second Quarter Results", "investor_relations_release").relevant);
ok("unsupported source reason", isRelevantArticle("Anything at all", "reputable_news_source").reason === "rules:unsupported_source");
ok("tender stays UNCLASSIFIED, not CONTRACT", isRelevantArticle("Tender for a five-year managed services contract", "procurement_notice").family === "UNCLASSIFIED");

console.log("\n=== Event types are validated per family ===");
ok("CONTRACT rejects technology_alliance", !isValidEventType("CONTRACT", "technology_alliance"));
ok("CONTRACT rejects leadership_appointment", !isValidEventType("CONTRACT", "leadership_appointment"));
ok("CONTRACT accepts framework_award", isValidEventType("CONTRACT", "framework_award"));
ok("invented type rejected", !isValidEventType("CONTRACT", "Performance Criticism"));
ok("every family has types", Object.keys(FAMILY_EVENT_TYPES).length === 6);
const dt: [string, string, string][] = [
  ["CONTRACT", "Wipro renews outsourcing contract with ABB", "renewal"],
  ["CONTRACT", "Serco secures extension of Royal Navy contract", "extension"],
  ["CONTRACT", "Capita awarded framework agreement by Crown Commercial Service", "framework_award"],
  ["CONTRACT", "TTEC wins $21 million IRS contact center contract", "new_win"],
  ["M_AND_A", "ITC Infotech to acquire 22% stake in Happiest Minds", "acquisition"],
  ["M_AND_A", "Happiest Minds to merge with ITC Infotech", "merger"],
  ["M_AND_A", "Atos completes sale of Worldgrid to Alten", "divestiture"],
  ["PARTNERSHIP", "Coforge expands strategic partnership with Pega", "technology_alliance"],
  ["ORG_CHANGE", "EXL announces departure of Vivek Jetley, President of Insurance", "leadership_departure"],
  ["ORG_CHANGE", "Cognizant appoints new Chief Financial Officer", "leadership_appointment"],
  ["FINANCIAL_RESULTS", "Bechtle Q2 Earnings Call Highlights", "quarterly_results"],
  ["FINANCIAL_RESULTS", "Infosys raises full-year guidance", "guidance_update"],
  ["NEW_OFFERING", "Tech Mahindra and Cisco Introduce Security Service Edge platform", "platform_launch"],
];
for (const [family, text, want] of dt) {
  const got = defaultEventType(family, text);
  ok(`${family} "${text.slice(0, 45)}" → ${want}`, got === want && isValidEventType(family, got), `got=${got}`);
}
const rb = ruleBasedExtract({ title: "Wipro signs five-year application outsourcing agreement with Lloyds", url: "https://x/1", publishedAt: "2026-09-01", snippet: null, sourceId: "t", provider: "Wipro", sourceType: "wire_service" });
ok("rule-based result types are consistent with family", rb.family === "UNCLASSIFIED" ? !rb.eventTypeValid : rb.eventTypeValid, `family=${rb.family} type=${rb.eventType} valid=${rb.eventTypeValid}`);

console.log("\n=== Google News queries are date-bounded ===");
const g = (v: string) => GOOGLE_NEWS_SOURCES.find(s => s.provider === v)!;
ok("one feed per tracked vendor", GOOGLE_NEWS_SOURCES.length === TRACKED_VENDORS.length, `${GOOGLE_NEWS_SOURCES.length}/${TRACKED_VENDORS.length}`);
ok("high-volume vendor uses the short window", decodeURIComponent(g("IBM").url).includes(`when:${GNEWS_WINDOW_DAYS.highVolume}d`), g("IBM").url);
ok("standard vendor uses the standard window", decodeURIComponent(g("Capita").url).includes(`when:${GNEWS_WINDOW_DAYS.standard}d`), g("Capita").url);
ok("query carries contract verbs", /selected OR signs OR wins OR deal OR agreement/.test(decodeURIComponent(g("Capita").url)));
ok("disambiguated vendor keeps its terms and the window", (() => { const u = decodeURIComponent(g("TCS").url); return u.includes("Tata Consultancy") && /when:\d+d/.test(u); })());
ok("feed ids unchanged (registry rows keyed by id)", g("Sopra Steria").id === "gnews-sopra-steria");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
