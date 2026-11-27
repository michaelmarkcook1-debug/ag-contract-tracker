/**
 * The review queue, read again in full by a stronger model and settled.
 * Shared by scripts/review-reread.ts (the one-off passes) and /api/cron/review (every day).
 *
 * Every event held for review is sent with its whole article and one question: what is this, really?
 *   PUBLISH       reported as news and confirmed. An unnamed client is published as undisclosed, named by country
 *                 and industry ("a US telecoms client").
 *   RUMOUR        reported but not confirmed by the parties — the Rumours view.
 *   OPPORTUNITY   a public tender, RFP, bid or shortlist (stays in review).
 *   MENTION       a real event the article only mentions in passing — parked.
 *   NOT_EVENT     not this event, or not a commercial event of a tracked provider — dismissed.
 *   NEEDS_PERSON  genuinely unclear; stays in review.
 * The answer must quote the article; a quote that is not in the text sends the item back to a person.
 */
import { prisma } from "@/lib/db";
import { readableArticleText } from "./article-text";
import { TRACKED_VENDORS } from "./sources";

// 1.1.0: a write-up for every settled event (stored as its analyst insight).
export const REREAD_VERSION = "review-reread/1.1.0-2026-11-27";

/** USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (read 2026-11-27). Batch halves both. */
export const PRICES: Record<string, { id: string; input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  opus: { id: "claude-opus-5-5", input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { id: "claude-sonnet-5-5", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};

export const DECISIONS = ["PUBLISH", "RUMOUR", "OPPORTUNITY", "MENTION", "NOT_EVENT", "NEEDS_PERSON"] as const;
export const REGIONS = ["North America", "Latin America", "UK & Ireland", "Continental Europe", "Middle East & Africa", "India & South Asia", "Asia Pacific", "Australia & New Zealand", "Global"] as const;
/** The client-industry vocabulary the catalogue's contracts already use. */
export const INDUSTRIES = ["Public Sector", "BFSI", "Insurance", "Manufacturing & Automotive", "Aerospace & Defence", "Retail", "Consumer Goods", "Telecommunications", "Technology", "Media & Entertainment", "Energy & Resources", "Utilities", "Travel & transport", "Logistics/wholesale", "Healthcare - Public", "Healthcare - Private", "Pharmaceuticals", "Education - Public", "Education - Private", "Construction", "Professional Services", "Sports", "Associations and Non-Profit Organizations"] as const;
const FAMILIES = ["CONTRACT", "PARTNERSHIP", "M_AND_A", "NEW_OFFERING", "ORG_CHANGE", "FINANCIAL_RESULTS"];
const STATUSES = ["ANNOUNCED", "COMPLETED", "RUMOURED", "OPPORTUNITY", "TERMINATED", "DISPUTED"];

const SYSTEM = `You are a senior analyst settling items an automated pipeline held for human review in an IT-services market-intelligence catalogue. Each item is one event the pipeline extracted, with the full article it came from. Read the WHOLE article and decide what the item really is. Answer only from the article.

TRACKED PROVIDERS: ${TRACKED_VENDORS.join(", ")}

DECISION — exactly one:
- PUBLISH: the article reports this event as news (its subject, or one of the deals it announces), a tracked provider is a party, and the event is confirmed: announced, signed, completed, terminated or disputed. A client the article describes but does not name ("a leading European bank") is fine — publish it as undisclosed.
- RUMOUR: the event is reported but not confirmed or agreed by the parties: talks, "in discussions", "exploring a sale", "considering", unnamed sources, a report the company declined to confirm, planned layoffs or job cuts not yet announced. Families: M_AND_A, PARTNERSHIP, CONTRACT, ORG_CHANGE (layoffs).
- OPPORTUNITY: a public tender, RFP, bid or shortlist not yet awarded.
- MENTION: the event is real but this article only mentions it in passing (history, context, an example in an opinion piece, a share-price story).
- NOT_EVENT: the article does not report this event, the parties are wrong, or it is not a commercial event with a tracked provider as a party (marketing, award, ranking, research, a provider buying from its own supplier).
- NEEDS_PERSON: genuinely unclear from the article. Use sparingly.

Then correct the event as the article states it: family (${FAMILIES.join(" | ")}; layoffs and job cuts are ORG_CHANGE), eventStatus (${STATUSES.join(" | ")}), provider (exact spelling from the list), counterparty (the client, target or partner NAME, or null), counterpartyDescriptor (the article's description when unnamed), clientCountry, clientRegion (${REGIONS.join(" | ")}), clientIndustry (${INDUSTRIES.join(" | ")}, or null), and a title "Provider | Event type | Counterparty | Scope". Code region and industry for every client, named or not, when the article gives a basis; otherwise null.

quote: copy, verbatim, the passage (≤ 300 characters) that most directly supports your decision.

writeUp: for PUBLISH and RUMOUR, two or three plain sentences for the catalogue: who did what with whom, the scope, and the value and term when stated. For a client the article does not name, describe it by country and industry ("a US telecoms client"), never invent a name. For a rumour, say who reported it and that it is unconfirmed. null for other decisions.

Reply with JSON only:
{"decision": "...", "family": "...", "eventStatus": "...", "provider": "...|null", "counterparty": "...|null", "counterpartyDescriptor": "...|null", "clientCountry": "...|null", "clientRegion": "...|null", "clientIndustry": "...|null", "title": "...", "quote": "...", "writeUp": "...|null", "why": "≤25 words"}`;

/** Plain words for the pipeline's machine reasons, so the model knows what to check. */
export function reasonWords(reason: string | null): string {
  const r = reason ?? "";
  const out: string[] = [];
  if (r.includes("event_source_mismatch")) out.push("the headline does not name the counterparty, so the article may only mention the event");
  if (r.includes("no_counterparty")) out.push("no client/counterparty was extracted");
  if (/opportunity_not_(award|event)/.test(r)) out.push("it looked like a tender or a deal not yet done");
  if (r.includes("no_event_status")) out.push("the event's status was unclear");
  if (r.includes("low_confidence")) out.push("the extraction was low-confidence");
  if (r.includes("possible_duplicate")) out.push("it may duplicate an existing event");
  if (r.includes("vendor_unresolved")) out.push("the provider could not be matched to the tracked list");
  if (r.includes("restored_from_estimator_demotion")) out.push("a value estimator said it may not be a client contract");
  if (/terminat|disput/.test(r)) out.push("it may be a termination or dispute");
  return out.length ? out.join("; ") : (r || "no reason recorded");
}

export interface Answer {
  decision: string; family: string | null; eventStatus: string | null; provider: string | null; counterparty: string | null;
  counterpartyDescriptor: string | null; clientCountry: string | null; clientRegion: string | null; clientIndustry: string | null;
  title: string | null; quote: string | null; why: string | null; writeUp: string | null;
  grounded: boolean; costUsd: number; inputTokens: number; outputTokens: number; error?: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
const pick = <T extends string>(set: readonly T[], v: unknown): T | null => typeof v === "string" && (set as readonly string[]).includes(v) ? v as T : null;
const str = (v: unknown) => typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null;

export function userPrompt(e: Item): string {
  return `HELD EVENT
family: ${e.family} · status: ${e.eventStatus ?? "unknown"}
title: ${e.title}
provider: ${e.provider ?? "unmatched"} · counterparty: ${e.counterparty ?? e.descriptor ?? "none extracted"}
extractor's passage: ${e.quote ?? "(none)"}
held because: ${reasonWords(e.reason)}

ARTICLE HEADLINE: ${e.headline}
ARTICLE TEXT:
${e.text.slice(0, 60_000)}`;
}

export function requestParams(model: string, e: Item) {
  return { model: PRICES[model].id, max_tokens: 1500, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: userPrompt(e) }] };
}

export function parseAnswer(model: string, d: { content?: { type?: string; text?: string }[]; usage?: Record<string, number>; stop_reason?: string }, text: string, priceFactor = 1): Answer {
  const u = d.usage ?? {}, p = PRICES[model];
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens = u.output_tokens ?? 0;
  const costUsd = priceFactor * ((u.input_tokens ?? 0) * p.input + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + outputTokens * p.output) / 1e6;
  const base = { costUsd, inputTokens, outputTokens };
  const raw = (d.content ?? []).find(c => c.type === "text")?.text ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  let j: Record<string, unknown> = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { /* unparsed */ }
  const decision = pick(DECISIONS, j.decision);
  if (!decision) return { decision: "NEEDS_PERSON", family: null, eventStatus: null, provider: null, counterparty: null, counterpartyDescriptor: null, clientCountry: null, clientRegion: null, clientIndustry: null, title: null, quote: null, why: null, writeUp: null, grounded: false, ...base, error: d.stop_reason === "max_tokens" ? "truncated" : "unparsed" };
  const quote = str(j.quote);
  const grounded = !!quote && norm(text).includes(norm(quote).slice(0, 200));
  return {
    decision, family: pick(FAMILIES, j.family), eventStatus: pick(STATUSES, j.eventStatus), provider: str(j.provider),
    counterparty: str(j.counterparty), counterpartyDescriptor: str(j.counterpartyDescriptor), clientCountry: str(j.clientCountry),
    clientRegion: pick(REGIONS, j.clientRegion), clientIndustry: pick(INDUSTRIES, j.clientIndustry),
    title: str(j.title), quote, why: str(j.why), writeUp: str(j.writeUp), grounded, ...base,
  };
}

export interface Item { id: string; family: string; eventStatus: string | null; title: string; provider: string | null; counterparty: string | null; descriptor: string | null; quote: string | null; reason: string | null; headline: string; text: string }

/** Every review item with readable article text: the source with the longest readable text is the one read. */
export async function loadQueue(ids?: string[]): Promise<{ items: Item[]; noText: number }> {
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "needs_review", ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, family: true, eventStatus: true, canonicalTitle: true, counterpartyRaw: true, supportingText: true, reviewReason: true,
      primaryEntity: { select: { canonicalName: true } }, contractDetails: { select: { clientRaw: true, clientDescriptor: true } },
      sourceEvents: { select: { id: true }, take: 5 } },
  });
  const items: Item[] = [];
  let noText = 0;
  for (const r of rows) {
    const srcs = await prisma.sourceEvent.findMany({ where: { id: { in: r.sourceEvents.map(s => s.id) } }, select: { sourceTitle: true, rawText: true } });
    const best = srcs.map(s => ({ title: s.sourceTitle ?? "", text: readableArticleText(s.rawText) ?? "" })).sort((a, b) => b.text.length - a.text.length)[0];
    if (!best?.text) { noText++; continue; }
    let quote: string | null = null;
    try { quote = (JSON.parse(r.supportingText ?? "{}") as { event?: string }).event ?? null; } catch { /* none */ }
    items.push({ id: r.id, family: r.family, eventStatus: r.eventStatus, title: r.canonicalTitle, provider: r.primaryEntity?.canonicalName ?? null,
      counterparty: r.contractDetails?.clientRaw ?? r.counterpartyRaw, descriptor: r.contractDetails?.clientDescriptor ?? null, quote, reason: r.reviewReason, headline: best.title, text: best.text });
  }
  return { items, noText };
}

