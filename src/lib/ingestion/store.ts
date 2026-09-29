/**
 * Store what the reader read (AI Delivery Mandate §8, §14–§16, §20, §22, §23).
 *
 * Deterministic code owns everything here: identity, matching against events
 * already stored, which fields a re-report may fill in, provenance, and the
 * pending state for a model failure. The reader's grounded output is the only
 * source of semantics; nothing is inferred from headlines.
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import type { RawArticle } from "./crawler";
import type { Reading, GroundedEvent } from "./reader";
import { canonicalContractEventId, PROMPT_POLICY_VERSION } from "./reader";
import { defaultEventType, isValidEventType, EMPTY_USAGE, type ExtractionResult } from "./classifier";
import { decidePublication } from "./gate";
import { orgsMatch, titleCounterparty, withinDays, amountsConflict, SAME_EVENT_WINDOW_DAYS } from "./dedup";
import { estimateContractValue, type ValueEstimate } from "@/lib/tcv/engine";

/**
 * The labelled estimate for an undisclosed value (policy 2026-09-08: every
 * contract carries a value — stated when stated, otherwise calculated and
 * labelled). The stated field is never written here.
 */
async function estimateFor(ev: GroundedEvent, article: RawArticle, text: string, eventType: string, when: Date): Promise<ValueEstimate | null> {
  try {
    return await estimateContractValue({
      serviceLine: ev.serviceLine, sourceType: article.sourceType, sourceName: article.provider, contractLengthMonths: ev.durationMonths,
      provider: ev.provider, industry: ev.industry, geography: ev.geography, eventType, anonymised: !ev.buyer && !!ev.buyerDescriptor,
      usersServed: ev.usersServed, announcementYear: when.getFullYear(), agentCount: ev.agentCount, agentTarget: ev.agentTarget,
      deliveryLocations: ev.deliveryLocations, workType: ev.workType, buyerCountry: ev.buyerCountry ?? ev.geography[0] ?? null, text,
    });
  } catch { return null; }
}
const estimateFields = (est: ValueEstimate | null) => est ? {
  tcvEstimateLowUsd: est.lowUsd, tcvEstimateMidUsd: est.midUsd, tcvEstimateHighUsd: est.highUsd,
  tcvBasis: est.basis, tcvIsEstimate: true, tcvConfidence: "estimated",
  tcvEstimateMethod: est.method, tcvEstimateInputs: JSON.stringify(est.inputs), tcvEstimateExplanation: est.explanation, tcvEstimateVersion: est.version,
} : {};

/** Mandate commercial event types → the store's contract event types (UI vocabulary). */
const CONTRACT_TYPE_MAP: Record<string, string> = {
  NEW_WIN: "new_win", RENEWAL: "renewal", EXTENSION: "extension", EXPANSION: "expansion", SCOPE_REDUCTION: "scope_reduction",
  RECOMPETE: "rebid_win", COMPETITIVE_TAKEAWAY: "incumbent_displacement", REPLACEMENT: "incumbent_displacement",
  TERMINATION: "termination", CONTRACT_CHANGE: "contract_change", OTHER_COMMERCIAL_EVENT: "contract_change", UNKNOWN: "unknown",
};

/** Award-type disagreements between re-reports are tolerated; these are not awards. */
const ENDING_TYPES = new Set(["TERMINATION", "SCOPE_REDUCTION"]);

const FX_TO_USD: Record<string, number> = { USD: 1, EUR: 1.09, GBP: 1.27, AUD: 0.66, CAD: 0.73, INR: 0.012, DKK: 0.146, SEK: 0.095, NOK: 0.093, CHF: 1.12, JPY: 0.0068, SGD: 0.75, AED: 0.27, SAR: 0.27, BRL: 0.18, ZAR: 0.055, NZD: 0.61, PLN: 0.26, CZK: 0.044 };
/**
 * A contract's value is never negative. A reported NEGATIVE amount is the size
 * of a reduction (scope cut, termination), not the contract's worth; stored as
 * TCV it subtracted from every market total (two HCLTech/Google reduction
 * reports took $107m off). The amount is kept as stated in tcvOriginalValue;
 * the committed value stays empty.
 */
