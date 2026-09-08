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
  extractionMethod: "llm" | "rules" | "rule_fallback";
  summary: string | null;
  analystInsight: string | null;
  missingCritical: string[];
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
  CONTRACT: ["new_win", "renewal", "extension", "expansion", "rebid_win", "incumbent_displacement", "framework_award"],
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
    industry, confidenceScore: Math.min(confidenceScore, 0.89),
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

const EXTRACTION_SYSTEM = `You are a senior IT services market analyst coding events for a competitive intelligence platform used by enterprise sales teams. Your output must be thorough and commercially actionable.

TRACKED VENDOR UNIVERSE — the ${TRACKED_VENDORS.length} providers this platform covers:
${VENDOR_UNIVERSE}

Rules:
0. SCOPE: an event only matters if one of the TRACKED VENDORS above is a party to
   it (as provider, acquirer, target, or partner). If no tracked vendor is
   involved, return family "EXCLUDED" with eventType "excluded_noise" — do not
   invent a link to a tracked vendor. Only the listed entity itself counts —
   not a parent, sister company or similarly named firm (NTT Docomo and NTT
   Communications are not NTT DATA; Tata Motors is not TCS; Hitachi Energy is
   not Hitachi Digital Services). For Deloitte, EY, PwC and KPMG only
   technology, consulting and managed-services work counts; audit, tax,
   assurance, deal-advisory and corporate-finance mandates are EXCLUDED.
   A CONTRACT requires the tracked vendor to be the PROVIDER. When the tracked
   vendor is the buyer of hardware, software or services, return EXCLUDED.
   ORG_CHANGE is a change at the tracked vendor itself; a former employee's
   appointment elsewhere is EXCLUDED. For telecom groups tracked for their IT
   arms (Singtel/NCS, Orange Business, T-Systems, Telefónica Tech), consumer
   products, network news and sponsorships are EXCLUDED.
   "vendorRaw" MUST be written EXACTLY as spelled in the list above (e.g. "TCS",
   not "Tata Consultancy Services Ltd"; "HCLTech", not "HCL Technologies") so it
   resolves against our entity records. If the article names a non-tracked firm
   as the counterparty, put that name in clientRaw, not vendorRaw.
1. Extract ALL available structured data from the text.
2. CONTRACT VALUE. Return tcvUsd ONLY when the evidence explicitly states a
   monetary value for this contract ("valued at $120 million", "a £80 million
   agreement"); convert to USD. Never put an estimate in tcvUsd.
   When NO value is stated, ESTIMATE a plausible range instead: set
   tcvEstimateLowUsd / tcvEstimateHighUsd (USD, low ≤ high, typically a 2–4x
   band) and tcvEstimateRationale (≤25 words: scope, term, client size,
   geography, comparable deals), and set tcvIsEstimate = true. A range for
   every contract is wanted; the UI labels it as an estimate. Do not derive it
   from the vendor's total revenue or bookings.
3. Analyst insight must be 3-5 sentences of ACTIONABLE competitive intelligence:
   - What does this mean for the vendor's market position?
   - Which competitors should be concerned? Name specific rival vendors.
   - What client pattern or industry trend does this signal?
   - What follow-on opportunities might exist?
4. Summary must capture the key facts in 2-3 sentences for a busy executive.
5. FINANCIAL_RESULTS is a tracked category — classify the company's OWN
   earnings, quarterly/annual results, guidance updates and bookings/TCV
   disclosures as FINANCIAL_RESULTS. Do NOT discard them. An article whose
   subject is the share price or stock performance is EXCLUDED even if it
   cites results — UNLESS it reports a specific deal, contract or acquisition
   ("shares jump after bagging $75M deal"): then classify that event. For these, set tcvUsd to the disclosed bookings/TCV
   figure when one is stated, otherwise null (do NOT estimate a TCV from
   revenue). If an article is primarily about a specific deal or acquisition,
   prefer CONTRACT / M_AND_A over FINANCIAL_RESULTS.
   Still exclude analyst-firm rankings (Gartner/Forrester), marketing and
   thought-leadership pieces as EXCLUDED.
6. NOT market events, even when a tracked vendor is named — return EXCLUDED:
   vendor/industry awards and analyst rankings; sponsorships (sports, arts,
   community); conference appearances, showcases and keynotes; securities
   filings, executive stock grants, buybacks and fund stake changes;
   share-price commentary and analyst ratings.
7. PARTNERSHIP requires a delivery or technology element between the vendor
   and a named partner or client (joint offering, platform alliance,
   co-delivery). A brand or sponsorship tie-up is EXCLUDED.
8. eventType MUST be one of the types listed for the chosen family in the
   schema. Do not invent types.
9. A story ABOUT an existing contract — criticism, dispute, termination,
   scrutiny, performance — is not a CONTRACT event. Return EXCLUDED, unless it
   reports a named competitor taking the work (incumbent_displacement).
10. Return JSON only — no prose, no markdown fences.`;

