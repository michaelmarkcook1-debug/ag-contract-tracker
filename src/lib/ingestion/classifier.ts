import { RawArticle } from "./crawler";
import { isRelevantArticle, TRACKED_VENDORS } from "./sources";

// ── Canonical vendor name map (for entity matching) ───────────────────────────
const VENDOR_PATTERNS: [RegExp, string][] = [
  [/\baccenture\b/i, "Accenture"],
  [/\btata consultancy|\\bTCS\b/i, "TCS"],
  [/\binfosys\b/i, "Infosys"],
  [/\bcapgemini\b/i, "Capgemini"],
  [/\bcognizant\b/i, "Cognizant"],
  [/\bwipro\b/i, "Wipro"],
  [/\bhcl\s*tech|\bhcltech\b/i, "HCLTech"],
  [/\bibm\b/i, "IBM"],
  [/\bdxc\s*technology|\bdxc\b/i, "DXC Technology"],
  [/\batos\b/i, "Atos"],
  [/\bntt\s*data\b/i, "NTT Data"],
  [/\btech\s*mahindra\b/i, "Tech Mahindra"],
  [/\bkyndryl\b/i, "Kyndryl"],
  [/\bcgi\b/i, "CGI"],
  [/\bsopra\s*steria\b/i, "Sopra Steria"],
  [/\bfujitsu\b/i, "Fujitsu"],
  [/\bconcentrix\b/i, "Concentrix"],
  [/\bgenpact\b/i, "Genpact"],
  [/\bconduent\b/i, "Conduent"],
  [/\bltimindtree\b/i, "LTIMindtree"],
];

const TCV_PATTERNS = [
  /\$\s*([\d,]+(?:\.\d+)?)\s*(billion|bn)\b/i,
  /\$\s*([\d,]+(?:\.\d+)?)\s*(million|mn|m)\b/i,
  /£\s*([\d,]+(?:\.\d+)?)\s*(billion|bn)\b/i,
  /£\s*([\d,]+(?:\.\d+)?)\s*(million|mn|m)\b/i,
  /€\s*([\d,]+(?:\.\d+)?)\s*(billion|bn)\b/i,
  /€\s*([\d,]+(?:\.\d+)?)\s*(million|mn|m)\b/i,
  /([\d,]+(?:\.\d+)?)\s*(billion|bn)\s*(?:dollar|usd|\$)/i,
  /([\d,]+(?:\.\d+)?)\s*(million|mn|m)\s*(?:dollar|usd|\$)/i,
];

const CURRENCY_TO_USD: Record<string, number> = { "£": 1.27, "€": 1.09, "$": 1.0 };
const MULTI_YEAR_TERMS = /\b(\d+)[- ]?year\b/i;
const LENGTH_MAP: Record<string, number> = { "one": 12, "two": 24, "three": 36, "four": 48, "five": 60, "seven": 84, "ten": 120 };

// ── Model tiers & pricing ────────────────────────────────────────────────────
// Two-tier extraction. Every article gets a cheap TRIAGE pass; only the
// commercially significant ones (contracts / M&A involving a tracked vendor)
// are promoted to the more capable ANALYSIS model. Most articles stop after
// triage, which is where the saving comes from.
export const MODEL_TIERS = {
  /** Cheap classifier: family, vendor, in/out of scope. Small max_tokens. */
  triage: "claude-haiku-4-5",
  /** Deeper reasoning for scope interpretation and competitive analyst insight. */
  analysis: "claude-sonnet-5",
} as const;

/**
 * USD per 1M tokens. Verified against the official pricing page on 2026-08-22
 * (platform.claude.com/docs/en/about-claude/pricing).
 *
 * Sonnet 5 at $2/$10 is CHEAPER than Sonnet 4.6 ($3/$15) — the introductory
 * rate became the standard price and the planned rise to $3/$15 was cancelled.
 *
 * Caveat: models from 4.7 onward use a newer tokenizer producing ~30% more
 * tokens for the same text, so Sonnet 5's effective cost per article is nearer
 * $2.60/$13 — still below Sonnet 4.6. Recorded costs stay accurate regardless,
 * because spend is billed from the API's reported usage, not an estimate.
 */
export const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "claude-haiku-4-5": { inputPerM: 1.0, outputPerM: 5.0 },
  "claude-sonnet-5": { inputPerM: 2.0, outputPerM: 10.0 },
  "claude-sonnet-4-6": { inputPerM: 3.0, outputPerM: 15.0 },
  "claude-opus-5": { inputPerM: 5.0, outputPerM: 25.0 },
  "claude-opus-4-8": { inputPerM: 5.0, outputPerM: 25.0 },
};

/**
 * Prompt-caching multipliers, relative to base input price.
 * Verified against platform.claude.com/docs/en/about-claude/pricing (2026-08).
 */
const CACHE_WRITE_MULTIPLIER = 1.25;   // 5-minute cache write
const CACHE_READ_MULTIPLIER = 0.1;     // cache hit