export function isContractValue(amount: number | null | undefined): amount is number {
  return amount != null && Number.isFinite(amount) && amount > 0;
}

export function toUsd(amount: number | null, currency: string | null): number | null {
  if (amount == null) return null;
  const fx = FX_TO_USD[(currency ?? "USD").toUpperCase()];
  return fx ? Math.round(amount * fx) : null;
}

/**
 * Contract dates (policy 2026-09-08): the start is the stated effective date,
 * else the announcement date; the end is start + contract length whenever a
 * length is known, marked "derived_from_length" when the length was stated and
 * the start is a stated date, otherwise "estimated". Never invented without a
 * length.
 */
export function contractDates(effectiveDate: Date | null, announcementDate: Date, months: number | null, lengthIsEstimate = false) {
  const start = effectiveDate ?? announcementDate;
  const startPrecision = effectiveDate ? "day" : "announcement";
  if (!months || months <= 0) return { start, startPrecision, end: null as Date | null, endPrecision: "unknown" };
  const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + Math.round(months));
  return { start, startPrecision, end, endPrecision: effectiveDate && !lengthIsEstimate ? "derived_from_length" : "estimated" };
}

function hashUrl(url: string): string { return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16); }
function parseDate(s: string | null | undefined): Date | null { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }

async function resolveEntityId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const e = await prisma.entity.findFirst({ where: { OR: [{ canonicalName: { equals: name } }, { aliases: { some: { alias: { equals: name } } } }] }, select: { id: true } });
  return e?.id ?? null;
}

/** Fields written to the SourceEvent row for any outcome of a read. */
function sourceRow(article: RawArticle, text: string, reading: Reading | null, runId: string) {
  return {
    rawTextHash: hashUrl(article.url),
    sourceTitle: article.title.slice(0, 300),
    sourceName: article.provider,
    sourceType: article.sourceType,
    publicationDate: parseDate(article.publishedAt),
    rawText: text.slice(0, 60_000) || null,
    publisherUrl: article.publisherUrl ?? null,
    ingestionRunId: runId,
    articleType: reading?.articleType ?? null,
    articleTextHash: reading?.textHash ?? null,
    articleTextChars: reading?.textChars ?? text.length,
    modelId: reading?.modelId ?? null,
    promptPolicyVersion: reading?.promptPolicyVersion ?? null,
    analysedAt: reading ? new Date(reading.analysedAt) : null,
  };
}

/**
 * Upsert the article's row. An existing EXCLUDED or PENDING row is updated in
 * place and keeps its earlier verdict in previousExclusionReason (§20); an
 * existing EXTRACTED row is left alone and the caller must not store again.
 */
async function upsertSource(article: RawArticle, text: string, reading: Reading | null, runId: string,
  status: "extracted" | "excluded" | "pending", reason: string | null, error: string | null): Promise<{ id: string } | null> {
  const existing = await prisma.sourceEvent.findUnique({ where: { sourceUrl: article.url }, select: { id: true, processingStatus: true, exclusionReason: true } });
  if (existing && existing.processingStatus === "extracted") return null;
  const data = {
    ...sourceRow(article, text, reading, runId),
    processingStatus: status,
    exclusionReason: status === "excluded" ? reason : null,
    processingError: error,
    extractedFamily: status === "extracted" ? "READ" : status === "excluded" ? "EXCLUDED" : "UNKNOWN",
    extractionConfidence: 0,
    ...(existing?.exclusionReason && existing.processingStatus === "excluded" ? { previousExclusionReason: existing.exclusionReason } : {}),
  };
  if (existing) return prisma.sourceEvent.update({ where: { id: existing.id }, data, select: { id: true } });
  return prisma.sourceEvent.create({ data: { sourceUrl: article.url, ...data }, select: { id: true } });
}