const EXTRACTION_SCHEMA = `{
  "family": "CONTRACT|FINANCIAL_RESULTS|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "eventType": "one of the family's types — ${Object.entries(FAMILY_EVENT_TYPES).map(([f, ts]) => `${f}: ${ts.join("|")}`).join("; ")}; EXCLUDED: excluded_noise",
  "canonicalTitle": "concise title, max 120 chars — format: Vendor | EventType | Client | ServiceLine",
  "vendorRaw": "MUST be one of the TRACKED VENDORS, spelled exactly as listed; null if none involved",
  "clientRaw": "client/buyer organisation name or null",
  "tcvUsd": "number in USD — ONLY if explicitly stated in the evidence; null otherwise. Never an estimate.",
  "tcvEstimateLowUsd": "number in USD or null — low end of a plausible range when no value is stated",
  "tcvEstimateHighUsd": "number in USD or null — high end of that range",
  "tcvEstimateRationale": "≤25 words on what the range rests on, or null",
  "tcvIsEstimate": "true when tcvUsd is null and an estimate range is given; false otherwise",
  "contractLengthMonths": "integer or null",
  "primaryMacroServiceLine": "ITO|Application Services|Digital & Cloud|BPO|Cybersecurity|AI & Analytics|Consulting & Advisory|ERP & Enterprise Apps|Network & Telco|Engineering IT|null",
  "geography": ["array of countries/regions mentioned"],
  "industry": "BFSI|Public Sector|Healthcare & Life Sciences|Telecommunications|Manufacturing & Automotive|Retail|Aerospace & Defence|Energy & Resources|Insurance|Technology|Transportation & Logistics|Media & Entertainment|Education|null",
  "confidenceScore": "0.0-1.0 — how confident you are in the extraction accuracy",
  "summary": "2-3 sentence factual summary of the deal/event for an executive audience",
  "analystInsight": "3-5 sentences of competitive intelligence: market positioning, competitor implications, industry trends, follow-on opportunities. Name specific competitor vendors where relevant.",
  "missingCritical": ["list fields that could not be determined"]
}`;

const TRIAGE_SCHEMA = `{
  "family": "CONTRACT|FINANCIAL_RESULTS|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "vendorRaw": "MUST be one of the TRACKED VENDORS, spelled exactly as listed; null if none involved",
  "clientRaw": "counterparty organisation name or null",
  "canonicalTitle": "concise title, max 120 chars",
  "confidenceScore": "0.0-1.0"
}`;

