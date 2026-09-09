/**
 * Whole-article commercial-event reader (AI Delivery Mandate §3–§14).
 *
 * The model reads the ENTIRE article and returns what a competent research
 * intern would: what kind of document it is, and every commercial event it
 * reports — with the passage that supports each claim. Deterministic code owns
 * everything that is structural: segmentation of long texts, reconciliation of
 * per-segment results, verification that every quoted passage really occurs in
 * the text (grounding), value/duration parsing, identity and storage.
 *
 * Model failure is a state, not a fallback: the caller stores the article as
 * pending and retries. Nothing here ever reverts to a regex classifier.
 */
import crypto from "crypto";
import { TRACKED_VENDORS, matchTrackedVendorPreferring } from "./sources";

export const READER_MODEL = "claude-sonnet-5";
/** Bump when the reading rules or schema change — recorded on every result (§23). */
export const PROMPT_POLICY_VERSION = "reader/2.2.0-2026-09-08";

/** Segment size chosen so title + segment + schema stays well inside the model's comfortable window. */
const SEGMENT_CHARS = 11_000;
const SEGMENT_OVERLAP = 600;
const SINGLE_READ_MAX = 14_000;

export const ARTICLE_TYPES = ["NEWS_REPORT", "COMPANY_ANNOUNCEMENT", "CLIENT_ANNOUNCEMENT", "EARNINGS", "FILING", "STOCK_ANALYST_NOTE", "OPINION", "CASE_STUDY", "LISTICLE", "TENDER_RFP", "AWARD_RANKING", "SPONSORSHIP_CSR", "RESEARCH", "EVENT", "PEOPLE_PROFILE", "OTHER"] as const;
export const COMMERCIAL_EVENT_TYPES = ["NEW_WIN", "RENEWAL", "EXTENSION", "EXPANSION", "SCOPE_REDUCTION", "RECOMPETE", "COMPETITIVE_TAKEAWAY", "REPLACEMENT", "TERMINATION", "CONTRACT_CHANGE", "OTHER_COMMERCIAL_EVENT", "UNKNOWN"] as const;
export const EVENT_STATUSES = ["ANNOUNCED", "COMPLETED", "OPPORTUNITY", "TERMINATED", "DISPUTED", "UNKNOWN"] as const;
export const BUYER_SECTORS = ["PRIVATE_SECTOR", "PUBLIC_SECTOR", "STATE_OWNED_OR_MIXED", "NON_PROFIT", "UNKNOWN"] as const;
export const AI_RELEVANCE = ["EXPLICIT_AI", "AI_MATERIAL", "AI_ADJACENT", "NOT_AI_SPECIFIC", "UNKNOWN"] as const;
export const FAMILIES = ["CONTRACT", "PARTNERSHIP", "M_AND_A", "NEW_OFFERING", "ORG_CHANGE", "FINANCIAL_RESULTS"] as const;

export interface Quoted<T> { value: T; quote: string | null }

/** One commercial event as the model reported it, before grounding. */
export interface RawEventCandidate {
  family: string;
  commercialEventType: string;
  eventStatus: string;
  provider: string | null;
  buyer: string | null;
  buyerDescriptor: string | null;
  buyerSector: string;
  buyerSectorQuote: string | null;
  aiRelevance: string;
  aiRelevanceQuote: string | null;
  eventQuote: string | null;
  announcementDate: string | null;
  effectiveDate: string | null;
  contractValue: number | null;
  currency: string | null;
  valueQuote: string | null;
  valueIsTcv: boolean | null;
  acv: number | null;
  durationMonths: number | null;
  /** Agents / FTEs / seats the PROVIDER deploys (a BPO sizing fact), and a planned scale-up target */
  agentCount: number | null;
  agentTarget: number | null;
  agentQuote: string | null;
  /** Countries or cities the provider delivers FROM */
  deliveryLocations: string[];
  workType: "VOICE" | "NON_VOICE" | "SPECIALISED" | "UNKNOWN" | null;
  /** The client population the work supports ("35,000 employees", "2 million policyholders") */
  usersServed: number | null;
  usersQuote: string | null;
  /** The buyer's home country when stated */
  buyerCountry: string | null;
  durationQuote: string | null;
  renewalPeriodMonths: number | null;
  expansionValue: number | null;
  serviceScope: string | null;
  serviceLine: string | null;
  industry: string | null;
  geography: string[];
  pricingModel: string | null;
  outcomePricing: boolean | null;
  feeAtRisk: boolean | null;
  consumptionModel: boolean | null;
  commercialModelQuote: string | null;
  incumbent: string | null;
  displacedProvider: string | null;
  incumbentQuote: string | null;
  summary: string | null;
  title: string | null;
}