export function costOf(
  model: string, inputTokens: number, outputTokens: number,
  cacheWriteTokens = 0, cacheReadTokens = 0,
): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  const perM = (n: number) => n / 1_000_000;
  return perM(inputTokens) * p.inputPerM
    + perM(cacheWriteTokens) * p.inputPerM * CACHE_WRITE_MULTIPLIER
    + perM(cacheReadTokens) * p.inputPerM * CACHE_READ_MULTIPLIER
    + perM(outputTokens) * p.outputPerM;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to / read from the prompt cache (billed at 1.25x / 0.1x). */
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Which tiers actually ran, e.g. ["triage"] or ["triage","analysis"]. */
  tiers: string[];
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costUsd: 0, tiers: [] };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
    tiers: [...a.tiers, ...b.tiers],
  };
}

export interface ExtractionResult {
  family: string;
  eventType: string;
  canonicalTitle: string;
  vendorRaw: string | null;
  clientRaw: string | null;
  tcvUsd: number | null;
  tcvIsEstimate: boolean;
  contractLengthMonths: number | null;
  primaryMacroServiceLine: string | null;
  geography: string[];
  industry: string | null;
  confidenceScore: number;
  /** How confidenceScore came to exist. "measured" = computed from observable
   *  signals; "asserted" = hard-coded by a writer that does not measure it.
   *  An asserted value must never satisfy a measured-confidence gate. */
  confidenceBasis?: "measured" | "asserted";
  /** True when at least one claim is backed by a passage that occurs in the text. */
  groundedClaims?: boolean;
  extractionMethod: "llm" | "rules" | "rule_fallback";
  summary: string | null;
  analystInsight: string | null;
  missingCritical: string[];
  /** The text's description of an unnamed counterparty; the client is then anonymised. */
  clientDescriptor?: string | null;
  /** What kind of article the model judged this to be (see ARTICLE_TYPES); null for rule-based results. */
  articleType?: string | null;
  /** Status of the reported event: announced | completed | opportunity | terminated | disputed | none. */
  eventStatus?: string | null;
  /** Model-estimated value range (USD) when no value was stated — labelled, never mixed with tcvUsd. */
  tcvEstimateLowUsd?: number | null;
  tcvEstimateHighUsd?: number | null;
  tcvEstimateRationale?: string | null;
  /** eventType is one of the schema's types for this family. False → review. */
  eventTypeValid: boolean;
  /** Why the article was excluded ("rules:…" / "model:…"); null when in scope. */
  exclusionReason: string | null;
  /** Actual token spend for this article (zero for rule-based results). */
  usage: TokenUsage;
}

/** The six canonical families. Anything else must never reach the store. */
export const CANONICAL_FAMILIES = new Set([
  "CONTRACT", "FINANCIAL_RESULTS", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE",
]);

/** Event types the schema allows per family. Anything else is a model invention. */
export const FAMILY_EVENT_TYPES: Record<string, readonly string[]> = {
  CONTRACT: ["new_win", "renewal", "extension", "expansion", "rebid_win", "incumbent_displacement", "framework_award", "scope_reduction", "termination", "contract_change", "unknown"],
  M_AND_A: ["acquisition", "merger", "divestiture"],
  PARTNERSHIP: ["technology_alliance", "co_delivery_agreement"],
  NEW_OFFERING: ["service_launch", "platform_launch", "delivery_centre_opening"],
  ORG_CHANGE: ["leadership_appointment", "leadership_departure", "restructuring", "strategic_transformation"],
  FINANCIAL_RESULTS: ["financial_announcement", "quarterly_results", "annual_results", "guidance_update", "bookings_update", "segment_performance"],
};

export function isValidEventType(family: string, eventType: string): boolean {
  return (FAMILY_EVENT_TYPES[family] ?? []).includes(eventType);
}

/**
 * Rule-based event type WITHIN a family. The previous flat chain guessed across
 * families ("partner" → technology_alliance even when the family was CONTRACT),
 * which is how CONTRACT events came to carry partnership and leadership types.
 */
export function defaultEventType(family: string, text: string): string {
  switch (family) {
    case "CONTRACT":
      if (/\brenew/i.test(text)) return "renewal";
      if (/\bextend|\bextension\b/i.test(text)) return "extension";
      if (/\bexpand|\bexpansion\b/i.test(text)) return "expansion";
      if (/\bframework\b/i.test(text)) return "framework_award";
      if (/\bre-?bid|\bre-?compete/i.test(text)) return "rebid_win";
      if (/\bdisplac|\breplac(?:es|ing)\b/i.test(text)) return "incumbent_displacement";
      return "new_win";
    case "M_AND_A":
      if (/\bmerg/i.test(text)) return "merger";
      if (/\bdivest|\bsells?\b|\bsale of\b|\bspin[- ]?off/i.test(text)) return "divestiture";
      return "acquisition";
    case "PARTNERSHIP":
      return /\bco-?deliver|\bjoint(?:ly)? deliver|\bdelivery partner/i.test(text) ? "co_delivery_agreement" : "technology_alliance";
    case "NEW_OFFERING":
      if (/\b(?:delivery|innovation|development|technology) (?:cent(?:er|re)|hub)\b/i.test(text)) return "delivery_centre_opening";
      return /\bplatform\b/i.test(text) ? "platform_launch" : "service_launch";
    case "ORG_CHANGE":
      if (/\b(?:steps? down|departs?|departure|resigns?|exits?|leaves)\b/i.test(text)) return "leadership_departure";
      if (/\bappoint|\bnames?\b|\bhires?\b|\bjoins?\b|\bpromot/i.test(text)) return "leadership_appointment";
      if (/\brestructur|\blayoffs?\b|\bjob cuts?\b|\bheadcount|\bredundan/i.test(text)) return "restructuring";
      return "strategic_transformation";
    case "FINANCIAL_RESULTS":
      if (/\bguidance\b|\boutlook\b/i.test(text)) return "guidance_update";
      if (/\bbookings?\b|\bTCV\b|\border book\b|\bdeal wins?\b/i.test(text)) return "bookings_update";
      if (/\bfull[- ]year\b|\bannual\b|\bFY\d*\b/i.test(text)) return "annual_results";
      if (/\bQ[1-4]\b|\bquarter/i.test(text)) return "quarterly_results";
      return "financial_announcement";
    default:
      return "excluded_noise";
  }
}