/** Failed model reads allowed before an article stops being retried. */
export const MAX_READ_ATTEMPTS = 2;

/**
 * Model failure → the article is kept as pending and retried on a later run
 * (§22), never regex-classified. Each failure counts; at MAX_READ_ATTEMPTS the
 * row becomes FAILED with the reason, so a poison article (one that truncates
 * or times out every time) cannot occupy the head of the queue for ever.
 */
export async function storePending(article: RawArticle, text: string, error: string, runId: string): Promise<"pending" | "failed"> {
  const prior = await prisma.sourceEvent.findUnique({ where: { sourceUrl: article.url }, select: { readAttempts: true } });
  const attempts = (prior?.readAttempts ?? 0) + 1;
  const src = await upsertSource(article, text, null, runId, "pending", null, error.slice(0, 300));
  if (!src) return "pending";
  const failed = attempts >= MAX_READ_ATTEMPTS;
  await prisma.sourceEvent.update({ where: { id: src.id }, data: {
    readAttempts: attempts,
    ...(failed ? { processingStatus: "failed", processingError: `read failed ${attempts}x: ${error.slice(0, 250)}` } : {}),
  } });
  return failed ? "failed" : "pending";
}

/**
 * Articles a run found but did not reach in time. Written in one statement:
 * the per-row upsert this replaces took two queries per article, and with
 * 2,400 deferred articles the run died at the platform ceiling before it could
 * record its own result. Rows already stored are left exactly as they are.
 */
export async function storeDeferred(articles: RawArticle[], runId: string): Promise<number> {
  let written = 0;
  for (let i = 0; i < articles.length; i += 500) {
    const r = await prisma.sourceEvent.createMany({
      data: articles.slice(i, i + 500).map(a => ({
        sourceUrl: a.url, rawTextHash: hashUrl(a.url), sourceTitle: a.title.slice(0, 300), sourceName: a.provider, sourceType: a.sourceType,
        publicationDate: parseDate(a.publishedAt), rawText: (a.bodyText ?? a.snippet ?? null)?.slice(0, 60_000) ?? null, publisherUrl: a.publisherUrl ?? null,
        processingStatus: "pending", processingError: "deferred: not reached within the run's time budget", extractedFamily: "UNKNOWN", ingestionRunId: runId,
      })),
      skipDuplicates: true,
    });
    written += r.count;
  }
  return written;
}

/**
 * The same article under another URL (Google News issues a fresh redirect URL
 * for a story it has already served). Its content was already read under the
 * current policy, so it is not paid for again: the new URL is recorded and
 * attached to whatever the first read produced — events as corroboration, or
 * the same exclusion reason.
 */
export async function findReadByContent(textHash: string, title: string | null): Promise<{ id: string; processingStatus: string; exclusionReason: string | null; eventIds: string[] } | null> {
  const priors = await prisma.sourceEvent.findMany({
    where: { articleTextHash: textHash, promptPolicyVersion: PROMPT_POLICY_VERSION, processingStatus: { in: ["extracted", "excluded"] } },
    select: { id: true, sourceTitle: true, processingStatus: true, exclusionReason: true, canonicalEvents: { select: { id: true } } },
    take: 20,
  });
  // Identical extracted text is often page chrome (a paywall, a chatbot panel,
  // a newsroom shell) shared by different stories, so the text alone never
  // decides it — the headline has to name the same story too.
  const prior = priors.find(p => sameStoryHeadline(p.sourceTitle, title));
  return prior ? { id: prior.id, processingStatus: prior.processingStatus, exclusionReason: prior.exclusionReason, eventIds: prior.canonicalEvents.map(e => e.id) } : null;
}