export interface GroundedEvent extends RawEventCandidate {
  /** claim → supporting passage that was verified to occur in the article */
  supporting: Record<string, string>;
  /** claims the model made that the text did not support and were dropped */
  dropped: string[];
}

export interface Reading {
  articleType: string;
  substantive: boolean;
  events: GroundedEvent[];
  why: string | null;
  segments: number;
  textChars: number;
  textHash: string;
  modelId: string;
  promptPolicyVersion: string;
  analysedAt: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
}

export type ReadOutcome = { ok: true; reading: Reading } | { ok: false; error: string; usage: Reading["usage"] };

const VENDOR_UNIVERSE = TRACKED_VENDORS.join(", ");

const SYSTEM = `You are a competent research analyst reading an article for an IT-services contract-intelligence study. Read the WHOLE text you are given and report what it establishes. Answer only from the text; when the text does not say, answer UNKNOWN or null.

TRACKED PROVIDERS (spell "provider" exactly as listed): ${VENDOR_UNIVERSE}

1. ARTICLE TYPE — what kind of document this is: ${ARTICLE_TYPES.join(" | ")}.
   The container is not the event: a STOCK_ANALYST_NOTE can report a contract win; a CASE_STUDY can reveal an expansion; a COMPANY_ANNOUNCEMENT can be a mere sponsorship.

2. COMMERCIAL EVENTS — list every distinct event the text reports in which a tracked provider is a PARTY (zero, one or several). For each:
   - family: CONTRACT (a client buys services from the provider), PARTNERSHIP (delivery/technology alliance), M_AND_A (the provider acquires, merges, divests), NEW_OFFERING, ORG_CHANGE (senior leadership, restructuring), FINANCIAL_RESULTS (the provider's own results/guidance).
   - commercialEventType (CONTRACT family): ${COMMERCIAL_EVENT_TYPES.join(" | ")}. Use the best-supported type; UNKNOWN beats invented precision. A client extending "its five-year relationship for another three years" is an EXTENSION with duration 3 years even if the word contract never appears. A provider replacing a named incumbent is COMPETITIVE_TAKEAWAY; name the incumbent. Other families: OTHER_COMMERCIAL_EVENT.
   - eventStatus: ${EVENT_STATUSES.join(" | ")}. A tender, RFP, bid or shortlist is OPPORTUNITY, not an award. An opportunity is ONE event for the buyer: list it once, with provider = the named incumbent if there is one (else the tracked provider the text most concerns), never one event per potential bidder. Work the text describes as already delivered, live, deployed or in production (a case study, a results write-up, a retrospective) is COMPLETED, not ANNOUNCED; ANNOUNCED is for work reported as awarded or starting.
   - provider (tracked, exact spelling) and buyer (the organisation NAME; if unnamed, put the text's description in buyerDescriptor and leave buyer null).
   - buyerSector: ${BUYER_SECTORS.join(" | ")} — judged from what the text says the buyer IS. A named commercial company (an insurer, bank, manufacturer, retailer, telecom operator, airline, pension administrator) is PRIVATE_SECTOR unless the text indicates state ownership. Governments, ministries, departments, agencies, councils, public health bodies, armed forces and public universities are PUBLIC_SECTOR. STATE_OWNED_OR_MIXED when the text says the buyer is state-owned or partly so; NON_PROFIT for charities and foundations. UNKNOWN only when the buyer's nature genuinely cannot be told from the text.
   - aiRelevance: EXPLICIT_AI (the engagement is about AI/GenAI/ML/foundation models), AI_MATERIAL (AI is a substantial part of the scope), AI_ADJACENT (AI mentioned but incidental), NOT_AI_SPECIFIC (cloud, digital, automation, ERP without AI substance), UNKNOWN. Judge by substance, not by the letters "AI".
   - NOT an event: the provider mentioned in passing; a sponsorship or naming deal whose substance is branding, hospitality or marketing rights and where the text does not have the provider delivering anything (BUT: if the provider builds, runs, hosts, supports or supplies technology, platforms or services to that club, federation, tournament or event, it IS a CONTRACT event with them as the buyer, however the arrangement is labelled — "official technology partner", "innovation partner", "strategic collaboration"); industry awards and analyst rankings; research reports; a provider BUYING from another supplier; criticism of an existing contract with no new award (that is DISPUTED status on the existing contract only if the text describes the contract itself).

3. SUPPORTING TEXT — for every claim below, copy the exact passage (≤ 300 characters, verbatim) from the text that supports it, or null if none does:
   eventQuote (what happened between whom), valueQuote, durationQuote, aiRelevanceQuote (unless NOT_AI_SPECIFIC/UNKNOWN), buyerSectorQuote, incumbentQuote, commercialModelQuote.
   Never infer contract value, pricing structure, AI content or a previous provider without a passage that states it.

4. VALUES — contractValue is the total stated for this event in the stated currency (ISO code); valueIsTcv true if described as total/contract value, false if annual (then also fill acv), null if unclear. durationMonths as an integer when a term is stated ("four years" → 48). Missing means null — never estimate.
   SIZING FACTS (stated only, each with its quote): agentCount = agents/FTEs/seats the PROVIDER will deploy or transfer for this work (NOT the client's headcount); agentTarget = a stated scale-up target ("growing to 1,000 seats"); deliveryLocations = countries/cities the provider delivers FROM; workType = VOICE (calls), NON_VOICE (back office, chat, email, processing), SPECIALISED (clinical, licensed, level-2+ technical, multilingual European desks), UNKNOWN; usersServed = the client population the work supports ("supporting 35,000 employees", "serving 2 million customers"); buyerCountry = the buyer's home country when stated.

5. COMMERCIAL MODEL — pricingModel (fixed price | time and materials | capped | outcome-based | consumption | day rate | mixed | null), outcomePricing, feeAtRisk, consumptionModel: only when the text says so.

Return JSON only, no prose:
{"articleType": "...", "substantive": true|false, "why": "≤20 words", "events": [ { "family": "...", "commercialEventType": "...", "eventStatus": "...", "provider": "...", "buyer": "...|null", "buyerDescriptor": "...|null", "buyerSector": "...", "buyerSectorQuote": "...|null", "aiRelevance": "...", "aiRelevanceQuote": "...|null", "eventQuote": "...|null", "announcementDate": "YYYY-MM-DD|null", "effectiveDate": "YYYY-MM-DD|null", "contractValue": number|null, "currency": "ISO|null", "valueQuote": "...|null", "valueIsTcv": true|false|null, "acv": number|null, "durationMonths": int|null, "durationQuote": "...|null", "agentCount": int|null, "agentTarget": int|null, "agentQuote": "...|null", "deliveryLocations": ["..."], "workType": "VOICE|NON_VOICE|SPECIALISED|UNKNOWN|null", "usersServed": int|null, "usersQuote": "...|null", "buyerCountry": "...|null", "renewalPeriodMonths": int|null, "expansionValue": number|null, "serviceScope": "≤200 chars|null", "serviceLine": "ITO|Application Services|Digital & Cloud|BPO|Cybersecurity|AI & Analytics|Consulting & Advisory|ERP & Enterprise Apps|Network & Telco|Engineering IT|null", "industry": "...|null", "geography": ["..."], "pricingModel": "...|null", "outcomePricing": true|false|null, "feeAtRisk": true|false|null, "consumptionModel": true|false|null, "commercialModelQuote": "...|null", "incumbent": "...|null", "displacedProvider": "...|null", "incumbentQuote": "...|null", "summary": "2 sentences", "title": "Provider | EventType | Buyer | Scope" } ] }`;