// ── Rule-based extraction (always available, no API key required) ─────────────

export function ruleBasedExtract(article: RawArticle): ExtractionResult {
  const text = `${article.title} ${article.snippet ?? ""}`;
  const relevance = isRelevantArticle(article.title, article.sourceType);
  const { relevant, family } = relevance;

  if (!relevant) {
    return {
      family: "EXCLUDED", eventType: "excluded_noise", canonicalTitle: article.title,
      vendorRaw: null, clientRaw: null, tcvUsd: null, tcvIsEstimate: false,
      contractLengthMonths: null, primaryMacroServiceLine: null, geography: [],
      industry: null, confidenceScore: 0.1, extractionMethod: "rules",
      summary: null, analystInsight: null, missingCritical: [],
      eventTypeValid: false, exclusionReason: relevance.reason ?? "rules:excluded", usage: EMPTY_USAGE,
    };
  }

  // Vendor detection
  let vendorRaw: string | null = article.provider !== "Market Wide" ? article.provider : null;
  if (!vendorRaw) {
    for (const [pattern, canonical] of VENDOR_PATTERNS) {
      if (pattern.test(text)) { vendorRaw = canonical; break; }
    }
  }

  // TCV extraction
  let tcvUsd: number | null = null;
  // §2 — this extractor only reports explicitly stated values; it never estimates.
  let tcvIsEstimate = false;
  for (const pattern of TCV_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const num = parseFloat(m[1].replace(/,/g, ""));
    const unit = m[2]?.toLowerCase() ?? "";
    const currency = text.slice(Math.max(0, (m.index ?? 0) - 1), (m.index ?? 0) + 1).trim();
    const multiplier = /billion|bn/.test(unit) ? 1_000_000_000 : 1_000_000;
    const fxRate = CURRENCY_TO_USD[currency] ?? 1.0;
    tcvUsd = Math.round(num * multiplier * fxRate);
    tcvIsEstimate = false;
    break;
  }

  // Contract length
  let contractLengthMonths: number | null = null;
  const yearMatch = MULTI_YEAR_TERMS.exec(text);
  if (yearMatch) contractLengthMonths = parseInt(yearMatch[1]) * 12;
  else {
    for (const [word, months] of Object.entries(LENGTH_MAP)) {
      if (new RegExp(`\\b${word}[- ]year`, "i").test(text)) { contractLengthMonths = months; break; }
    }
  }

  // Event type — chosen within the family, never across families.
  const eventType = defaultEventType(family, text);

  // Service line
  let primaryMacroServiceLine: string | null = null;
  if (/\bcloud\b/i.test(text)) primaryMacroServiceLine = "Digital & Cloud";
  else if (/\binfrastructure|ITO\b/i.test(text)) primaryMacroServiceLine = "ITO";
  else if (/\bapplication|AMS\b/i.test(text)) primaryMacroServiceLine = "Application Services";
  else if (/\bBPO|business process\b/i.test(text)) primaryMacroServiceLine = "BPO";
  else if (/\bcybersecurity|security\b/i.test(text)) primaryMacroServiceLine = "Cybersecurity";
  else if (/\bAI|analytics|data\b/i.test(text)) primaryMacroServiceLine = "AI & Analytics";
  else if (/\bconsult/i.test(text)) primaryMacroServiceLine = "Consulting & Advisory";

  // Geography (simple)
  const geos: string[] = [];
  if (/\bUK\b|United Kingdom|England|Scotland|Wales/i.test(text)) geos.push("UK");
  if (/\bUS\b|United States|America\b/i.test(text)) geos.push("North America");
  if (/\bEurope|European\b/i.test(text)) geos.push("Europe");
  if (/\bIndia\b/i.test(text)) geos.push("India");
  if (/\bAustralia\b/i.test(text)) geos.push("Australia");
  if (/\bGlobal|worldwide|international\b/i.test(text)) geos.push("Global");

  // Industry
  let industry: string | null = null;
  if (/\bbank|financial|fintech\b/i.test(text)) industry = "BFSI";
  else if (/\bgovernment|public sector|ministry|department\b/i.test(text)) industry = "Public Sector";
  else if (/\bhealth|NHS|hospital|pharma\b/i.test(text)) industry = "Healthcare & Life Sciences";
  else if (/\btelec|telecom\b/i.test(text)) industry = "Telecommunications";
  else if (/\bmanufactur|automotive\b/i.test(text)) industry = "Manufacturing & Automotive";
  else if (/\bretail|consumer\b/i.test(text)) industry = "Retail";
  else if (/\bdefence|defense|military\b/i.test(text)) industry = "Aerospace & Defence";
  else if (/\benergy|oil|gas|utility\b/i.test(text)) industry = "Energy & Resources";

  const missingCritical: string[] = [];
  if (!vendorRaw) missingCritical.push("vendor");
  if (!tcvUsd) missingCritical.push("tcv");

  // Confidence: rule-based extractions are moderate confidence
  let confidenceScore = 0.55;
  if (vendorRaw) confidenceScore += 0.10;
  if (tcvUsd) confidenceScore += 0.10;
  if (contractLengthMonths) confidenceScore += 0.05;
  if (article.sourceType === "vendor_press_release") confidenceScore += 0.10;
  if (article.sourceType === "procurement_notice") confidenceScore += 0.15;

  return {
    family, eventType, canonicalTitle: article.title,
    vendorRaw, clientRaw: null, tcvUsd, tcvIsEstimate,
    contractLengthMonths, primaryMacroServiceLine, geography: geos,
    industry, confidenceScore: Math.min(confidenceScore, 0.89), confidenceBasis: "measured" as const,
    extractionMethod: "rules", summary: null, analystInsight: null, missingCritical,
    eventTypeValid: isValidEventType(family, eventType), exclusionReason: null, usage: EMPTY_USAGE,
  };
}