const HEADLINE_STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "by", "at", "as", "is", "its", "from", "new"]);
function headlineTokens(title: string | null): Set<string> {
  if (!title) return new Set();
  const h = title.replace(/\s+[-–—|]\s+[^-–—|]{2,60}$/, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  return new Set(h.split(/\s+/).filter(w => w.length > 1 && !HEADLINE_STOPWORDS.has(w)));
}
/** Two headlines name the same story: most of their content words are shared. */
export function sameStoryHeadline(a: string | null, b: string | null): boolean {
  const x = headlineTokens(a), y = headlineTokens(b);
  // Short headlines carry too little to overlap on — they must match exactly.
  if (x.size < 3 || y.size < 3) return x.size > 0 && x.size === y.size && [...x].every(w => y.has(w));
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size) >= 0.6;
}

export async function storeDuplicateContent(article: RawArticle, text: string, textHash: string, prior: NonNullable<Awaited<ReturnType<typeof findReadByContent>>>, runId: string): Promise<void> {
  const extracted = prior.processingStatus === "extracted" && prior.eventIds.length > 0;
  const src = await upsertSource(article, text, null, runId, extracted ? "extracted" : "excluded",
    extracted ? null : (prior.exclusionReason ?? "model:duplicate_content"), null);
  if (!src) return;
  await prisma.sourceEvent.update({ where: { id: src.id }, data: { articleTextHash: textHash, promptPolicyVersion: PROMPT_POLICY_VERSION, articleTextChars: text.length } });
  for (const id of prior.eventIds) {
    await prisma.canonicalMarketEvent.update({ where: { id }, data: { sourceEvents: { connect: { id: src.id } } } }).catch(() => {});
  }
}

/** No readable text (page gone, paywall, empty feed item): a structural exclusion that keeps any earlier verdict (§20). */
export async function storeUnreadable(article: RawArticle, runId: string): Promise<void> {
  await upsertSource(article, "", null, runId, "excluded", "rules:unreadable", null);
}

/** A read that reports no event: recorded with the article type as the reason, never re-bought. */
export async function storeNonEvent(article: RawArticle, text: string, reading: Reading, runId: string): Promise<void> {
  await upsertSource(article, text, reading, runId, "excluded", `model:${reading.articleType.toLowerCase()}`, null);
}

export interface StoreCounts { published: number; queued: number; merged: number; skippedNoProvider: number }

/**
 * The stored event this grounded event re-reports, if any: same family, same
 * provider entity, announcement within the window, counterparty matching after
 * normalisation (or matching descriptors when neither side names one), event
 * type compatible (equal, or one side UNKNOWN), and no conflicting stated amount.
 */
async function findExisting(ev: GroundedEvent, family: string, vendorId: string, when: Date): Promise<{ id: string; publicationStatus: string } | null> {
  const pad = SAME_EVENT_WINDOW_DAYS * 86_400_000;
  const cands = await prisma.canonicalMarketEvent.findMany({
    where: { family, primaryEntityId: vendorId, announcementDate: { gte: new Date(when.getTime() - pad), lte: new Date(when.getTime() + pad) }, publicationStatus: { not: "excluded_noise" } },
    select: { id: true, publicationStatus: true, counterpartyRaw: true, canonicalTitle: true, announcementDate: true, commercialEventType: true, contractDetails: { select: { clientRaw: true, clientDescriptor: true, tcvCommittedUsd: true } } },
    take: 60,
  });
  const myType = ev.commercialEventType;
  for (const c of cands) {
    if (!withinDays(when, c.announcementDate, SAME_EVENT_WINDOW_DAYS)) continue;
    // Re-reports of one contract routinely disagree on the award type (one
    // outlet says "wins", another "renews"); those are the same event. Only
    // an ending (termination, scope reduction) is incompatible with an award.
    const theirType = c.commercialEventType;
    if (family === "CONTRACT" && theirType && theirType !== myType && (ENDING_TYPES.has(myType) || ENDING_TYPES.has(theirType))) continue;
    const theirs = c.counterpartyRaw ?? c.contractDetails?.clientRaw ?? titleCounterparty(c.canonicalTitle);
    const mine = ev.buyer;
    let same = false;
    if (mine && theirs) same = orgsMatch(mine, theirs);
    else if (!mine && !theirs && ev.buyerDescriptor && c.contractDetails?.clientDescriptor) same = orgsMatch(ev.buyerDescriptor, c.contractDetails.clientDescriptor);
    if (!same) continue;
    if (ev.contractValue != null && c.contractDetails?.tcvCommittedUsd != null) {
      const mineUsd = toUsd(ev.contractValue, ev.currency);
      if (mineUsd && amountsConflict(`$${mineUsd}`, `$${c.contractDetails.tcvCommittedUsd}`)) continue;
    }
    return { id: c.id, publicationStatus: c.publicationStatus };
  }
  return null;
}