/** Split a long text on paragraph boundaries into overlapping segments, preserving order. */
export function segmentText(text: string): string[] {
  if (text.length <= SINGLE_READ_MAX) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + SEGMENT_CHARS);
    if (end < text.length) {
      const cut = text.lastIndexOf("\n", end);
      if (cut > start + SEGMENT_CHARS / 2) end = cut;
    }
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - SEGMENT_OVERLAP, start + 1);
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/[^a-z0-9$€£%.,'-]+/g, " ").trim();

/** True when the quote occurs in the text (normalised), or when ≥80% of its 12-char windows do. */
export function quoteOccurs(quote: string | null | undefined, text: string): boolean {
  if (!quote) return false;
  const q = norm(quote), t = norm(text);
  if (q.length < 12) return q.length > 0 && t.includes(q);
  if (t.includes(q)) return true;
  const windows: string[] = [];
  for (let i = 0; i + 12 <= q.length; i += 6) windows.push(q.slice(i, i + 12));
  const hits = windows.filter(w => t.includes(w)).length;
  return windows.length > 0 && hits / windows.length >= 0.8;
}

function sha256(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }

async function callModel(userText: string): Promise<{ parsed: unknown; usage: Reading["usage"]; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  if (!apiKey) return { parsed: null, usage: empty, error: "ANTHROPIC_API_KEY not configured" };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: READER_MODEL, max_tokens: 8000,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: userText }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return { parsed: null, usage: empty, error: `model call failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { parsed: null, usage: empty, error: `model HTTP ${res.status}` };
  const data = await res.json() as { content?: { type: string; text: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; model?: string; stop_reason?: string };
  const u = data.usage ?? {};
  const inputTokens = u.input_tokens ?? 0, outputTokens = u.output_tokens ?? 0, cacheReadTokens = u.cache_read_input_tokens ?? 0, cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  const costUsd = (inputTokens * 2 + cacheReadTokens * 0.2 + cacheWriteTokens * 2.5 + outputTokens * 10) / 1e6;
  const usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
  if (data.model && !data.model.startsWith(READER_MODEL)) return { parsed: null, usage, error: `model substituted: ${data.model}` };
  const text = (data.content ?? []).find(c => c.type === "text")?.text ?? "";
  if (data.stop_reason === "max_tokens") return { parsed: null, usage, error: "model output hit max_tokens (truncated)" };
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { parsed: null, usage, error: `model returned no JSON (stop_reason=${data.stop_reason ?? "?"}, ${text.length} chars)` };
  try { return { parsed: JSON.parse(m[0]), usage }; } catch { return { parsed: null, usage, error: "model JSON did not parse" }; }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const inSet = <T extends readonly string[]>(set: T, v: unknown, fallback: T[number]): T[number] =>
  (typeof v === "string" && (set as readonly string[]).includes(v.toUpperCase()) ? (v.toUpperCase() as T[number]) : fallback);

function candidateFrom(e: Record<string, unknown>): RawEventCandidate {
  return {
    family: inSet(FAMILIES, e.family, "CONTRACT"),
    commercialEventType: inSet(COMMERCIAL_EVENT_TYPES, e.commercialEventType, "UNKNOWN"),
    eventStatus: inSet(EVENT_STATUSES, e.eventStatus, "UNKNOWN"),
    provider: str(e.provider), buyer: str(e.buyer), buyerDescriptor: str(e.buyerDescriptor),
    buyerSector: inSet(BUYER_SECTORS, e.buyerSector, "UNKNOWN"), buyerSectorQuote: str(e.buyerSectorQuote),
    aiRelevance: inSet(AI_RELEVANCE, e.aiRelevance, "UNKNOWN"), aiRelevanceQuote: str(e.aiRelevanceQuote),
    eventQuote: str(e.eventQuote), announcementDate: str(e.announcementDate), effectiveDate: str(e.effectiveDate),
    contractValue: num(e.contractValue), currency: str(e.currency)?.toUpperCase() ?? null, valueQuote: str(e.valueQuote), valueIsTcv: bool(e.valueIsTcv), acv: num(e.acv),
    durationMonths: num(e.durationMonths), durationQuote: str(e.durationQuote),
    agentCount: num(e.agentCount), agentTarget: num(e.agentTarget), agentQuote: str(e.agentQuote),
    deliveryLocations: Array.isArray(e.deliveryLocations) ? (e.deliveryLocations as unknown[]).map(str).filter((x): x is string => !!x) : [],
    workType: (["VOICE", "NON_VOICE", "SPECIALISED", "UNKNOWN"] as const).find(w => w === str(e.workType)?.toUpperCase()) ?? null,
    usersServed: num(e.usersServed), usersQuote: str(e.usersQuote), buyerCountry: str(e.buyerCountry), renewalPeriodMonths: num(e.renewalPeriodMonths), expansionValue: num(e.expansionValue),
    serviceScope: str(e.serviceScope), serviceLine: str(e.serviceLine), industry: str(e.industry),
    geography: Array.isArray(e.geography) ? (e.geography as unknown[]).filter((g): g is string => typeof g === "string") : [],
    pricingModel: str(e.pricingModel), outcomePricing: bool(e.outcomePricing), feeAtRisk: bool(e.feeAtRisk), consumptionModel: bool(e.consumptionModel), commercialModelQuote: str(e.commercialModelQuote),
    incumbent: str(e.incumbent), displacedProvider: str(e.displacedProvider), incumbentQuote: str(e.incumbentQuote),
    summary: str(e.summary), title: str(e.title),
  };
}

/**
 * Grounding (§9): each claim keeps its supporting passage only if that passage
 * occurs in the article. An unsupported claim is dropped or downgraded — value,
 * duration, incumbent and commercial-model fields become null; AI relevance
 * becomes UNKNOWN; an event with no supported event passage is discarded.
 */
export function ground(c: RawEventCandidate, text: string): GroundedEvent | null {
  const supporting: Record<string, string> = {};
  const dropped: string[] = [];
  const keep = (claim: string, quote: string | null) => { if (quote && quoteOccurs(quote, text)) { supporting[claim] = quote; return true; } return false; };
  if (!keep("event", c.eventQuote)) return null;
  const g: GroundedEvent = { ...c, supporting, dropped };
  if (c.contractValue != null && !keep("value", c.valueQuote)) { g.contractValue = null; g.currency = null; g.valueIsTcv = null; g.acv = null; dropped.push("value"); }
  if (c.durationMonths != null && !keep("duration", c.durationQuote)) { g.durationMonths = null; g.renewalPeriodMonths = null; dropped.push("duration"); }
  if ((c.agentCount != null || c.agentTarget != null) && !keep("agents", c.agentQuote)) { g.agentCount = null; g.agentTarget = null; dropped.push("agents"); }
  if (c.usersServed != null && !keep("usersServed", c.usersQuote)) { g.usersServed = null; dropped.push("usersServed"); }
  if (c.aiRelevance !== "NOT_AI_SPECIFIC" && c.aiRelevance !== "UNKNOWN" && !keep("aiRelevance", c.aiRelevanceQuote)) { g.aiRelevance = "UNKNOWN"; dropped.push("aiRelevance"); }
  if ((c.incumbent || c.displacedProvider) && !keep("incumbent", c.incumbentQuote)) { g.incumbent = null; g.displacedProvider = null; if (g.commercialEventType === "COMPETITIVE_TAKEAWAY" || g.commercialEventType === "REPLACEMENT") g.commercialEventType = "UNKNOWN"; dropped.push("incumbent"); }
  if ((c.pricingModel || c.outcomePricing || c.feeAtRisk || c.consumptionModel) && !keep("commercialModel", c.commercialModelQuote)) { g.pricingModel = null; g.outcomePricing = null; g.feeAtRisk = null; g.consumptionModel = null; dropped.push("commercialModel"); }
  if (c.buyerSector !== "UNKNOWN") keep("buyerSector", c.buyerSectorQuote);   // sector may be inferred from context; the quote is kept when it exists
  // Provider must be a tracked vendor as spelled; otherwise try the alias table on the model's string.
  if (g.provider && !(TRACKED_VENDORS as readonly string[]).includes(g.provider)) g.provider = matchTrackedVendorPreferring(g.provider, []) ?? g.provider;
  return g;
}

const normOrg = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(inc|ltd|limited|plc|llc|corp|corporation|group|holdings|ag|se|sa|gmbh)\b/g, "").replace(/\s+/g, " ").trim();

/** Merge per-segment candidates that describe the same event (same provider, buyer, family and type). */
export function reconcile(cands: GroundedEvent[]): GroundedEvent[] {
  const out: GroundedEvent[] = [];
  for (const c of cands) {
    const twin = out.find(o => o.family === c.family && (o.provider ?? "") === (c.provider ?? "")
      && (normOrg(o.buyer) === normOrg(c.buyer) || (!o.buyer && !c.buyer && normOrg(o.buyerDescriptor) === normOrg(c.buyerDescriptor)))
      && (o.commercialEventType === c.commercialEventType || o.commercialEventType === "UNKNOWN" || c.commercialEventType === "UNKNOWN"));
    if (!twin) { out.push(c); continue; }
    // later segments fill what earlier ones lacked; supporting passages accumulate
    for (const k of Object.keys(c) as (keyof GroundedEvent)[]) {
      const cv = c[k], tv = twin[k];
      if ((tv === null || tv === undefined || tv === "UNKNOWN" || (Array.isArray(tv) && tv.length === 0)) && cv !== null && cv !== undefined && cv !== "UNKNOWN") (twin as unknown as Record<string, unknown>)[k] = cv;
    }
    Object.assign(twin.supporting, { ...c.supporting, ...twin.supporting });
    twin.dropped = [...new Set([...twin.dropped, ...c.dropped])];
  }
  return out;
}

/**
 * Read one article end to end. Long texts are read in ordered segments and the
 * results reconciled; nothing is concluded "absent" from a prefix.
 */
export async function readArticle(input: { title: string; text: string; provider?: string | null; sourceType?: string; publishedAt?: string | null }): Promise<ReadOutcome> {
  const text = input.text.replace(/\r/g, "").trim();
  const segments = segmentText(text);
  const usageTotal: Reading["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  let articleType: string | null = null, why: string | null = null, substantive = false;
  const candidates: GroundedEvent[] = [];
  for (let i = 0; i < segments.length; i++) {
    const header = `Title: ${input.title}\nFeed: ${input.provider ?? "unknown"} (${input.sourceType ?? "unknown"})\nPublished: ${input.publishedAt ?? "unknown"}\n` +
      (segments.length > 1 ? `Segment ${i + 1} of ${segments.length} — the article continues across segments; report only what THIS segment establishes.\n` : "") +
      `\nArticle text:\n${segments[i]}`;
    const r = await callModel(header);
    for (const k of Object.keys(usageTotal) as (keyof Reading["usage"])[]) usageTotal[k] += r.usage[k];
    if (r.error || !r.parsed || typeof r.parsed !== "object") return { ok: false, error: r.error ?? "unreadable model output", usage: usageTotal };
    const p = r.parsed as Record<string, unknown>;
    if (i === 0 || !articleType) { articleType = inSet(ARTICLE_TYPES, p.articleType, "OTHER"); why = str(p.why); }
    if (p.substantive === true) substantive = true;
    for (const e of Array.isArray(p.events) ? (p.events as unknown[]) : []) {
      if (!e || typeof e !== "object") continue;
      const g = ground(candidateFrom(e as Record<string, unknown>), text);
      if (g) candidates.push(g);
    }
  }
  const events = reconcile(candidates);
  return {
    ok: true,
    reading: {
      articleType: articleType ?? "OTHER", substantive: substantive || events.length > 0, events, why,
      segments: segments.length, textChars: text.length, textHash: sha256(text),
      modelId: READER_MODEL, promptPolicyVersion: PROMPT_POLICY_VERSION, analysedAt: new Date().toISOString(), usage: usageTotal,
    },
  };
}

// Buyer identity key: the buyer name's DISTINCTIVE tokens, sorted, so "UK Ministry of
// Defence", "Ministry of Defence (UK)" and "the MoD's Ministry of Defence" agree. Generic
// words (ministry, department, group, bank …) carry no identity on their own.
const GENERIC = new Set(["uk", "us", "usa", "eu", "the", "of", "and", "for", "ministry", "department", "dept", "government", "govt", "bank", "services", "service", "solutions", "technologies", "technology", "tech", "systems", "international", "global", "national", "council", "university", "hospital", "health", "healthcare", "authority", "agency", "office", "city", "state", "federal", "digital", "consulting", "partners", "industries", "energy", "telecom", "telecommunications", "insurance", "financial", "finance", "capital", "markets", "group", "holdings", "inc", "ltd", "limited", "plc", "llc", "corp", "corporation", "ag", "se", "sa", "gmbh", "co", "company"]);
export function buyerKey(buyer: string | null, buyerDescriptor: string | null): string {
  const src = buyer ?? (buyerDescriptor ? `desc ${buyerDescriptor}` : "");
  const toks = src.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 1 && !GENERIC.has(w));
  return toks.length ? [...new Set(toks)].sort().join(" ") : normOrg(src);
}

/** Deterministic identity for a commercial event (§16): provider | buyer key | type | first-observed month. */
export function canonicalContractEventId(provider: string, buyer: string | null, buyerDescriptor: string | null, commercialEventType: string, firstDate: Date): string {
  return sha256(`${provider.toLowerCase()}|${buyerKey(buyer, buyerDescriptor)}|${commercialEventType}|${firstDate.toISOString().slice(0, 7)}`).slice(0, 24);
}
