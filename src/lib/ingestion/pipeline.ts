import crypto from "crypto";
import { prisma } from "@/lib/db";
import { ALL_SOURCES, VENDOR_RSS_SOURCES, INVESTOR_RELATIONS_SOURCES, PROCUREMENT_SOURCES, WIRE_SOURCES, GOOGLE_NEWS_SOURCES,
         GNEWS_ITEM_CAP, SourceDefinition, isRelevantArticle, mentionsTrackedVendor } from "./sources";
import { crawlSource, RawArticle } from "./crawler";
import { ExtractionResult, EMPTY_USAGE, TokenUsage, CANONICAL_FAMILIES, defaultEventType,
         triageArticle, analyseArticle, resultFromTriage, TriageResult } from "./classifier";
import { inferTcv, clampEstimate, MODEL_ESTIMATE_BASIS } from "@/lib/tcv/infer";
import { retrieveArticle } from "./article-text";
import { decidePublication } from "./gate";
import { orgsMatch, titleCounterparty, titleSimilarity, withinDays, amountsConflict,
         SAME_EVENT_WINDOW_DAYS, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY, TITLE_MATCH_THRESHOLD,
         TITLE_FALLBACK_THRESHOLD, VENDOR_WINDOW_FAMILIES, RESULTS_TITLE_THRESHOLD, COUNTERPARTY_FAMILIES } from "./dedup";

/** Body text passed to the cheap triage tier; analysis gets the full excerpt. */
const TRIAGE_BODY_CHARS = 1_500;

export interface PipelineOptions {
  sourceFilter?: "vendor_rss" | "investor_relations" | "wire" | "procurement" | "all";
  maxSourcesPerRun?: number;
  sourceOffset?: number;
  dryRun?: boolean;
  /** Cap on LLM extractions per invocation — keeps each batch inside the 60s budget. */
  maxExtractions?: number;
  /** Tag for the IngestionRun record (e.g. "manual", "cron"). Defaults by dryRun. */
  runType?: string;
  /**
   * Wall-clock budget for starting new LLM calls, ms, measured from the END of
   * the crawl phase (crawling used to eat into it — a 25s feed timeout left a
   * few seconds for extraction). Defaults to 38s; the API routes pass a value
   * sized to their maxDuration, local scripts pass minutes.
   */
  timeBudgetMs?: number;
  /**
   * Parallel model calls. Defaults to 4; cost per article is identical, only
   * wall-clock changes. Sequential (1) could not use even the 38s budget.
   */
  concurrency?: number;
  /**
   * Skip articles published more than this many days ago BEFORE any model
   * spend. Google News search feeds surface evergreen items from years back;
   * for a market-intelligence feed those are noise, and they were filling the
   * review queue. Defaults to 60. Pass 0 for a deliberate historical backfill.
   */
  maxArticleAgeDays?: number;
  /**
   * Re-evaluate URLs previously recorded as excluded (rules or model). Off by
   * default so a sweep never re-buys the same rejection; a backfill after a
   * rule change turns it on.
   */
  reprocessExcluded?: boolean;
  /** Explicit source list — overrides sourceFilter/offset/window. For backfills. */
  sources?: SourceDefinition[];
  /** Skip crawling and process exactly these articles — for reprocessing stored rows and tests. */
  articles?: RawArticle[];
}

/** Total number of crawlable sources (for callers computing a rotating window). */
export const TOTAL_SOURCES = ALL_SOURCES.length;

/**
 * Model budget for a request-bound run. Routes declare maxDuration 300 (Fluid
 * Compute); crawl (≤30s) + this + one in-flight 20s call stays under it.
 */
export const ROUTE_TIME_BUDGET_MS = 200_000;

/** The daily scheduled sweep: every source, one fire, request-bound budget. */
export const SCHEDULED_SWEEP: PipelineOptions = {
  sourceFilter: "all",
  maxSourcesPerRun: TOTAL_SOURCES,
  maxExtractions: 600,
  concurrency: 4,
  timeBudgetMs: ROUTE_TIME_BUDGET_MS,
};

export interface PipelineProgress {
  phase: "crawling" | "classifying" | "storing" | "done";
  sourcesAvailable: number;
  sourcesProcessed: number;
  sourcesTotal: number;
  articlesFound: number;
  articlesDuped: number;
  articlesIrrelevant: number;
  eventsExtracted: number;
  eventsPublished: number;
  eventsQueued: number;
  eventsDeferred: number;
  /** Articles actually put through the LLM this run (incl. ones judged EXCLUDED). */
  articlesProcessed: number;
  /** Duplicates dropped BEFORE any LLM spend (title similarity). */
  articlesPreDeduped: number;
  /** Duplicates collapsed after triage, before analysis spend (entity key). */
  articlesEntityDeduped: number;
  /** Skipped for age before any model spend (maxArticleAgeDays). */
  articlesStale: number;
  /** Survived rules, vendor gate and age cutoff — the model candidates. */
  articlesRelevant: number;
  /** Candidates the triage model actually saw this run. */
  articlesTriaged: number;
  /** Triage/analysis judged out of scope; persisted so they are never re-bought. */
  articlesExcluded: number;
  /** Attached to an already-stored event instead of creating a new one. */
  articlesMerged: number;
  /** Real token spend for this run. */
  usage: TokenUsage;
  currentSource?: string;
  errors: string[];
}