/** A re-report may fill fields the stored event lacks; it never overwrites a stated value with another. */
export async function enrichExisting(eventId: string, ev: GroundedEvent, idKey?: string): Promise<void> {
  const cur = await prisma.canonicalMarketEvent.findUnique({ where: { id: eventId }, select: { family: true, buyerSector: true, aiRelevance: true, eventStatus: true, supportingText: true, canonicalContractEventId: true, commercialEventType: true, readerVersion: true, contractDetails: { select: { id: true, tcvCommittedUsd: true, contractLengthMonths: true, clientRaw: true, pricingModel: true, previousVendorRaw: true, agentCount: true, agentTarget: true, deliveryLocations: true, workType: true, usersServed: true, contractStartDate: true, contractStartDatePrecision: true, contractEndDate: true, outcomePricing: true, feeAtRisk: true, consumptionModel: true, renewalPeriodMonths: true, expansionValueUsd: true, acvUsd: true, scopeSummary: true } } } });
  if (!cur) return;
  const support = { ...(cur.supportingText ? JSON.parse(cur.supportingText) as Record<string, string> : {}), ...ev.supporting };
  if (cur.commercialEventType && ev.commercialEventType !== "UNKNOWN" && ev.commercialEventType !== cur.commercialEventType && ev.supporting.event) support[`typeVariant:${ev.commercialEventType}`] = ev.supporting.event;
  // An event stored before the reader existed gains its identity and taxonomy
  // from the first re-report that reaches it (upgrade in place, never a copy).
  let assignId: string | undefined;
  if (!cur.canonicalContractEventId && idKey) {
    const taken = await prisma.canonicalMarketEvent.findUnique({ where: { canonicalContractEventId: idKey }, select: { id: true } });
    if (!taken) assignId = idKey;
  }
  await prisma.canonicalMarketEvent.update({ where: { id: eventId }, data: {
    buyerSector: (!cur.buyerSector || cur.buyerSector === "UNKNOWN") && ev.buyerSector !== "UNKNOWN" ? ev.buyerSector : undefined,
    aiRelevance: (!cur.aiRelevance || cur.aiRelevance === "UNKNOWN") && ev.aiRelevance !== "UNKNOWN" ? ev.aiRelevance : undefined,
    eventStatus: (!cur.eventStatus || cur.eventStatus === "UNKNOWN") && ev.eventStatus !== "UNKNOWN" ? ev.eventStatus : undefined,
    commercialEventType: !cur.commercialEventType && cur.family === "CONTRACT" && ev.commercialEventType !== "UNKNOWN" ? ev.commercialEventType : undefined,
    canonicalContractEventId: assignId,
    readerVersion: cur.readerVersion ?? PROMPT_POLICY_VERSION,
    supportingText: JSON.stringify(support),
  } });
  if (cur.contractDetails) {
    const cd = cur.contractDetails;
    const nowStated = cd.tcvCommittedUsd == null && isContractValue(ev.contractValue) && ev.valueIsTcv !== false && toUsd(ev.contractValue, ev.currency) != null;
    await prisma.contractDetails.update({ where: { id: cd.id }, data: {
      agentCount: cd.agentCount == null && ev.agentCount != null ? ev.agentCount : undefined,
      agentTarget: cd.agentTarget == null && ev.agentTarget != null ? ev.agentTarget : undefined,
      deliveryLocations: !cd.deliveryLocations && ev.deliveryLocations.length ? JSON.stringify(ev.deliveryLocations) : undefined,
      workType: !cd.workType && ev.workType ? ev.workType : undefined,
      usersServed: cd.usersServed == null && ev.usersServed != null ? ev.usersServed : undefined,
      // a stated value supersedes any estimate
      ...(nowStated ? { tcvEstimateLowUsd: null, tcvEstimateMidUsd: null, tcvEstimateHighUsd: null, tcvIsEstimate: false, tcvEstimateMethod: null, tcvEstimateInputs: null, tcvEstimateExplanation: null, tcvEstimateVersion: null } : {}),
      tcvCommittedUsd: cd.tcvCommittedUsd == null && isContractValue(ev.contractValue) && ev.valueIsTcv !== false ? toUsd(ev.contractValue, ev.currency) : undefined,
      tcvOriginalCurrency: cd.tcvCommittedUsd == null && ev.contractValue != null ? ev.currency : undefined,
      tcvOriginalValue: cd.tcvCommittedUsd == null && ev.contractValue != null ? ev.contractValue : undefined,
      tcvBasis: cd.tcvCommittedUsd == null && ev.contractValue != null && ev.valueIsTcv !== false ? "official_disclosed" : undefined,
      tcvConfidence: cd.tcvCommittedUsd == null && ev.contractValue != null && ev.valueIsTcv !== false ? "known" : undefined,
      contractLengthMonths: cd.contractLengthMonths == null && ev.durationMonths != null ? ev.durationMonths : undefined,
      ...(cd.contractLengthMonths == null && ev.durationMonths != null && cd.contractEndDate == null && cd.contractStartDate ? (() => { const d = contractDates(cd.contractStartDatePrecision === "day" ? cd.contractStartDate : null, cd.contractStartDate!, ev.durationMonths); return { contractEndDate: d.end, contractEndDatePrecision: d.endPrecision, contractLengthDescriptor: "stated" }; })() : {}),
      clientRaw: !cd.clientRaw && ev.buyer ? ev.buyer : undefined,
      pricingModel: !cd.pricingModel && ev.pricingModel ? ev.pricingModel : undefined,
      previousVendorRaw: !cd.previousVendorRaw && (ev.incumbent ?? ev.displacedProvider) ? (ev.incumbent ?? ev.displacedProvider) : undefined,
      // An incumbent is not a displacement. On a renewal or extension the
      // incumbent IS the winning vendor, so "there is an incumbent" must never
      // be stored as "the incumbent was displaced" — that reported 17%
      // competitive displacement where the true rate was 3%.
      incumbentDisplaced: !cd.previousVendorRaw && (ev.incumbent ?? ev.displacedProvider)
        ? !orgsMatch(ev.displacedProvider ?? ev.incumbent, ev.provider)
        : undefined,
      // Commercial mechanics the reader extracts from prose and no structured
      // source carries (§10). Before this they were read and then dropped on
      // the floor for every event that already existed — which made "outcome
      // pricing is rare" unmeasurable rather than false.
      outcomePricing: cd.outcomePricing == null && ev.outcomePricing != null ? ev.outcomePricing : undefined,
      feeAtRisk: cd.feeAtRisk == null && ev.feeAtRisk != null ? ev.feeAtRisk : undefined,
      consumptionModel: cd.consumptionModel == null && ev.consumptionModel != null ? ev.consumptionModel : undefined,
      renewalPeriodMonths: cd.renewalPeriodMonths == null && ev.renewalPeriodMonths != null ? ev.renewalPeriodMonths : undefined,
      expansionValueUsd: cd.expansionValueUsd == null && ev.expansionValue != null ? toUsd(ev.expansionValue, ev.currency) : undefined,
      acvUsd: cd.acvUsd == null && ev.acv != null ? toUsd(ev.acv, ev.currency) : undefined,
      scopeSummary: !cd.scopeSummary && ev.serviceScope ? ev.serviceScope : undefined,
    } });
  }
}