// ── LLM extraction (requires ANTHROPIC_API_KEY) ───────────────────────────────

// ── Tracked vendor universe ──────────────────────────────────────────────────
// Built from TRACKED_VENDORS so the coverage universe lives in ONE place. To
// expand coverage, add the vendor to TRACKED_VENDORS in sources.ts — that
// single edit updates the Google News feed list, the market-wide ingestion
// gate, and this prompt together. Nothing here needs changing.
const VENDOR_UNIVERSE = TRACKED_VENDORS.join(", ");

const READING_RULES = `Read the WHOLE text and judge it the way an analyst would.

1. What KIND of article is this? (articleType)
2. Does it report a MARKET EVENT in which one of the tracked vendors is a PARTY?
   The vendor wins, renews, extends, expands or loses a contract; forms a
   delivery or technology partnership with a named partner or client;
   acquires, merges or divests; launches an offering or opens a delivery
   centre; changes senior leadership or restructures; or reports its own
   financial results or guidance.
   - A stock note, opinion piece, listicle or analyst commentary that
     nonetheless reports such an event COUNTS: classify the event it reports,
     not the article's genre. A finance-site write-up of the vendor's own
     quarterly or annual results, guidance or dividend IS FINANCIAL_RESULTS.
   - Only the listed entity itself counts — not a parent, sister company or
     similarly named firm (NTT Docomo is not NTT DATA; Tata Motors is not TCS;
     Hitachi Energy is not Hitachi Digital Services). For Deloitte, EY, PwC and
     KPMG, audit, tax and assurance engagements do not count; consulting,
     technology, digital and managed-services work does.
   - NO event: the vendor is mentioned in passing; sponsorships and CSR —
     a sponsor, "official partner" or "technology partner" arrangement with a
     sports club, event, team or celebrity is a SPONSORSHIP, not a partnership,
     unless the vendor delivers technology or services to that organisation as
     a client; industry awards and analyst rankings; research reports and
     thought leadership; conference appearances; job ads and people profiles;
     securities filings, buybacks and fund stake changes; share-price
     commentary that reports no deal; a tender or RFP not yet awarded;
     criticism or scrutiny of an existing contract with no new award;
     vendor case studies, customer stories and marketing pages describing
     work already delivered (undated, client often unnamed — collateral, not
     news of an award); a tracked vendor BUYING goods or services from another
     supplier (that is the supplier's win, not the vendor's).
     Then family = "EXCLUDED" (never put a status word in "family").
3. What is the STATUS of the event? "announced" (a new award, deal, launch or
   appointment), "completed" (closed, delivered, go-live), "opportunity"
   (tender, RFP, bid, shortlist — not yet awarded), "terminated" (ended,
   cancelled, insourced, lost), "disputed" (criticism, investigation, legal
   action about an existing contract), "none".
4. Who are the parties? "vendorRaw" MUST be spelled EXACTLY as in the list
   (e.g. "TCS", not "Tata Consultancy Services Ltd"); the other party — client,
   target, partner — goes in "clientRaw". When the text does not name it,
   put the text's own description in "clientDescriptor" ("a leading European
   automotive OEM", "a US regional bank") and leave clientRaw null. Never
   invent a link to a tracked vendor.`;

const ARTICLE_TYPES = "announcement|news_report|stock_or_analyst_note|opinion_or_thought_leadership|listicle_or_roundup|tender_or_rfp|award_or_ranking|sponsorship_or_csr|research_or_report|case_study_or_marketing|event_or_webinar|job_or_people_profile|other";
const EVENT_STATUSES = "announced|completed|opportunity|terminated|disputed|none";
/** Article types that cannot carry a market event, whatever family the model chose. */
const NON_EVENT_TYPES = new Set(["sponsorship_or_csr", "award_or_ranking", "research_or_report", "case_study_or_marketing", "job_or_people_profile", "event_or_webinar"]);
const STATUS_WORDS = new Set(["ANNOUNCED", "COMPLETED", "OPPORTUNITY", "TERMINATED", "DISPUTED", "NONE"]);

/**
 * Normalise the model's family / status / type trio. Haiku sometimes writes
 * the status into "family" ("DISPUTED"), and a sponsorship occasionally comes
 * back as a "technology partnership"; both are settled here, not by regex.
 */
