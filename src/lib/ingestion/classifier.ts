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
  /** Deeper reasoning for TCV estimation and competitive analyst insight. */
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

export function costOf(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model];
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.inputPerM + (outputTokens / 1_000_000) * p.outputPerM;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Which tiers actually ran, e.g. ["triage"] or ["triage","analysis"]. */
  tiers: string[];
}

export const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, tiers: [] };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
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
  /** Actual token spend for this article (zero for rule-based results). */
  usage: TokenUsage;
}

// ── Rule-based extraction (always available, no API key required) ─────────────

export function ruleBasedExtract(article: RawArticle): ExtractionResult {
  const text = `${article.title} ${article.snippet ?? ""}`;
  const { relevant, family } = isRelevantArticle(article.title, article.sourceType);

  if (!relevant) {
    return {
      family: "EXCLUDED", eventType: "excluded_noise", canonicalTitle: article.title,
      vendorRaw: null, clientRaw: null, tcvUsd: null, tcvIsEstimate: false,
      contractLengthMonths: null, primaryMacroServiceLine: null, geography: [],
      industry: null, confidenceScore: 0.1, extractionMethod: "rules",
      summary: null, analystInsight: null, missingCritical: [], usage: EMPTY_USAGE,
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
  let tcvIsEstimate = true;
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

  // Event type
  let eventType = "new_win";
  if (family === "FINANCIAL_RESULTS") eventType = "financial_announcement";
  else if (/\brenew|extension|extend\b/i.test(text)) eventType = "renewal";
  else if (/\bextend|extension\b/i.test(text)) eventType = "extension";
  else if (/\bacquir|merger\b/i.test(text)) eventType = "acquisition";
  else if (/\bpartner|alliance\b/i.test(text)) eventType = "technology_alliance";
  else if (/\bappoint|hire|names?\b/i.test(text)) eventType = "leadership_appointment";

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
    extractionMethod: "rules", summary: null, analystInsight: null, missingCritical, usage: EMPTY_USAGE,
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
   invent a link to a tracked vendor.
   "vendorRaw" MUST be written EXACTLY as spelled in the list above (e.g. "TCS",
   not "Tata Consultancy Services Ltd"; "HCLTech", not "HCL Technologies") so it
   resolves against our entity records. If the article names a non-tracked firm
   as the counterparty, put that name in clientRaw, not vendorRaw.
1. Extract ALL available structured data from the text.
2. TCV ESTIMATION: If TCV is not explicitly stated, ESTIMATE it based on deal characteristics:
   - Use industry benchmarks: avg IT outsourcing deal = $50-200M, BPO = $20-80M, consulting = $5-30M
   - Factor in: contract length, client size (Fortune 500 = larger), service scope, geography
   - Mark tcvIsEstimate=true when estimating. A reasonable estimate is better than null.
3. Analyst insight must be 3-5 sentences of ACTIONABLE competitive intelligence:
   - What does this mean for the vendor's market position?
   - Which competitors should be concerned? Name specific rival vendors.
   - What client pattern or industry trend does this signal?
   - What follow-on opportunities might exist?
4. Summary must capture the key facts in 2-3 sentences for a busy executive.
5. FINANCIAL_RESULTS is a tracked category — classify earnings, quarterly/annual
   results, guidance updates and bookings/TCV disclosures as FINANCIAL_RESULTS.
   Do NOT discard them. For these, set tcvUsd to the disclosed bookings/TCV
   figure when one is stated, otherwise null (do NOT estimate a TCV from
   revenue). If an article is primarily about a specific deal or acquisition,
   prefer CONTRACT / M_AND_A over FINANCIAL_RESULTS.
   Still exclude analyst-firm rankings (Gartner/Forrester), marketing and
   thought-leadership pieces as EXCLUDED.
6. Return JSON only — no prose, no markdown fences.`;

const EXTRACTION_SCHEMA = `{
  "family": "CONTRACT|FINANCIAL_RESULTS|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "eventType": "new_win|renewal|extension|expansion|rebid_win|incumbent_displacement|framework_award|acquisition|merger|divestiture|technology_alliance|co_delivery_agreement|service_launch|platform_launch|delivery_centre_opening|leadership_appointment|leadership_departure|restructuring|strategic_transformation|financial_announcement|quarterly_results|annual_results|guidance_update|bookings_update|segment_performance|excluded_noise",
  "canonicalTitle": "concise title, max 120 chars — format: Vendor | EventType | Client | ServiceLine",
  "vendorRaw": "MUST be one of the TRACKED VENDORS, spelled exactly as listed; null if none involved",
  "clientRaw": "client/buyer organisation name or null",
  "tcvUsd": "number in USD — estimate if not stated, using deal size indicators",
  "tcvIsEstimate": "true if estimated, false if explicitly stated",
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
2. "vendorRaw" MUST be spelled EXACTLY as in the list above (e.g. "TCS", not
   "Tata Consultancy Services Ltd"). A non-tracked counterparty goes in clientRaw.
3. Classify earnings/results/guidance as FINANCIAL_RESULTS — do not discard them.
   Exclude analyst-firm rankings, marketing and thought-leadership as EXCLUDED.
4. Return JSON only — no prose, no markdown fences.`;

interface ClaudeCall { parsed: Record<string, unknown> | null; usage: TokenUsage; }

/** One Messages API call, returning parsed JSON plus real token spend. */
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
        system,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { parsed: null, usage: EMPTY_USAGE };
    const data = await res.json() as {
      content?: Array<{ type: string; text: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    // Bill actual usage even if the body fails to parse — the tokens were spent.
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const usage: TokenUsage = {
      inputTokens, outputTokens, costUsd: costOf(model, inputTokens, outputTokens), tiers: [tier],
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
  return `Article title: ${article.title}
Source: ${article.provider} (${article.sourceType})
Published: ${article.publishedAt ?? "unknown"}
Snippet: ${article.snippet ?? "(no snippet available)"}

Extract and return this JSON schema:
${schema}`;
}

/** Families worth paying the deeper analysis model for. */
const HIGH_VALUE_FAMILIES = new Set(["CONTRACT", "M_AND_A"]);

export async function llmExtract(article: RawArticle): Promise<ExtractionResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

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
      usage: triage.usage,
    };
  }

  // Lower-value families keep the cheap result rather than paying for analysis.
  if (!HIGH_VALUE_FAMILIES.has(family)) {
    const rules = ruleBasedExtract(article);
    return {
      ...rules,
      family,
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
    return { ...rules, family, vendorRaw, extractionMethod: "llm", usage };
  }

  const parsed = deep.parsed as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    family: str(parsed.family) ?? family,
    eventType: str(parsed.eventType) ?? "new_win",
    canonicalTitle: str(parsed.canonicalTitle) ?? article.title,
    vendorRaw: str(parsed.vendorRaw) ?? vendorRaw,
    clientRaw: str(parsed.clientRaw),
    tcvUsd: num(parsed.tcvUsd),
    tcvIsEstimate: parsed.tcvIsEstimate === true,
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