const TRIAGE_SYSTEM = `You are triaging IT services news for a competitive intelligence platform. Be fast and decisive.

TRACKED VENDOR UNIVERSE — the ${TRACKED_VENDORS.length} providers this platform covers:
${VENDOR_UNIVERSE}

Rules:
1. If no tracked vendor is a party to the event, return family "EXCLUDED".
   Only the listed entity itself counts — not a parent, sister company or
   similarly named firm (NTT Docomo is not NTT DATA; Tata Motors is not TCS).
   For Deloitte, EY, PwC and KPMG only technology, consulting and managed-
   services work counts; audit, tax, assurance and deal-advisory mandates are
   EXCLUDED. A CONTRACT needs the tracked vendor as PROVIDER — as a buyer it
   is EXCLUDED. ORG_CHANGE is a change at the vendor itself, not a former
   employee's move elsewhere. Telecom groups tracked for their IT arms
   (Singtel/NCS, Orange Business, T-Systems, Telefónica Tech): consumer
   products, network news and sponsorships are EXCLUDED.
2. "vendorRaw" MUST be spelled EXACTLY as in the list above (e.g. "TCS", not
   "Tata Consultancy Services Ltd"). A non-tracked counterparty goes in clientRaw.
3. Classify the company's OWN earnings/results/guidance announcements as
   FINANCIAL_RESULTS — do not discard them. An article whose subject is the
   share price or stock performance is EXCLUDED even if it cites results —
   UNLESS it reports a specific deal, contract or acquisition ("shares jump
   after bagging $75M deal"): then classify that event; the price move is
   incidental. Exclude analyst-firm rankings, marketing and thought-leadership.
4. NOT market events, even when a tracked vendor is named — return EXCLUDED:
   vendor/industry awards; sponsorships (sports, arts, community); conference
   appearances, showcases, keynotes; securities filings, executive stock
   grants, buybacks, fund stake changes; share-price commentary and ratings.
5. PARTNERSHIP requires a delivery or technology element between the vendor
   and a named partner or client. A brand or sponsorship tie-up is EXCLUDED.
6. A story ABOUT an existing contract (criticism, dispute, termination,
   scrutiny) is not a CONTRACT event — return EXCLUDED.
7. Return JSON only — no prose, no markdown fences.`;

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

/** Families worth paying the deeper analysis model for. */
const HIGH_VALUE_FAMILIES = new Set(["CONTRACT", "M_AND_A"]);

/** Outcome of the cheap triage pass — enough to dedupe on, before paying for analysis. */
export interface TriageResult {
  family: string;
  vendorRaw: string | null;
  clientRaw: string | null;
  canonicalTitle: string;
  confidenceScore: number;
  usage: TokenUsage;
  /** True when this article warrants the expensive analysis tier. */
  needsAnalysis: boolean;
  /** "model:excluded_noise" | "model:no_tracked_vendor" | "model:invalid_family:X"; null when in scope. */
  exclusionReason: string | null;
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
  const famRaw = typeof t.family === "string" ? t.family : "EXCLUDED";
  const vendorRaw = typeof t.vendorRaw === "string" ? t.vendorRaw : null;
  const modelExcluded = famRaw === "EXCLUDED";
  const invalidFamily = !modelExcluded && !CANONICAL_FAMILIES.has(famRaw);
  const inScope = !modelExcluded && !invalidFamily && !!vendorRaw;
  const exclusionReason = inScope ? null
    : modelExcluded ? "model:excluded_noise"
    : invalidFamily ? `model:invalid_family:${famRaw.slice(0, 40)}`
    : "model:no_tracked_vendor";
  return {
    family: inScope ? famRaw : "EXCLUDED",
    vendorRaw: inScope ? vendorRaw : null,
    clientRaw: typeof t.clientRaw === "string" ? t.clientRaw : null,
    canonicalTitle: typeof t.canonicalTitle === "string" ? t.canonicalTitle : article.title,
    confidenceScore: typeof t.confidenceScore === "number" ? t.confidenceScore : 0.5,
    usage: triage.usage,
    needsAnalysis: inScope && HIGH_VALUE_FAMILIES.has(famRaw),
    exclusionReason,
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
  // A family outside the canonical six is a model invention, not an event.
  const famRaw = str(parsed.family) ?? t.family;
  const family = CANONICAL_FAMILIES.has(famRaw) ? famRaw : "EXCLUDED";
  const eventType = family === "EXCLUDED" ? "excluded_noise" : (str(parsed.eventType) ?? defaultEventType(family, text));
  return {
    family,
    eventType,
    eventTypeValid: family !== "EXCLUDED" && isValidEventType(family, eventType),
    exclusionReason: family !== "EXCLUDED" ? null
      : famRaw === "EXCLUDED" ? "model:excluded_noise" : `model:invalid_family:${famRaw.slice(0, 40)}`,
    canonicalTitle: str(parsed.canonicalTitle) ?? article.title,
    vendorRaw: str(parsed.vendorRaw) ?? t.vendorRaw,
    clientRaw: str(parsed.clientRaw) ?? t.clientRaw,
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