function normaliseReading(famIn: string | null, statusIn: string | null, typeIn: string | null): { family: string; eventStatus: string | null; articleType: string | null; reason: string | null } {
  let family = (famIn ?? "EXCLUDED").toUpperCase();
  let eventStatus = statusIn?.toLowerCase() ?? null;
  const articleType = typeIn?.toLowerCase() ?? null;
  if (STATUS_WORDS.has(family)) { eventStatus = eventStatus ?? family.toLowerCase(); family = "EXCLUDED"; return { family, eventStatus, articleType, reason: `model:${eventStatus}_contract` }; }
  if (family !== "EXCLUDED" && !CANONICAL_FAMILIES.has(family)) return { family: "EXCLUDED", eventStatus, articleType, reason: `model:invalid_family:${family.slice(0, 40)}` };
  if (family !== "EXCLUDED" && articleType && NON_EVENT_TYPES.has(articleType)) return { family: "EXCLUDED", eventStatus, articleType, reason: `model:${articleType}` };
  if (family === "EXCLUDED") return { family, eventStatus, articleType, reason: `model:${(articleType ?? "no_event").slice(0, 40)}` };
  return { family, eventStatus, articleType, reason: null };
}

const EXTRACTION_SYSTEM = `You are a senior IT-services market analyst coding events for a competitive-intelligence platform used by enterprise sales teams. Your output must be thorough and commercially actionable.

TRACKED VENDOR UNIVERSE — the ${TRACKED_VENDORS.length} providers this platform covers:
${VENDOR_UNIVERSE}

${READING_RULES}

Extraction rules:
5. Extract ALL structured data the text supports. "eventType" MUST be one of
   the types listed for the chosen family in the schema — do not invent types.
6. CONTRACT VALUE. Return tcvUsd ONLY when the text states a monetary value
   for this contract ("valued at $120 million", "a £80 million agreement");
   convert to USD. Never put an estimate in tcvUsd. When NO value is stated,
   ESTIMATE a plausible range: tcvEstimateLowUsd / tcvEstimateHighUsd (USD,
   typically a 2–4x band) with tcvEstimateRationale (≤25 words: scope, term,
   client size, geography, comparable deals), and set tcvIsEstimate = true.
   Do not derive it from the vendor's total revenue or bookings.
7. FINANCIAL_RESULTS is the vendor's OWN earnings, results, guidance or
   bookings; set tcvUsd to a disclosed bookings/TCV figure if one is stated.
8. Analyst insight: 3–5 sentences of ACTIONABLE competitive intelligence —
   market position, which named competitors should be concerned, the client
   or industry pattern, follow-on opportunities.
9. Summary: the key facts in 2–3 sentences for a busy executive.
10. Return JSON only — no prose, no markdown fences.`;

const EXTRACTION_SCHEMA = `{
  "articleType": "${ARTICLE_TYPES}",
  "eventStatus": "${EVENT_STATUSES}",
  "family": "CONTRACT|FINANCIAL_RESULTS|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "eventType": "one of the family's types — ${Object.entries(FAMILY_EVENT_TYPES).map(([f, ts]) => `${f}: ${ts.join("|")}`).join("; ")}; EXCLUDED: excluded_noise",
  "why": "≤15 words: what the article is and why it is or is not an event",
  "canonicalTitle": "concise title, max 120 chars — format: Vendor | EventType | Client | ServiceLine",
  "vendorRaw": "MUST be one of the TRACKED VENDORS, spelled exactly as listed; null if none is a party",
  "clientRaw": "client / target / partner organisation NAME, or null when not named",
  "clientDescriptor": "when clientRaw is null: the text's description of the counterparty, or null",
  "tcvUsd": "number in USD — ONLY if explicitly stated in the text; null otherwise. Never an estimate.",
  "tcvEstimateLowUsd": "number in USD or null — low end of a plausible range when no value is stated",
  "tcvEstimateHighUsd": "number in USD or null — high end of that range",
  "tcvEstimateRationale": "≤25 words on what the range rests on, or null",
  "tcvIsEstimate": "true when tcvUsd is null and an estimate range is given; false otherwise",
  "contractLengthMonths": "integer months when a term is stated ('four years' → 48, 'through 2030' → months remaining), else null",
  "primaryMacroServiceLine": "ITO|Application Services|Digital & Cloud|BPO|Cybersecurity|AI & Analytics|Consulting & Advisory|ERP & Enterprise Apps|Network & Telco|Engineering IT|null",
  "geography": ["array of countries/regions mentioned"],
  "industry": "BFSI|Public Sector|Healthcare & Life Sciences|Telecommunications|Manufacturing & Automotive|Retail|Aerospace & Defence|Energy & Resources|Insurance|Technology|Transportation & Logistics|Media & Entertainment|Education|null",
  "confidenceScore": "0.0-1.0 — confidence that the family, parties and status are right",
  "summary": "2-3 sentence factual summary of the event for an executive audience",
  "analystInsight": "3-5 sentences of competitive intelligence naming specific competitor vendors where relevant",
  "missingCritical": ["fields that could not be determined"]
}`;