export async function askNow(model: string, e: Item): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(requestParams(model, e)), signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return parseAnswer(model, await res.json(), e.text);
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } catch (err) { if (attempt >= 3) throw err; }
    await new Promise(r => setTimeout(r, 5000 * attempt));
  }
}

/** Country names as an adjective a reader expects in "a US telecoms client". */
const PLACE: Record<string, string> = {
  "United States": "US", "USA": "US", "US": "US", "United Kingdom": "UK", "UK": "UK", "Great Britain": "UK", "United Arab Emirates": "UAE", "UAE": "UAE",
  Germany: "German", France: "French", Spain: "Spanish", Italy: "Italian", Netherlands: "Dutch", Belgium: "Belgian", Sweden: "Swedish", Norway: "Norwegian",
  Denmark: "Danish", Finland: "Finnish", Switzerland: "Swiss", Austria: "Austrian", Ireland: "Irish", Poland: "Polish", Portugal: "Portuguese",
  Canada: "Canadian", Mexico: "Mexican", Brazil: "Brazilian", Argentina: "Argentine", Chile: "Chilean", India: "Indian", Japan: "Japanese", China: "Chinese",
  Singapore: "Singaporean", Australia: "Australian", "New Zealand": "New Zealand", "Saudi Arabia": "Saudi", "South Africa": "South African", Israel: "Israeli",
  "South Korea": "South Korean", Malaysia: "Malaysian", Indonesia: "Indonesian", Philippines: "Philippine", Qatar: "Qatari", Turkey: "Turkish",
};
const REGION_WORD: Record<string, string> = {
  "North America": "North American", "Latin America": "Latin American", "UK & Ireland": "UK", "Continental Europe": "European", "Middle East & Africa": "Middle East and Africa",
  "India & South Asia": "South Asian", "Asia Pacific": "Asia-Pacific", "Australia & New Zealand": "Australian and New Zealand", "Global": "global",
};
const INDUSTRY_WORD: Record<string, string> = {
  "Public Sector": "public-sector", BFSI: "financial services", Insurance: "insurance", "Manufacturing & Automotive": "manufacturing", "Aerospace & Defence": "aerospace and defence",
  Retail: "retail", "Consumer Goods": "consumer goods", Telecommunications: "telecoms", Technology: "technology", "Media & Entertainment": "media", "Energy & Resources": "energy",
  Utilities: "utility", "Travel & transport": "travel and transport", "Logistics/wholesale": "logistics", "Healthcare - Public": "public healthcare", "Healthcare - Private": "healthcare",
  Pharmaceuticals: "pharmaceutical", "Education - Public": "education", "Education - Private": "education", Construction: "construction", "Professional Services": "professional services",
  Sports: "sports", "Associations and Non-Profit Organizations": "non-profit",
};
/** An unnamed client, named by where it is and what it does: "a US telecoms client". Null when neither is known. */
export function clientLabel(a: Pick<Answer, "clientCountry" | "clientRegion" | "clientIndustry">): string | null {
  const place = (a.clientCountry && PLACE[a.clientCountry]) ?? (a.clientRegion ? REGION_WORD[a.clientRegion] : null);
  const what = a.clientIndustry ? INDUSTRY_WORD[a.clientIndustry] : null;
  if (!place && !what) return null;
  const words = [place, what, "client"].filter(Boolean).join(" ");
  return `${/^[aeiou]/i.test(words) && !/^(US|UK|UAE|Eu|Uni)/.test(words) ? "an" : "a"} ${words}`;
}