function hashArticle(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/** Feed dates arrive in every format; an unparseable one must become null, not an Invalid Date row. */
function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Record an article the pipeline rejected, with the reason, so the URL is
 * skipped by the seen-URL check on every later run. Before this, a rejection
 * left no row: the same article came back as "new" next sweep and consumed
 * the model budget again, which is the main reason sweeps looked at ~2% of
 * candidates. Also the audit trail the review UI lacked ("why isn't X in?").
 */
async function persistExclusions(
  rows: { article: RawArticle; reason: string; confidence?: number }[], runId: string,
): Promise<string | null> {
  if (rows.length === 0) return null;
  try {
    for (let i = 0; i < rows.length; i += 500) {
      await prisma.sourceEvent.createMany({
        data: rows.slice(i, i + 500).map(({ article, reason, confidence }) => ({
          sourceUrl: article.url,
          rawTextHash: hashArticle(article.url),
          sourceTitle: article.title.slice(0, 300),
          sourceName: article.provider,
          sourceType: article.sourceType,
          publicationDate: parseDate(article.publishedAt),
          // The text the model judged, so an exclusion can be audited later.
          rawText: article.bodyText ?? article.snippet ?? null,
          publisherUrl: article.publisherUrl ?? null,
          extractedFamily: "EXCLUDED",
          extractionConfidence: confidence ?? 0,
          processingStatus: "excluded",
          exclusionReason: reason.slice(0, 120),
          ingestionRunId: runId,
        })),
        skipDuplicates: true,
      });
    }
    return null;
  } catch (err) {
    return `Persisting exclusions failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function pickSources(filter: PipelineOptions["sourceFilter"]) {
  if (filter === "vendor_rss") return VENDOR_RSS_SOURCES;
  if (filter === "investor_relations") return INVESTOR_RELATIONS_SOURCES;
  if (filter === "procurement") return PROCUREMENT_SOURCES;
  if (filter === "wire") return [...WIRE_SOURCES, ...GOOGLE_NEWS_SOURCES];
  return ALL_SOURCES;
}

async function resolveVendorId(vendorName: string | null): Promise<string | null> {
  if (!vendorName) return null;
  const entity = await prisma.entity.findFirst({
    where: {
      OR: [
        { canonicalName: { equals: vendorName } },
        { aliases: { some: { alias: { equals: vendorName } } } },
      ],
    },
    select: { id: true },
  });
  return entity?.id ?? null;
}

type StoreOutcome = { outcome: "published" | "queued" | "excluded"; eventId?: string };

async function storeEvent(article: RawArticle, result: ExtractionResult, runId: string): Promise<StoreOutcome> {
  if (result.family === "EXCLUDED") return { outcome: "excluded" };
  // §3/§6/§23 — an unclassifiable article (e.g. a procurement notice with no
  // award evidence, or a rule-based fallback after model failure) must not be
  // stored under a guessed family. Withhold rather than manufacture an event.
  if (!CANONICAL_FAMILIES.has(result.family)) return { outcome: "excluded" };

  // Idempotent by sourceUrl. A row recorded as EXCLUDED is not "already
  // processed": under reprocessExcluded the article has been re-evaluated and
  // admitted, so the exclusion row gives way to the event. Anything else with
  // this URL is a real earlier result.
  const existing = await prisma.sourceEvent.findUnique({ where: { sourceUrl: article.url }, select: { id: true, processingStatus: true } });
  if (existing && existing.processingStatus !== "excluded") return { outcome: "excluded" };
  if (existing) await prisma.sourceEvent.delete({ where: { id: existing.id } });

  const vendorId = await resolveVendorId(result.vendorRaw);

  // Publication gate — evidence rules (see gate.ts). Every routing to review
  // carries its reasons; an event type the model invented is normalised to
  // the family default rather than stored.
  const { status: publicationStatus, reason: reviewReason } = decidePublication(result, article, vendorId);
  const eventType = result.eventTypeValid
    ? result.eventType
    : defaultEventType(result.family, `${article.title} ${article.bodyText ?? article.snippet ?? ""}`);

  // Resolve the counterparty and run the comparable-TCV inference BEFORE the
  // transaction. Both are round-trips; inside the transaction they pushed it
  // past Prisma's 5s interactive limit under concurrency ("A query cannot be
  // executed on an expired transaction") and the whole event rolled back.
  const clientId = result.family === "CONTRACT" ? await resolveVendorId(result.clientRaw) : null;
  // Value policy (2026-09-08): a disclosed figure is a fact and lives in
  // tcvCommittedUsd; anything else is an ESTIMATE range, labelled with its
  // basis. The extraction model's range (it read the article) is preferred and
  // sanity-clamped to the segment's disclosed envelope; the comparable engine
  // is the fallback. Undisclosed contracts should rarely be left without one.
  const disclosed = result.tcvUsd && !result.tcvIsEstimate ? result.tcvUsd : null;
  let estimate: { lowUsd: number; highUsd: number; basis: string } | null = null;
  if (result.family === "CONTRACT" && !disclosed) {
    if (result.tcvEstimateLowUsd && result.tcvEstimateHighUsd) {
      const c = await clampEstimate(article.sourceType, result.tcvEstimateLowUsd, result.tcvEstimateHighUsd);
      estimate = { lowUsd: c.lowUsd, highUsd: c.highUsd, basis: `${MODEL_ESTIMATE_BASIS}: ${(result.tcvEstimateRationale ?? "range from scope and term").slice(0, 160)}${c.clamped ? " (clamped)" : ""}` };
    } else {
      const v = await inferTcv({ serviceLine: result.primaryMacroServiceLine, sourceType: article.sourceType, contractLengthMonths: result.contractLengthMonths, disclosedUsd: null });
      if (v.state === "INFERRED") estimate = { lowUsd: v.lowUsd, highUsd: v.highUsd, basis: v.basis };
    }
  }

  let eventId = "";
  await prisma.$transaction(async (tx) => {
    const sourceEvent = await tx.sourceEvent.create({
      data: {
        sourceUrl: article.url,
        rawTextHash: hashArticle(article.url),
        sourceTitle: article.title.slice(0, 300),
        sourceName: article.provider,
        sourceType: article.sourceType,
        publicationDate: parseDate(article.publishedAt),
        rawText: article.bodyText ?? article.snippet ?? null,
        publisherUrl: article.publisherUrl ?? null,
        extractedFamily: result.family,
        extractionConfidence: result.confidenceScore,
        processingStatus: "extracted",
        ingestionRunId: runId,
      },
    });

    const event = await tx.canonicalMarketEvent.create({
      data: {
        family: result.family,
        eventType,
        canonicalTitle: result.canonicalTitle.slice(0, 500),
        announcementDate: parseDate(article.publishedAt),
        // §8 — provenance must reflect the evidence. This was hardcoded to
        // "explicit", asserting a sourced date even when none existed. It is
        // now derived: "explicit" only when the source supplied a date.
        // Ingestion/processing timestamps are never used as a substitute.
        announcementDateBasis: article.publishedAt ? "explicit" : "unavailable",
        geography: JSON.stringify(result.geography),
        industry: result.industry,
        industryBasis: result.industry ? "classified" : "unavailable",
        confidenceScore: result.confidenceScore,
        commercialRelevanceScore: result.tcvUsd ? Math.min(0.95, 0.6 + result.confidenceScore * 0.35) : result.confidenceScore * 0.8,
        humanReviewRequired: publicationStatus === "needs_review",
        publicationStatus,
        reviewReason,
        counterpartyRaw: result.clientRaw,
        analystInsight: result.analystInsight,
        originalArticleUrl: article.publisherUrl ?? article.url,
        primaryEntityId: vendorId,
        sourceEvents: { connect: { id: sourceEvent.id } },
      },
    });

    // Store family-specific details
    if (result.family === "CONTRACT") {
      await tx.contractDetails.create({
        data: {
          canonicalEventId: event.id,
          vendorId: vendorId ?? undefined,
          vendorRaw: result.vendorRaw,
          vendorConfidence: vendorId ? 0.9 : 0.6,
          clientRaw: result.clientRaw,
          clientId: clientId ?? undefined,
          clientConfidence: clientId ? 0.85 : 0.5,
          contractEventType: eventType,
          tcvCommittedUsd: disclosed,
          tcvEstimateLowUsd: estimate?.lowUsd ?? null,
          tcvEstimateMidUsd: estimate ? Math.round((estimate.lowUsd + estimate.highUsd) / 2) : null,
          tcvEstimateHighUsd: estimate?.highUsd ?? null,
          tcvBasis: disclosed ? "official_disclosed" : (estimate ? estimate.basis : "insufficient_evidence"),
          tcvIsEstimate: !!estimate,
          // §10/§16 external vocabulary: KNOWN / ESTIMATED / NOT RELIABLY ESTIMABLE
          tcvConfidence: disclosed ? "known" : (estimate ? "estimated" : "not_reliably_estimable"),
          contractLengthMonths: result.contractLengthMonths,
          primaryMacroServiceLine: result.primaryMacroServiceLine,
          scopeSummary: result.summary ?? article.snippet?.slice(0, 500) ?? null,
          platformsUsed: "[]",
          clientServiceCoverageLocation: JSON.stringify(result.geography),
          secondaryMacroServiceLines: "[]",
          secondaryMicroServiceLines: "[]",
        },
      });
    }
    // Other families: store minimal details (can be enriched in review)
    eventId = event.id;
  }, { timeout: 20_000, maxWait: 10_000 });

  return { outcome: publicationStatus === "published" ? "published" : "queued", eventId };
}

/**
 * Record an article as an additional source of an event that already exists —
 * a re-report from another outlet, or the same story on a later day. The
 * event keeps one row and gains corroboration; nothing is analysed twice.
 */
async function attachSource(article: RawArticle, t: TriageResult, eventId: string, runId: string): Promise<void> {
  const data = {
    rawTextHash: hashArticle(article.url),
    sourceTitle: article.title.slice(0, 300),
    sourceName: article.provider,
    sourceType: article.sourceType,
    publicationDate: parseDate(article.publishedAt),
    rawText: article.bodyText ?? article.snippet ?? null,
    publisherUrl: article.publisherUrl ?? null,
    extractedFamily: t.family,
    extractionConfidence: t.confidenceScore,
    processingStatus: "extracted",
    exclusionReason: null,
    ingestionRunId: runId,
    canonicalEvents: { connect: { id: eventId } },
  };
  // Upsert: under reprocessExcluded the URL may already exist as an exclusion row.
  await prisma.sourceEvent.upsert({ where: { sourceUrl: article.url }, create: { sourceUrl: article.url, ...data }, update: data });
}

/**
 * The stored event this article re-reports, if any.
 *  1. Same publisher page already stored (the same article under two vendor
 *     feeds) → its event; if that page was stored without an event (excluded),
 *     the article is skipped.
 *  2. Same family, same resolved vendor, announcement within ±14 days, and a
 *     counterparty that matches after normalisation → that event.
 * A missing vendor entity or counterparty is a weak key: no merge.
 */
async function findStoredEvent(article: RawArticle, t: TriageResult, vendorId: string | null):
  Promise<{ eventId: string } | { skip: true } | null> {
  if (article.publisherUrl) {
    const same = await prisma.sourceEvent.findFirst({
      where: { publisherUrl: article.publisherUrl },
      select: { processingStatus: true, canonicalEvents: { select: { id: true }, take: 1 } },
    });
    if (same) return same.canonicalEvents[0] ? { eventId: same.canonicalEvents[0].id } : { skip: true };
  }
  if (!vendorId) return null;
  const when = parseDate(article.publishedAt);
  if (!when) return null;
  // With a counterparty the match is on the organisation within ±14 days.
  // Without one (results, org changes, launches) it is a title match within a
  // week — and only when the stored event has no counterparty either, so a
  // contract is never merged into a different contract on wording alone.
  const hasCounterparty = !!t.clientRaw?.trim();
  const windowDays = hasCounterparty ? SAME_EVENT_WINDOW_DAYS : SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY;
  const pad = windowDays * 86_400_000;
  const candidates = await prisma.canonicalMarketEvent.findMany({
    where: {
      family: t.family,
      primaryEntityId: vendorId,
      announcementDate: { gte: new Date(when.getTime() - pad), lte: new Date(when.getTime() + pad) },
      publicationStatus: { not: "excluded_noise" },
    },
    select: { id: true, counterpartyRaw: true, canonicalTitle: true, announcementDate: true, contractDetails: { select: { clientRaw: true } } },
    take: 50,
  });
  for (const c of candidates) {
    if (!withinDays(when, c.announcementDate, windowDays)) continue;
    if (amountsConflict(article.title, c.canonicalTitle)) continue;
    const similar = titleSimilarity(t.canonicalTitle, c.canonicalTitle);
    // Results announcements are re-reported under unrelated headlines within
    // the week — but a results release and a same-week fundraise are two
    // events, so the headlines must still share something.
    if (VENDOR_WINDOW_FAMILIES.has(t.family)) { if (similar >= RESULTS_TITLE_THRESHOLD) return { eventId: c.id }; continue; }
    const counterparty = c.counterpartyRaw ?? c.contractDetails?.clientRaw ?? titleCounterparty(c.canonicalTitle);
    if (hasCounterparty) {
      if (counterparty && orgsMatch(t.clientRaw, counterparty)) return { eventId: c.id };
      // Acronym vs full name ("STTGDC" / "ST Telemedia Global Data Centres"): the headlines decide.
      if (counterparty && similar >= TITLE_FALLBACK_THRESHOLD) return { eventId: c.id };
    } else if (!counterparty && !COUNTERPARTY_FAMILIES.has(t.family) && similar >= TITLE_MATCH_THRESHOLD) {
      return { eventId: c.id };
    }
  }
  return null;
}


// ── Pre-extraction dedup ─────────────────────────────────────────────────────
// Duplicates are cheapest to kill BEFORE the LLM runs. Each source reports the
// same event under a slightly different headline, so URL-level dedup does not
// catch them and every copy costs a full extraction (~$0.0068) to discover.
// Measured: ~6% of new events duplicate something already stored, on top of
// duplicates within the same batch.
//
// Deliberately conservative — Jaccard over UNION, a minimum token count and a
// same-day-ish window. A looser rule risks discarding genuinely distinct deals
// that merely share a vendor name, which is far worse than paying to extract a
// duplicate we later collapse.
const DUP_JACCARD = 0.75;
const DUP_DAYS = 7;

function titleTokens(t: string): Set<string> {
  return new Set(
    t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()
      .split(" ").filter(w => w.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  a.forEach(w => { if (b.has(w)) inter++; });
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Drops articles that duplicate (a) an event already stored or (b) an earlier
 * article in this same batch. Returns the survivors.
 */
async function dropDuplicateArticles(articles: RawArticle[]): Promise<{ kept: RawArticle[]; dropped: number }> {
  if (articles.length === 0) return { kept: [], dropped: 0 };

  const dates = articles.map(a => (a.publishedAt ? new Date(a.publishedAt).getTime() : 0)).filter(Boolean);
  const pad = DUP_DAYS * 86_400_000;
  const existing = await prisma.canonicalMarketEvent.findMany({
    where: dates.length
      ? { announcementDate: { gte: new Date(Math.min(...dates) - pad), lte: new Date(Math.max(...dates) + pad) } }
      : {},
    select: { canonicalTitle: true, announcementDate: true },
    take: 20_000,
  });
  const priors = existing.map(e => ({ tk: titleTokens(e.canonicalTitle), t: e.announcementDate?.getTime() ?? 0 }));

  const kept: RawArticle[] = [];
  const batch: { tk: Set<string>; t: number }[] = [];
  let dropped = 0;

  for (const a of articles) {
    const tk = titleTokens(a.title);
    const t = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    if (tk.size < 4) { kept.push(a); batch.push({ tk, t }); continue; }
    const clash = (list: { tk: Set<string>; t: number }[]) =>
      list.some(o => Math.abs(o.t - t) / 86_400_000 <= DUP_DAYS && jaccard(tk, o.tk) >= DUP_JACCARD);
    if (clash(priors) || clash(batch)) { dropped++; continue; }
    kept.push(a);
    batch.push({ tk, t });
  }
  return { kept, dropped };
}


/**
 * Same-run twin test: same family and vendor, and either matching
 * counterparties within ±14 days or — when neither names one — similar titles
 * within a week. Mirrors findStoredEvent for articles not yet stored.
 */
function sameStagedEvent(a: { article: RawArticle; triage: TriageResult }, b: { article: RawArticle; triage: TriageResult }, whenB: Date | null): boolean {
  if (a.triage.family !== b.triage.family) return false;
  if ((a.triage.vendorRaw ?? "").toLowerCase() !== (b.triage.vendorRaw ?? "").toLowerCase()) return false;
  const whenA = parseDate(a.article.publishedAt);
  if (amountsConflict(a.article.title, b.article.title)) return false;
  if (VENDOR_WINDOW_FAMILIES.has(a.triage.family)) {
    return withinDays(whenA, whenB, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY)
      && titleSimilarity(a.triage.canonicalTitle, b.triage.canonicalTitle) >= RESULTS_TITLE_THRESHOLD;
  }
  const ca = a.triage.clientRaw?.trim(), cb = b.triage.clientRaw?.trim();
  if (ca && cb) {
    if (!withinDays(whenA, whenB, SAME_EVENT_WINDOW_DAYS)) return false;
    return orgsMatch(ca, cb) || titleSimilarity(a.triage.canonicalTitle, b.triage.canonicalTitle) >= TITLE_FALLBACK_THRESHOLD;
  }
  if (ca || cb || COUNTERPARTY_FAMILIES.has(a.triage.family)) return false;
  return withinDays(whenA, whenB, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY)
    && titleSimilarity(a.triage.canonicalTitle, b.triage.canonicalTitle) >= TITLE_MATCH_THRESHOLD;
}

// ── Sync source registry from definitions ─────────────────────────────────────
// Reconciles the SourceRegistryItem table to exactly match ALL_SOURCES:
// upserts every code-defined source and deactivates anything stale (sources
// removed from code). Runs in parallel chunks so it doesn't stall on a cold DB.
export async function syncSourceRegistry(): Promise<void> {
  const codeUrls = new Set(ALL_SOURCES.map(s => s.url));
  const codeIds = new Set(ALL_SOURCES.map(s => s.id));

  const upsertOne = async (src: (typeof ALL_SOURCES)[number]) => {
    try {
      const existing = await prisma.sourceRegistryItem.findFirst({
        where: { OR: [{ url: src.url }, { id: src.id }] },
      });
      if (existing) {
        await prisma.sourceRegistryItem.update({
          where: { id: existing.id },
          data: { name: src.name, provider: src.provider, url: src.url, sourceType: src.sourceType, tier: src.tier, fetchMethod: src.fetchMethod, isActive: true },
        });
      } else {
        await prisma.sourceRegistryItem.create({
          data: { id: src.id, name: src.name, provider: src.provider, url: src.url, sourceType: src.sourceType, tier: src.tier, fetchMethod: src.fetchMethod, isActive: true },
        });
      }
    } catch {
      // Skip individual source sync failures — don't block the pipeline
    }
  };

  // Upsert in parallel chunks of 20
  for (let i = 0; i < ALL_SOURCES.length; i += 20) {
    await Promise.all(ALL_SOURCES.slice(i, i + 20).map(upsertOne));
  }

  // Deactivate registry rows that no longer exist in code (stale accumulation)
  try {
    const all = await prisma.sourceRegistryItem.findMany({ where: { isActive: true }, select: { id: true, url: true } });
    const staleIds = all.filter(r => !codeUrls.has(r.url) && !codeIds.has(r.id)).map(r => r.id);
    if (staleIds.length) {
      await prisma.sourceRegistryItem.updateMany({ where: { id: { in: staleIds } }, data: { isActive: false } });
    }
  } catch {
    // tolerate
  }
}

// ── Main pipeline run ─────────────────────────────────────────────────────────
export async function runPipeline(
  options: PipelineOptions = {},
  onProgress?: (p: PipelineProgress) => void,
  existingRunId?: string,
): Promise<PipelineProgress> {
  const {
    sourceFilter = "all", maxSourcesPerRun = 10, sourceOffset = 0, dryRun = false,
    maxExtractions = 400, runType, timeBudgetMs = 38_000, concurrency = 4,
    maxArticleAgeDays = 60, reprocessExcluded = false,
  } = options;
  // The budget applies to STARTING model calls and is measured from the end of
  // the crawl (llmStart, below). Callers size it to their ceiling: an API route
  // with maxDuration 300 passes ~200s so crawl + budget + one in-flight 20s
  // call still reaches the final DB write.

  // Use existing run record if provided (from after() pattern), otherwise create one
  const run = existingRunId
    ? { id: existingRunId }
    : await prisma.ingestionRun.create({
        data: { runType: runType ?? (dryRun ? "dry_run" : "manual"), sourceFilter: sourceFilter ?? null },
      });

  const allPickedSources = options.sources ?? pickSources(sourceFilter);
  const sources = options.sources ?? allPickedSources.slice(sourceOffset, sourceOffset + maxSourcesPerRun);
  const progress: PipelineProgress = {
    phase: "crawling",
    sourcesAvailable: allPickedSources.length,
    sourcesProcessed: 0,
    sourcesTotal: sources.length,
    articlesFound: 0,
    articlesDuped: 0,
    articlesIrrelevant: 0,
    eventsExtracted: 0,
    eventsPublished: 0,
    eventsQueued: 0,
    eventsDeferred: 0,
    articlesProcessed: 0,
    articlesPreDeduped: 0,
    articlesEntityDeduped: 0,
    articlesStale: 0,
    articlesRelevant: 0,
    articlesTriaged: 0,
    articlesExcluded: 0,
    articlesMerged: 0,
    usage: { ...EMPTY_USAGE, tiers: [] },
    errors: [],
  };

  const allArticles: RawArticle[] = [...(options.articles ?? [])];
  progress.articlesFound = allArticles.length;

  // Phase 1: Crawl — parallel with concurrency cap (skipped when articles were supplied)
  const CRAWL_CONCURRENCY = 15;
  let crawlCursor = options.articles ? sources.length : 0;
  async function crawlWorker() {
    while (true) {
      const idx = crawlCursor++;
      if (idx >= sources.length) return;
      const source = sources[idx];
      try {
        const { articles, error } = await crawlSource(source);
        if (error) {
          progress.errors.push(`${source.name}: ${error}`);
          await prisma.sourceRegistryItem.updateMany({
            where: { url: source.url },
            data: { consecutiveErrors: { increment: 1 }, lastError: error, lastCrawledAt: new Date() },
          }).catch(() => {});
        } else {
          allArticles.push(...articles);
          progress.articlesFound += articles.length;
          // A publisher/wire feed that answers 200 with nothing is treated as
          // failing: two Business Wire channels sat "OK" for weeks while
          // returning zero items. A Google News search feed is different — a
          // small vendor can genuinely have no news in its window (13 of 118
          // on a quiet day), so that is noted, not counted as an error. A
          // feed at exactly the cap has lost items past the window — flagged.
          const isGnews = source.id.startsWith("gnews-");
          const empty = articles.length === 0;
          const atCap = isGnews && articles.length >= GNEWS_ITEM_CAP;
          await prisma.sourceRegistryItem.updateMany({
            where: { url: source.url },
            data: {
              consecutiveErrors: empty && !isGnews ? { increment: 1 } : 0,
              lastError: empty ? (isGnews ? "0 items in the search window" : "0 items — feed reachable but empty")
                : atCap ? `at the ${GNEWS_ITEM_CAP}-item cap — shorten the query window` : null,
              lastCrawledAt: new Date(), lastItemCount: articles.length,
              nextDueAt: new Date(Date.now() + source.refreshHours * 3_600_000),
            },
          }).catch(() => {});
        }
      } catch (err) {
        progress.errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      progress.sourcesProcessed++;
    }
  }
  await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, crawlWorker));

  if (dryRun) {
    progress.phase = "done";
    await prisma.ingestionRun.update({ where: { id: run.id }, data: { status: "completed", completedAt: new Date(), articlesFound: progress.articlesFound } });
    return progress;
  }

  // Phase 2: Classify + store
  progress.phase = "classifying";
  onProgress?.(progress);

  // One article can arrive from several feeds (the same story under two
  // vendors' Google News queries shares a URL). Collapse those first — the
  // second copy used to pay for triage and then be refused at store time.
  const byUrl = new Map<string, RawArticle>();
  for (const a of allArticles) if (!byUrl.has(a.url)) byUrl.set(a.url, a);
  const uniqueArticles = [...byUrl.values()];

  // Filter already-seen URLs before expensive LLM calls. Rows recorded as
  // "excluded" count as seen unless a backfill asks to re-evaluate them.
  const seenUrls = new Set<string>();
  const urls = uniqueArticles.map(a => a.url);
  for (let i = 0; i < urls.length; i += 2000) {
    const existing = await prisma.sourceEvent.findMany({
      where: {
        sourceUrl: { in: urls.slice(i, i + 2000) },
        ...(reprocessExcluded ? { processingStatus: { not: "excluded" } } : {}),
      },
      select: { sourceUrl: true },
    });
    existing.forEach(e => seenUrls.add(e.sourceUrl));
  }

  const newArticles = uniqueArticles.filter(a => !seenUrls.has(a.url));
  progress.articlesDuped = allArticles.length - newArticles.length;

  // Age cutoff BEFORE any model spend. Measured 2026-09: 75% of candidates
  // were older than 90 days, 40% older than a year. Undated items are kept —
  // there is nothing to judge them on.
  const ageCutoff = maxArticleAgeDays > 0 ? Date.now() - maxArticleAgeDays * 86_400_000 : null;
  const freshArticles = newArticles.filter(a => {
    if (ageCutoff === null) return true;
    const d = parseDate(a.publishedAt);
    return d === null || d.getTime() >= ageCutoff;
  });
  progress.articlesStale = newArticles.length - freshArticles.length;

  // Cheap relevance pre-filter BEFORE any LLM spend — drops obvious noise
  // (rankings, marketing, opinion pieces) for free via regex.
  //
  // Market-wide sources (wire services, procurement) are not tied to a vendor
  // and return large volumes of unrelated industry news, so they additionally
  // must name one of the TRACKED_VENDORS. Vendor-specific sources (per-vendor
  // Google News, vendor press, IR) are already scoped by construction.
  //
  // Every rejection is persisted with its reason (see persistExclusions).
  const ruleExclusions: { article: RawArticle; reason: string }[] = [];
  const relevantArticles = freshArticles.filter(a => {
    const verdict = isRelevantArticle(a.title, a.sourceType);
    if (!verdict.relevant) { ruleExclusions.push({ article: a, reason: verdict.reason ?? "rules:excluded" }); return false; }
    if (a.provider === "Market Wide" && !mentionsTrackedVendor(`${a.title} ${a.snippet ?? ""}`)) {
      ruleExclusions.push({ article: a, reason: "rules:vendor_gate" });
      return false;
    }
    return true;
  });
  progress.articlesIrrelevant = freshArticles.length - relevantArticles.length;
  {
    const err = await persistExclusions(ruleExclusions, run.id);
    if (err) progress.errors.push(err);
  }

  // Kill duplicates before the LLM sees them — the only point where a duplicate
  // costs nothing instead of a full extraction.
  const { kept: dedupedArticles, dropped: preDupes } = await dropDuplicateArticles(relevantArticles);
  progress.articlesPreDeduped = preDupes;
  progress.articlesRelevant = dedupedArticles.length;

  // Hard cap on LLM calls so a batch always finishes inside the time budget.
  // Articles beyond the cap stay unstored and are re-crawled on the next run.
  //
  // Concurrency defaults to 1 (strictly sequential) so the serverless path is
  // unchanged. Long-running backfills raise it to drain a backlog that would
  // otherwise take hours at ~3s per extraction.
  // ── PHASE 1: EXTRACT ────────────────────────────────────────────────────────
  // Cheap triage on every candidate. Produces the entities we dedupe on.
  let llmCalls = 0;
  let cursor = 0;
  const llmStart = Date.now();
  const shouldStop = () => llmCalls >= maxExtractions || Date.now() - llmStart > timeBudgetMs;
  const addUsageTo = (u: TokenUsage) => {
    progress.usage = {
      inputTokens: progress.usage.inputTokens + u.inputTokens,
      outputTokens: progress.usage.outputTokens + u.outputTokens,
      cacheWriteTokens: progress.usage.cacheWriteTokens + u.cacheWriteTokens,
      cacheReadTokens: progress.usage.cacheReadTokens + u.cacheReadTokens,
      costUsd: progress.usage.costUsd + u.costUsd,
      tiers: progress.usage.tiers,
    };
  };

  interface Staged { article: RawArticle; triage: TriageResult }
  const staged: Staged[] = [];

  async function triageWorker() {
    while (true) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= dedupedArticles.length) return;
      const raw = dedupedArticles[i];
      llmCalls++;
      try {
        // Publisher page first: a headline is not enough evidence to classify,
        // dedupe or value an event, and for Google News items it is all the
        // feed provides. Best-effort — a failed fetch falls back to the
        // headline, never to a guess.
        const { publisherUrl, article: body } = await retrieveArticle(raw.url);
        const article: RawArticle = { ...raw, publisherUrl: publisherUrl ?? null, bodyText: body?.text ?? null };
        const t = await triageArticle({ ...article, bodyText: article.bodyText?.slice(0, TRIAGE_BODY_CHARS) ?? null });
        if (!t) continue;                        // model failure — not a fact (§23)
        addUsageTo(t.usage);
        staged.push({ article, triage: t });
      } catch (err) {
        progress.errors.push(`Triage error (${raw.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, triageWorker));

  progress.articlesTriaged = staged.length;

  // ── PHASE 2: DEDUPE ─────────────────────────────────────────────────────────
  // Collapse on extracted entities, before any analysis spend. Triage
  // rejections stop here and are persisted with the model's reason.
  const survivors: Staged[] = [];
  const modelExclusions: { article: RawArticle; reason: string; confidence?: number }[] = [];
  // Same-run re-reports of a survivor, attached to its event once stored.
  const corroborations = new Map<number, Staged[]>();
  for (const st of staged) {
    if (st.triage.family === "EXCLUDED") {
      modelExclusions.push({ article: st.article, reason: st.triage.exclusionReason ?? "model:excluded_noise", confidence: st.triage.confidenceScore });
      continue;
    }
    const when = parseDate(st.article.publishedAt);
    const twin = survivors.findIndex(sv => sameStagedEvent(sv, st, when));
    if (twin >= 0) {
      progress.articlesEntityDeduped++;
      corroborations.set(twin, [...(corroborations.get(twin) ?? []), st]);
      continue;
    }
    survivors.push(st);
  }

  // ── PHASE 3: ANALYSE ────────────────────────────────────────────────────────
  // Expensive tier only for survivors that warrant it.
  let aCursor = 0;
  async function analyseWorker() {
    while (true) {
      const i = aCursor++;
      if (i >= survivors.length) return;
      const { article, triage: t } = survivors[i];
      try {
        // Already stored from another feed or an earlier run? Attach, don't analyse.
        const vendorId = await resolveVendorId(t.vendorRaw);
        const stored = await findStoredEvent(article, t, vendorId);
        if (stored && "skip" in stored) continue;
        if (stored) {
          await attachSource(article, t, stored.eventId, run.id);
          for (const twin of corroborations.get(i) ?? []) await attachSource(twin.article, twin.triage, stored.eventId, run.id).catch(() => {});
          progress.articlesMerged += 1 + (corroborations.get(i)?.length ?? 0);
          continue;
        }
        let result: ExtractionResult;
        if (t.needsAnalysis && Date.now() - llmStart <= timeBudgetMs) {
          result = await analyseArticle(article, t);
          addUsageTo(result.usage);   // analysis spend only — triage counted in phase 1
        } else {
          result = resultFromTriage(article, t);
        }
        if (result.family === "EXCLUDED") {
          modelExclusions.push({ article, reason: result.exclusionReason ?? "model:excluded_noise", confidence: result.confidenceScore });
          continue;
        }
        progress.eventsExtracted++;
        progress.phase = "storing";
        const { outcome, eventId } = await storeEvent(article, result, run.id);
        if (outcome === "published") progress.eventsPublished++;
        else if (outcome === "queued") progress.eventsQueued++;
        if (eventId) {
          for (const twin of corroborations.get(i) ?? []) {
            await attachSource(twin.article, twin.triage, eventId, run.id).catch(() => {});
            progress.articlesMerged++;
          }
        }
      } catch (err) {
        progress.errors.push(`Analysis error (${article.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, analyseWorker));

  progress.articlesProcessed = Math.min(cursor, dedupedArticles.length);
  progress.eventsDeferred = Math.max(0, dedupedArticles.length - cursor);
  progress.articlesExcluded = modelExclusions.length;
  {
    const err = await persistExclusions(modelExclusions, run.id);
    if (err) progress.errors.push(err);
  }

  progress.phase = "done";
  await prisma.ingestionRun.update({
    where: { id: run.id },
    data: {
      status: progress.errors.length > newArticles.length * 0.3 ? "partial" : "completed",
      completedAt: new Date(),
      articlesFound: progress.articlesFound,
      articlesDuped: progress.articlesDuped,
      eventsExtracted: progress.eventsExtracted,
      eventsPublished: progress.eventsPublished,
      eventsQueued: progress.eventsQueued,
      articlesRelevant: progress.articlesRelevant,
      articlesStale: progress.articlesStale,
      articlesTriaged: progress.articlesTriaged,
      articlesExcluded: progress.articlesExcluded,
      articlesDeferred: progress.eventsDeferred,
      articlesMerged: progress.articlesMerged,
      errors: JSON.stringify(progress.errors.slice(0, 20)),
      inputTokens: progress.usage.inputTokens,
      outputTokens: progress.usage.outputTokens,
      costUsd: progress.usage.costUsd,
    },
  });

  return progress;
}