const TRIAGE_SCHEMA = `{
  "articleType": "${ARTICLE_TYPES}",
  "family": "CONTRACT|FINANCIAL_RESULTS|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "eventStatus": "${EVENT_STATUSES}",
  "vendorRaw": "one of the TRACKED VENDORS, spelled exactly as listed; null if none is a party",
  "clientRaw": "counterparty organisation NAME (client, target, partner) or null when not named",
  "clientDescriptor": "when clientRaw is null: the text's description of the counterparty, or null",
  "canonicalTitle": "concise title, max 120 chars",
  "confidenceScore": "0.0-1.0 — confidence that the family and parties are right",
  "why": "≤15 words"
}`;

const TRIAGE_SYSTEM = `You are an IT-services market analyst reading news for a competitive-intelligence platform. Be decisive.

TRACKED VENDOR UNIVERSE — the ${TRACKED_VENDORS.length} providers this platform covers:
${VENDOR_UNIVERSE}

${READING_RULES}

Return JSON only — no prose, no markdown fences.`;

interface ClaudeCall { parsed: Record<string, unknown> | null; usage: TokenUsage; }

/** One Messages API call, returning parsed JSON plus real token spend. */
/**
 * Anthropic requires a cacheable prefix of roughly 1024 tokens; shorter
 * prefixes are silently not cached. The analysis system prompt clears this
 * (~1.3k tokens) but the triage one does not (~0.8k), so caching is applied
 * only where it actually pays. Measured effect on the analysis prompt: input
 * billed drops from 1603 tokens to 33 + 1570 cache-read at 0.1x.
 */
// ~2.16 chars/token measured on this prompt, so 2500 chars is ~1150 tokens —
// comfortably over the ~1024 minimum while still excluding the shorter triage
// prompt (~1800 chars), which would never cache and would only add overhead.
// An earlier value of 4000 silently disabled caching entirely: the analysis
// prompt is ~3465 chars at runtime, so the condition never fired.
const CACHEABLE_PREFIX_CHARS = 2500;

async function callClaude(
  model: string, system: string, prompt: string, maxTokens: number, tier: string,
): Promise<ClaudeCall> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { parsed: null, usage: EMPTY_USAGE };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        // A cache breakpoint needs `system` as an array of content blocks.
        // The prompt is static per process, so the prefix stays byte-identical
        // across calls and the cache actually hits.
        system: system.length >= CACHEABLE_PREFIX_CHARS
          ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
          : system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { parsed: null, usage: EMPTY_USAGE };
    const data = await res.json() as {
      content?: Array<{ type: string; text: string }>;
      usage?: {
        input_tokens?: number; output_tokens?: number;
        cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
      };
    };
    // Bill actual usage even if the body fails to parse — the tokens were spent.
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const cacheWriteTokens = data.usage?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = data.usage?.cache_read_input_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
      costUsd: costOf(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens),
      tiers: [tier],
    };
    // Take the first TEXT block, not content[0]: newer models can emit a
    // leading non-text block (e.g. thinking), and indexing blindly yields
    // undefined, which silently drops the extraction back to rule-based output.
    const text = (data.content ?? []).find(b => b?.type === "text")?.text ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return { parsed: null, usage };
    try {
      return { parsed: JSON.parse(jsonMatch[0]), usage };
    } catch {
      return { parsed: null, usage };
    }
  } catch {
    return { parsed: null, usage: EMPTY_USAGE };
  }
}

function articlePrompt(article: RawArticle, schema: string): string {
  // The publisher text, when the pipeline could fetch it. Google News items
  // carry no usable snippet (it is the redirect link), so without this the
  // model was classifying and valuing events from a headline.
  const body = article.bodyText?.trim();
  const evidence = body
    ? `Article text (truncated):\n${body}`
    : `Snippet: ${article.snippet ?? "(no snippet available)"}`;
  return `Article title: ${article.title}
Source: ${article.provider} (${article.sourceType})
Published: ${article.publishedAt ?? "unknown"}
${evidence}

Extract and return this JSON schema:
${schema}`;
}

/** Legacy single-call path (llmExtract) still limits the deep tier to these; the pipeline analyses every in-scope family. */
const HIGH_VALUE_FAMILIES = new Set(["CONTRACT", "M_AND_A"]);

/** Outcome of the cheap triage pass — enough to dedupe on, before paying for analysis. */
export interface TriageResult {
  family: string;
  vendorRaw: string | null;
  clientRaw: string | null;
  canonicalTitle: string;
  confidenceScore: number;
  usage: TokenUsage;
  /** True when this article warrants the analysis tier (every in-scope family). */
  needsAnalysis: boolean;
  /** "model:<articleType>" | "model:no_tracked_vendor" | "model:invalid_family:X"; null when in scope. */
  exclusionReason: string | null;
  articleType: string | null;
  eventStatus: string | null;
  why: string | null;
  /** The text's description of an unnamed counterparty ("a leading European automotive OEM"). */
  clientDescriptor: string | null;
}

/**
 * PHASE 1 — EXTRACT. Cheap structured facts only.
 *
 * Kept separate from analysis so the pipeline can dedupe on the extracted
 * entities BEFORE spending on the analysis tier. Several articles routinely
 * describe one event; measured on the estate, 13.6% of analysis-tier calls were
 * redundant by (family, party A, party B, date). Deduping on entities is also
 * far more precise than the title-similarity pass it supersedes.
 */