export const PARKED = "parked";
export const REREAD_ACTION = "review_reread";

/** What each answer does to its event. Family changes are left to a person: they move an event between detail tables. */
export function plan(e: { family: string }, a: Answer | undefined): { to: "published" | "rumour" | "parked" | "excluded" | "keep"; why: string } {
  if (!a) return { to: "keep", why: "not read" };
  if (a.error) return { to: "keep", why: `answer ${a.error}` };
  if (!a.grounded) return { to: "keep", why: "quote not found in the article" };
  if (a.decision === "NOT_EVENT") return { to: "excluded", why: a.why ?? "" };
  if (a.decision === "MENTION") return { to: "parked", why: a.why ?? "" };
  if (a.decision === "NEEDS_PERSON" || a.decision === "OPPORTUNITY") return { to: "keep", why: `${a.decision.toLowerCase()}: ${a.why ?? ""}` };
  if (a.family && a.family !== e.family) return { to: "keep", why: `family should be ${a.family}: ${a.why ?? ""}` };
  if (a.decision === "RUMOUR") return { to: "rumour", why: a.why ?? "" };
  return { to: "published", why: a.why ?? "" };
}


const SETTLE_SELECT = {
  id: true, family: true, publicationStatus: true, reviewReason: true, humanReviewRequired: true, eventStatus: true, canonicalTitle: true, counterpartyRaw: true, industry: true, geography: true, analystInsight: true,
  contractDetails: { select: { clientRaw: true, clientDescriptor: true, clientAnonymised: true, clientIndustry: true } }, maDetails: { select: { targetRaw: true } }, partnershipDetails: { select: { entityBRaw: true } },
} as const;