/**
 * Store every grounded event of one reading: attach re-reports to the event
 * they describe, create the rest with a deterministic identity, and record the
 * article once with its provenance. Sequential by design — matching against
 * events stored seconds earlier must see them.
 */
export async function storeReading(article: RawArticle, text: string, reading: Reading, runId: string): Promise<StoreCounts> {
  const counts: StoreCounts = { published: 0, queued: 0, merged: 0, skippedNoProvider: 0 };
  const withProvider = reading.events.filter(e => !!e.provider);
  counts.skippedNoProvider = reading.events.length - withProvider.length;
  if (withProvider.length === 0) {
    await upsertSource(article, text, reading, runId, "excluded", reading.events.length ? "model:no_tracked_vendor" : `model:${reading.articleType.toLowerCase()}`, null);
    return counts;
  }
  const source = await upsertSource(article, text, reading, runId, "extracted", null, null);
  if (!source) return counts;   // this URL already produced events on an earlier run

  const articleDate = parseDate(article.publishedAt) ?? new Date();
  for (const ev of withProvider) {
    const family = ev.family;
    const vendorId = await resolveEntityId(ev.provider);
    const when = parseDate(ev.announcementDate) ?? articleDate;
    if (vendorId) {
      const existing = await findExisting(ev, family, vendorId, when);
      if (existing) {
        await prisma.canonicalMarketEvent.update({ where: { id: existing.id }, data: { sourceEvents: { connect: { id: source.id } } } });
        await enrichExisting(existing.id, ev, canonicalContractEventId(ev.provider!, ev.buyer, ev.buyerDescriptor, family === "CONTRACT" ? ev.commercialEventType : family, when));
        counts.merged++;
        continue;
      }
    }
    const eventType = family === "CONTRACT" ? (CONTRACT_TYPE_MAP[ev.commercialEventType] ?? "unknown") : defaultEventType(family, `${ev.title ?? ""} ${ev.summary ?? ""} ${article.title}`);
    const gateInput: ExtractionResult = {
      family, eventType, canonicalTitle: ev.title ?? article.title, vendorRaw: ev.provider, clientRaw: ev.buyer, clientDescriptor: ev.buyerDescriptor,
      tcvUsd: null, tcvIsEstimate: false, contractLengthMonths: ev.durationMonths, primaryMacroServiceLine: ev.serviceLine, geography: ev.geography, industry: ev.industry,
      // The reader does not measure confidence — its evidence is grounding, so
      // the basis is asserted and the gate must judge it on the passages instead.
      confidenceScore: 1, confidenceBasis: "asserted" as const,
      groundedClaims: Object.keys(ev.supporting ?? {}).length > 0,
      extractionMethod: "llm", summary: ev.summary, analystInsight: null, missingCritical: ev.dropped,
      eventTypeValid: isValidEventType(family, eventType), exclusionReason: null, eventStatus: ev.eventStatus.toLowerCase(), articleType: reading.articleType, usage: EMPTY_USAGE,
    };
    const gate = decidePublication(gateInput, vendorId);
    const clientId = await resolveEntityId(ev.buyer);
    const idKey = canonicalContractEventId(ev.provider!, ev.buyer, ev.buyerDescriptor, family === "CONTRACT" ? ev.commercialEventType : family, when);
    const collision = await prisma.canonicalMarketEvent.findUnique({ where: { canonicalContractEventId: idKey }, select: { id: true } });
    if (collision) {
      await prisma.canonicalMarketEvent.update({ where: { id: collision.id }, data: { sourceEvents: { connect: { id: source.id } } } });
      await enrichExisting(collision.id, ev);
      counts.merged++;
      continue;
    }
    const valueUsd = isContractValue(ev.contractValue) && ev.valueIsTcv !== false ? toUsd(ev.contractValue, ev.currency) : null;
    const estimate = family === "CONTRACT" && valueUsd == null ? await estimateFor(ev, article, text, eventType, when) : null;
    const dates = contractDates(parseDate(ev.effectiveDate), when, ev.durationMonths);
    await prisma.$transaction(async tx => {
      const created = await tx.canonicalMarketEvent.create({ data: {
        family, eventType, canonicalTitle: (ev.title ?? article.title).slice(0, 500),
        announcementDate: when, announcementDateBasis: ev.announcementDate ? "explicit" : (article.publishedAt ? "publication" : "unavailable"),
        effectiveDate: parseDate(ev.effectiveDate),
        geography: JSON.stringify(ev.geography), industry: ev.industry, industryBasis: ev.industry ? "classified" : "unavailable",
        confidenceScore: 1, confidenceBasis: "asserted", commercialRelevanceScore: valueUsd ? 0.9 : 0.7,
        humanReviewRequired: gate.status === "needs_review", publicationStatus: gate.status, reviewReason: gate.reason,
        counterpartyRaw: ev.buyer, originalArticleUrl: article.publisherUrl ?? article.url, primaryEntityId: vendorId,
        canonicalContractEventId: idKey, commercialEventType: family === "CONTRACT" ? ev.commercialEventType : "OTHER_COMMERCIAL_EVENT",
        eventStatus: ev.eventStatus, buyerSector: ev.buyerSector, aiRelevance: ev.aiRelevance,
        supportingText: JSON.stringify(ev.supporting), readerVersion: PROMPT_POLICY_VERSION,
        analystInsight: null,
        sourceEvents: { connect: { id: source.id } },
      } });
      if (family === "CONTRACT") {
        await tx.contractDetails.create({ data: {
          canonicalEventId: created.id, vendorId: vendorId ?? undefined, vendorRaw: ev.provider, vendorConfidence: vendorId ? 0.9 : 0.6,
          clientRaw: ev.buyer, clientId: clientId ?? undefined, clientConfidence: clientId ? 0.85 : 0.5,
          clientAnonymised: !ev.buyer && !!ev.buyerDescriptor, clientDescriptor: ev.buyerDescriptor,
          contractEventType: eventType, previousVendorRaw: ev.incumbent ?? ev.displacedProvider ?? null, incumbentDisplaced: !!(ev.incumbent ?? ev.displacedProvider),
          tcvCommittedUsd: valueUsd, tcvOriginalCurrency: ev.contractValue != null ? ev.currency : null, tcvOriginalValue: ev.contractValue,
          acvUsd: ev.acv != null ? toUsd(ev.acv, ev.currency) : (ev.valueIsTcv === false && ev.contractValue != null ? toUsd(ev.contractValue, ev.currency) : null),
          tcvBasis: valueUsd ? "official_disclosed" : "undisclosed", tcvIsEstimate: false, tcvConfidence: valueUsd ? "known" : "not_reliably_estimable",
          agentCount: ev.agentCount, agentTarget: ev.agentTarget, deliveryLocations: ev.deliveryLocations.length ? JSON.stringify(ev.deliveryLocations) : null,
          workType: ev.workType, usersServed: ev.usersServed,
          ...estimateFields(estimate),
          contractLengthMonths: ev.durationMonths, renewalPeriodMonths: ev.renewalPeriodMonths, expansionValueUsd: ev.expansionValue != null ? toUsd(ev.expansionValue, ev.currency) : null,
          contractStartDate: dates.start, contractStartDatePrecision: dates.startPrecision, contractEndDate: dates.end, contractEndDatePrecision: dates.endPrecision,
          contractLengthDescriptor: ev.durationMonths ? "stated" : null,
          pricingModel: ev.pricingModel, outcomePricing: ev.outcomePricing, feeAtRisk: ev.feeAtRisk, consumptionModel: ev.consumptionModel,
          primaryMacroServiceLine: ev.serviceLine, scopeSummary: ev.serviceScope ?? ev.summary,
          platformsUsed: "[]", clientServiceCoverageLocation: JSON.stringify(ev.geography), secondaryMacroServiceLines: "[]", secondaryMicroServiceLines: "[]",
        } });
      }
    }, { timeout: 20_000, maxWait: 10_000 });
    if (gate.status === "published") counts.published++; else counts.queued++;
  }
  return counts;
}