export async function triageArticle(article: RawArticle): Promise<TriageResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const triage = await callClaude(
    MODEL_TIERS.triage, TRIAGE_SYSTEM, articlePrompt(article, TRIAGE_SCHEMA), 400, "triage",
  );
  if (!triage.parsed) return null;
  const t = triage.parsed as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const vendorRaw = str(t.vendorRaw);
  const r = normaliseReading(str(t.family), str(t.eventStatus), str(t.articleType));
  const { articleType, eventStatus } = r;
  const inScope = r.family !== "EXCLUDED" && !!vendorRaw;
  // The reason names the article type the model saw, so exclusion metrics say why.
  const exclusionReason = inScope ? null : (r.reason ?? "model:no_tracked_vendor");
  return {
    family: inScope ? r.family : "EXCLUDED",
    vendorRaw: inScope ? vendorRaw : null,
    clientRaw: str(t.clientRaw),
    clientDescriptor: str(t.clientDescriptor),
    canonicalTitle: str(t.canonicalTitle) ?? article.title,
    confidenceScore: typeof t.confidenceScore === "number" ? t.confidenceScore : 0.5,
    usage: triage.usage,
    // Every in-scope article gets the full read — partnerships, launches and
    // leadership changes carry counterparties and detail worth extracting too.
    needsAnalysis: inScope,
    exclusionReason,
    articleType, eventStatus, why: str(t.why),
  };
}

/** Build the ExtractionResult for an article that stops after triage. */
export function resultFromTriage(article: RawArticle, t: TriageResult): ExtractionResult {
  if (t.family === "EXCLUDED") {
    return {
      family: "EXCLUDED", eventType: "excluded_noise", canonicalTitle: t.canonicalTitle,
      vendorRaw: null, clientRaw: null, tcvUsd: null, tcvIsEstimate: false,
      contractLengthMonths: null, primaryMacroServiceLine: null, geography: [],
      industry: null, confidenceScore: t.confidenceScore, extractionMethod: "llm",
      summary: null, analystInsight: null, missingCritical: [],
      eventTypeValid: false, exclusionReason: t.exclusionReason ?? "model:excluded_noise", usage: t.usage,
    };
  }
  const rules = ruleBasedExtract(article);
  return {
    ...rules,
    family: t.family,
    eventType: defaultEventType(t.family, `${article.title} ${article.snippet ?? ""}`),
    eventTypeValid: true,
    exclusionReason: null,
    articleType: t.articleType,
    eventStatus: t.eventStatus,
    clientDescriptor: t.clientDescriptor,
    vendorRaw: t.vendorRaw,
    clientRaw: t.clientRaw,
    canonicalTitle: t.canonicalTitle,
    confidenceScore: t.confidenceScore,
    extractionMethod: "llm",
    usage: t.usage,
  };
}

/**
 * PHASE 3 — ANALYSE. The expensive tier, run only on survivors of dedup so a
 * contract is analysed on its own evidence exactly once.
 */
export async function analyseArticle(article: RawArticle, t: TriageResult): Promise<ExtractionResult> {
  const deep = await callClaude(
    MODEL_TIERS.analysis, EXTRACTION_SYSTEM, articlePrompt(article, EXTRACTION_SCHEMA), 1200, "analysis",
  );
  // Reports the ANALYSIS spend only. Triage was already accounted for when it
  // ran in phase 1; summing both here would double-count it.
  const usage = deep.usage;
  if (!deep.parsed) {
    // Analysis failed — keep the triage classification rather than losing the event.
    return { ...resultFromTriage(article, t), usage };
  }
  const parsed = deep.parsed as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const text = `${article.title} ${article.snippet ?? ""}`;
  const r = normaliseReading(str(parsed.family) ?? t.family, str(parsed.eventStatus) ?? t.eventStatus, str(parsed.articleType) ?? t.articleType);
  const family = r.family;
  const eventType = family === "EXCLUDED" ? "excluded_noise" : (str(parsed.eventType) ?? defaultEventType(family, text));
  return {
    family,
    eventType,
    eventTypeValid: family !== "EXCLUDED" && isValidEventType(family, eventType),
    exclusionReason: r.reason,
    articleType: r.articleType,
    eventStatus: r.eventStatus,
    canonicalTitle: str(parsed.canonicalTitle) ?? article.title,
    vendorRaw: str(parsed.vendorRaw) ?? t.vendorRaw,
    clientRaw: str(parsed.clientRaw) ?? t.clientRaw,
    clientDescriptor: str(parsed.clientDescriptor) ?? t.clientDescriptor,
    tcvUsd: num(parsed.tcvUsd),
    tcvIsEstimate: parsed.tcvIsEstimate === true,
    ...estimateRange(parsed),
    contractLengthMonths: num(parsed.contractLengthMonths),
    primaryMacroServiceLine: str(parsed.primaryMacroServiceLine),
    geography: Array.isArray(parsed.geography) ? (parsed.geography as string[]) : [],
    industry: str(parsed.industry),
    confidenceScore: num(parsed.confidenceScore) ?? 0.6,
    extractionMethod: "llm",
    summary: str(parsed.summary),
    analystInsight: str(parsed.analystInsight),
    missingCritical: Array.isArray(parsed.missingCritical) ? (parsed.missingCritical as string[]) : [],
    usage,
  };
}