export type Outcome = ReturnType<typeof plan>["to"];

/**
 * Apply one answer to one event still in review. `only` limits which outcomes are applied (the Sonnet pass applies
 * rumours only); anything else is left untouched for the next stage. Every change is logged with the previous values,
 * so --undo can restore it.
 */
export async function settleEvent(id: string, model: string, a: Answer | undefined, opts: { only?: Outcome[]; write: boolean }): Promise<{ to: Outcome; applied: boolean; label: string | null }> {
  const r = await prisma.canonicalMarketEvent.findUnique({ where: { id }, select: SETTLE_SELECT });
  if (!r || r.publicationStatus !== "needs_review") return { to: "keep", applied: false, label: null };
  const p = plan(r, a);
  const named = a?.counterparty ?? null;
  // Country + industry when known; else the article's own short description; never a sentence.
  const descriptor = a?.counterpartyDescriptor && a.counterpartyDescriptor.length <= 60 ? a.counterpartyDescriptor : null;
  const label = a && !named ? clientLabel(a) ?? descriptor ?? "an undisclosed client" : null;
  if (!opts.write || (opts.only && !opts.only.includes(p.to))) return { to: p.to, applied: false, label };
  if (p.to === "keep") {
    await prisma.reviewAction.create({ data: { eventId: id, action: REREAD_ACTION, reviewerNote: `${REREAD_VERSION} ${model} keep: ${p.why}`.slice(0, 500), previousValue: null, newValue: "needs_review" } });
    return { to: p.to, applied: true, label };
  }
  const before = { publicationStatus: r.publicationStatus, reviewReason: r.reviewReason, humanReviewRequired: r.humanReviewRequired, eventStatus: r.eventStatus, canonicalTitle: r.canonicalTitle,
    counterpartyRaw: r.counterpartyRaw, industry: r.industry, geography: r.geography, analystInsight: r.analystInsight, contractDetails: r.contractDetails, maDetails: r.maDetails, partnershipDetails: r.partnershipDetails };
  const note = `${REREAD_VERSION} ${model} ${a!.decision}: ${p.why}`.slice(0, 500);
  await prisma.$transaction(async tx => {
    if (p.to === "excluded" || p.to === "parked") {
      await tx.canonicalMarketEvent.update({ where: { id }, data: { publicationStatus: p.to === "parked" ? PARKED : "excluded_noise", humanReviewRequired: false,
        reviewReason: p.to === "parked" ? "mention_only" : "reread_not_event" } });
    } else {
      const geo: string[] = (() => { try { return JSON.parse(r.geography) as string[]; } catch { return []; } })();
      for (const g of [a!.clientCountry, a!.clientRegion]) if (g && !geo.includes(g)) geo.push(g);
      const title = a!.title && !named && label ? a!.title.replace(/\|\s*[^|]*(undisclosed|unnamed|not named|confidential)[^|]*\|/i, `| ${label[0].toUpperCase()}${label.slice(1)} |`) : a!.title;
      await tx.canonicalMarketEvent.update({ where: { id }, data: {
        publicationStatus: "published", humanReviewRequired: false, reviewReason: null,
        eventStatus: p.to === "rumour" ? "RUMOURED" : (a!.eventStatus ?? r.eventStatus),
        canonicalTitle: (title ?? r.canonicalTitle).slice(0, 500),
        counterpartyRaw: r.counterpartyRaw ?? named,
        industry: r.industry ?? a!.clientIndustry, geography: JSON.stringify(geo),
        analystInsight: a!.writeUp ?? r.analystInsight,
      } });
      if (r.contractDetails) await tx.contractDetails.update({ where: { canonicalEventId: id }, data: {
        clientRaw: r.contractDetails.clientRaw ?? named,
        clientAnonymised: !(r.contractDetails.clientRaw ?? named),
        clientDescriptor: (r.contractDetails.clientRaw ?? named) ? r.contractDetails.clientDescriptor : (label ?? r.contractDetails.clientDescriptor),
        clientIndustry: a!.clientIndustry ?? r.contractDetails.clientIndustry,
      } });
      if (r.maDetails && !r.maDetails.targetRaw && named) await tx.maDetails.update({ where: { canonicalEventId: id }, data: { targetRaw: named } });
      if (r.partnershipDetails && !r.partnershipDetails.entityBRaw && named) await tx.partnershipDetails.update({ where: { canonicalEventId: id }, data: { entityBRaw: named } });
    }
    await tx.reviewAction.create({ data: { eventId: id, action: REREAD_ACTION, reviewerNote: note, previousValue: JSON.stringify(before).slice(0, 8000), newValue: p.to } });
  });
  return { to: p.to, applied: true, label };
}
