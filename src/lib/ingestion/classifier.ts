import { RawArticle } from "./crawler";
import { isRelevantArticle } from "./sources";

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
  analystInsight: string | null;
  missingCritical: string[];
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
      analystInsight: null, missingCritical: [],
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
  if (/\brenew|extension|extend\b/i.test(text)) eventType = "renewal";
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
    extractionMethod: "rules", analystInsight: null, missingCritical,
  };
}

// ── LLM extraction (requires ANTHROPIC_API_KEY) ───────────────────────────────

const EXTRACTION_SYSTEM = `You are coding an IT services market event for a market intelligence product.
Use only the supplied text. Do not invent missing data. Return JSON only — no prose, no markdown.
Hard rules:
- Do not infer TCV unless explicitly stated with a number and currency.
- Null is preferred over a guess.
- Do not treat a partnership as a contract unless there is evidence of a signed deal with a client.
- Do not include financial results or earnings announcements.`;

const EXTRACTION_SCHEMA = `{
  "family": "CONTRACT|M_AND_A|PARTNERSHIP|NEW_OFFERING|ORG_CHANGE|EXCLUDED",
  "eventType": "new_win|renewal|extension|expansion|rebid_win|incumbent_displacement|framework_award|acquisition|merger|divestiture|technology_alliance|co_delivery_agreement|service_launch|platform_launch|delivery_centre_opening|leadership_appointment|leadership_departure|restructuring|strategic_transformation|excluded_financial_results|excluded_noise",
  "canonicalTitle": "concise title, max 120 chars",
  "vendorRaw": "vendor name or null",
  "clientRaw": "client name or null (null if anonymised)",
  "tcvUsd": "number in USD (null if not stated)",
  "tcvIsEstimate": false,
  "contractLengthMonths": "integer or null",
  "primaryMacroServiceLine": "ITO|Application Services|Digital & Cloud|BPO|Cybersecurity|AI & Analytics|Consulting & Advisory|ERP & Enterprise Apps|Network & Telco|Engineering IT|null",
  "geography": ["array of countries/regions"],
  "industry": "BFSI|Public Sector|Healthcare & Life Sciences|Telecommunications|Manufacturing & Automotive|Retail|Aerospace & Defence|Energy & Resources|Insurance|Technology|null",
  "confidenceScore": 0.0,
  "analystInsight": "1-2 sentence market context, or null if insufficient evidence",
  "missingCritical": ["vendor", "client", "tcv"]
}`;

export async function llmExtract(article: RawArticle): Promise<ExtractionResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const prompt = `Article title: ${article.title}
Source: ${article.provider} (${article.sourceType})
Published: ${article.publishedAt ?? "unknown"}
Snippet: ${article.snippet ?? "(no snippet available)"}

Extract and return this JSON schema:
${EXTRACTION_SCHEMA}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: EXTRACTION_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    const text = data.content?.[0]?.text ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      family: parsed.family ?? "CONTRACT",
      eventType: parsed.eventType ?? "new_win",
      canonicalTitle: parsed.canonicalTitle ?? article.title,
      vendorRaw: parsed.vendorRaw ?? null,
      clientRaw: parsed.clientRaw ?? null,
      tcvUsd: typeof parsed.tcvUsd === "number" ? parsed.tcvUsd : null,
      tcvIsEstimate: parsed.tcvIsEstimate ?? false,
      contractLengthMonths: typeof parsed.contractLengthMonths === "number" ? parsed.contractLengthMonths : null,
      primaryMacroServiceLine: parsed.primaryMacroServiceLine ?? null,
      geography: Array.isArray(parsed.geography) ? parsed.geography : [],
      industry: parsed.industry ?? null,
      confidenceScore: typeof parsed.confidenceScore === "number" ? parsed.confidenceScore : 0.6,
      extractionMethod: "llm",
      analystInsight: parsed.analystInsight ?? null,
      missingCritical: Array.isArray(parsed.missingCritical) ? parsed.missingCritical : [],
    };
  } catch {
    return null;
  }
}

export async function extractArticle(article: RawArticle): Promise<ExtractionResult> {
  const llmResult = await llmExtract(article);
  if (llmResult) return llmResult;
  const rules = ruleBasedExtract(article);
  return { ...rules, extractionMethod: process.env.ANTHROPIC_API_KEY ? "rule_fallback" : "rules" };
}