/** The model's estimate range, only when it is a sane pair (positive, low ≤ high). */
function estimateRange(parsed: Record<string, unknown>) {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  let low = n(parsed.tcvEstimateLowUsd), high = n(parsed.tcvEstimateHighUsd);
  if (low && high && low > high) [low, high] = [high, low];
  if (!low || !high) return { tcvEstimateLowUsd: null, tcvEstimateHighUsd: null, tcvEstimateRationale: null };
  return { tcvEstimateLowUsd: low, tcvEstimateHighUsd: high, tcvEstimateRationale: typeof parsed.tcvEstimateRationale === "string" ? parsed.tcvEstimateRationale.slice(0, 200) : null };
}

export async function llmExtract(article: RawArticle): Promise<ExtractionResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const text = `${article.title} ${article.snippet ?? ""}`;

  // ── Tier 1: cheap triage ───────────────────────────────────────────────────
  const triage = await callClaude(
    MODEL_TIERS.triage, TRIAGE_SYSTEM, articlePrompt(article, TRIAGE_SCHEMA), 400, "triage",
  );
  if (!triage.parsed) return null;

  const t = triage.parsed as Record<string, unknown>;
  const family = typeof t.family === "string" ? t.family : "EXCLUDED";
  const vendorRaw = typeof t.vendorRaw === "string" ? t.vendorRaw : null;

  // Out of scope, or no tracked vendor — stop here. This is the saving.
  if (family === "EXCLUDED" || !vendorRaw) {
    return {
      family: "EXCLUDED", eventType: "excluded_noise",
      canonicalTitle: typeof t.canonicalTitle === "string" ? t.canonicalTitle : article.title,
      vendorRaw: null, clientRaw: null, tcvUsd: null, tcvIsEstimate: false,
      contractLengthMonths: null, primaryMacroServiceLine: null, geography: [],
      industry: null, confidenceScore: typeof t.confidenceScore === "number" ? t.confidenceScore : 0.5,
      extractionMethod: "llm", summary: null, analystInsight: null, missingCritical: [],
      eventTypeValid: false,
      exclusionReason: family === "EXCLUDED" ? "model:excluded_noise" : "model:no_tracked_vendor",
      usage: triage.usage,
    };
  }

  // Lower-value families keep the cheap result rather than paying for analysis.
  if (!HIGH_VALUE_FAMILIES.has(family)) {
    const rules = ruleBasedExtract(article);
    return {
      ...rules,
      family,
      eventType: defaultEventType(family, text),
      eventTypeValid: true,
      exclusionReason: null,
      vendorRaw,
      clientRaw: typeof t.clientRaw === "string" ? t.clientRaw : null,
      canonicalTitle: typeof t.canonicalTitle === "string" ? t.canonicalTitle : article.title,
      confidenceScore: typeof t.confidenceScore === "number" ? t.confidenceScore : 0.6,
      extractionMethod: "llm",
      usage: triage.usage,
    };
  }

  // ── Tier 2: deep analysis for contracts and M&A ────────────────────────────
  const deep = await callClaude(
    MODEL_TIERS.analysis, EXTRACTION_SYSTEM, articlePrompt(article, EXTRACTION_SCHEMA), 1200, "analysis",
  );
  const usage = addUsage(triage.usage, deep.usage);
  if (!deep.parsed) {
    // Analysis failed — keep the triage classification rather than losing the event.
    const rules = ruleBasedExtract(article);
    return {
      ...rules, family, vendorRaw, extractionMethod: "llm", usage,
      eventType: defaultEventType(family, text), eventTypeValid: true, exclusionReason: null,
    };
  }

  const parsed = deep.parsed as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const famRaw = str(parsed.family) ?? family;
  const fam = CANONICAL_FAMILIES.has(famRaw) ? famRaw : "EXCLUDED";
  const et = fam === "EXCLUDED" ? "excluded_noise" : (str(parsed.eventType) ?? defaultEventType(fam, text));
  return {
    family: fam,
    eventType: et,
    eventTypeValid: fam !== "EXCLUDED" && isValidEventType(fam, et),
    exclusionReason: fam !== "EXCLUDED" ? null
      : famRaw === "EXCLUDED" ? "model:excluded_noise" : `model:invalid_family:${famRaw.slice(0, 40)}`,
    canonicalTitle: str(parsed.canonicalTitle) ?? article.title,
    vendorRaw: str(parsed.vendorRaw) ?? vendorRaw,
    clientRaw: str(parsed.clientRaw),
    tcvUsd: num(parsed.tcvUsd),
    tcvIsEstimate: parsed.tcvIsEstimate === true,
    ...estimateRange(parsed),
    contractLengthMonths: num(parsed.contractLengthMonths),
    primaryMacroServiceLine: str(parsed.primaryMacroServiceLine),
    geography: Array.isArray(parsed.geography) ? (parsed.geography as string[]) : [],
    industry: str(parsed.industry),
    confidenceScore: num(parsed.confidenceScore) ?? 0.6,
    extractionMethod: "llm",
    summary: str(parsed.summary),
    analystInsight: str(parsed.analystInsight),
    missingCritical: Array.isArray(parsed.missingCritical) ? (parsed.missingCritical as string[]) : [],
    usage,
  };
}

export async function extractArticle(article: RawArticle): Promise<ExtractionResult> {
  const llmResult = await llmExtract(article);
  if (llmResult) return llmResult;
  const rules = ruleBasedExtract(article);
  return { ...rules, extractionMethod: process.env.ANTHROPIC_API_KEY ? "rule_fallback" : "rules" };
}
