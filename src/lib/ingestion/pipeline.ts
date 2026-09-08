import crypto from "crypto";
import { prisma } from "@/lib/db";
import { ALL_SOURCES, VENDOR_RSS_SOURCES, INVESTOR_RELATIONS_SOURCES, PROCUREMENT_SOURCES, WIRE_SOURCES, GOOGLE_NEWS_SOURCES,
         GNEWS_ITEM_CAP, SourceDefinition, selectArticle } from "./sources";
import { crawlSource, RawArticle } from "./crawler";
import { EMPTY_USAGE, TokenUsage } from "./classifier";
import { retrieveArticle, readableArticleText } from "./article-text";
import { readArticle, type Reading } from "./reader";
import { storeReading, storeNonEvent, storePending, storeUnreadable } from "./store";

/** The reader gets the whole page; this only bounds pathological documents. */
const READER_MAX_CHARS = 60_000;

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
  /** Read failed (model unavailable / unreadable output) — kept as pending for a later run, never regex-classified. */
  articlesPending: number;
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
    articlesPending: 0,
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
        // Pending rows (model failure on an earlier run) are always re-read (§22).
        processingStatus: reprocessExcluded ? { notIn: ["excluded", "pending"] } : { not: "pending" },
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

  // Structural selection only. Market-wide wire feeds carry every company's
  // press releases, so an item naming no tracked vendor is dropped here for
  // free; everything else goes to the model, which reads the article and
  // decides what it is. The headline regexes that used to sit here excluded
  // real awards ("LTTS shares jump 3% after bagging $75M deal") and are gone.
  // Every rejection is persisted with its reason (see persistExclusions).
  const ruleExclusions: { article: RawArticle; reason: string }[] = [];
  const relevantArticles = freshArticles.filter(a => {
    const verdict = selectArticle(a);
    if (!verdict.relevant) { ruleExclusions.push({ article: a, reason: verdict.reason ?? "rules:excluded" }); return false; }
    return true;
  });
  progress.articlesIrrelevant = freshArticles.length - relevantArticles.length;
  {
    const err = await persistExclusions(ruleExclusions, run.id);
    if (err) progress.errors.push(err);
  }

  // No headline-similarity pre-dedup: the mandate permits only exact duplicates
  // before reading (§4). Re-reports are reconciled after the read, on identity.
  const dedupedArticles = relevantArticles;
  progress.articlesPreDeduped = 0;
  progress.articlesRelevant = dedupedArticles.length;

  // ── PHASE 1: READ ───────────────────────────────────────────────────────────
  // The model reads each article in full (segmented when long) and returns the
  // article type and every commercial event with its supporting passages. A
  // model failure marks the article pending for a later run — never a regex
  // fallback (§22). The budget applies to STARTING reads, measured from here.
  let llmCalls = 0;
  let cursor = 0;
  const llmStart = Date.now();
  const shouldStop = () => llmCalls >= maxExtractions || Date.now() - llmStart > timeBudgetMs;
  const addUsageTo = (u: Reading["usage"]) => {
    progress.usage = {
      inputTokens: progress.usage.inputTokens + u.inputTokens,
      outputTokens: progress.usage.outputTokens + u.outputTokens,
      cacheWriteTokens: progress.usage.cacheWriteTokens + u.cacheWriteTokens,
      cacheReadTokens: progress.usage.cacheReadTokens + u.cacheReadTokens,
      costUsd: progress.usage.costUsd + u.costUsd,
      tiers: progress.usage.tiers,
    };
  };
  interface Read { article: RawArticle; text: string; reading: Reading }
  const readings: Read[] = [];
  const pendings: { article: RawArticle; text: string; error: string }[] = [];
  const unreadable: { article: RawArticle }[] = [];

  async function readWorker() {
    while (true) {
      if (shouldStop()) return;
      const i = cursor++;
      if (i >= dedupedArticles.length) return;
      const raw = dedupedArticles[i];
      llmCalls++;
      try {
        // Fetch the publisher page (the whole page — §7). Supplied text (a stored
        // row being re-read, or a test fixture) is the fallback when the page
        // cannot be fetched, and wins when it is the longer copy.
        const fetched = await retrieveArticle(raw.url, READER_MAX_CHARS).catch(() => ({ publisherUrl: null, article: null }));
        const fetchedText = fetched.article?.text ?? null;
        const supplied = raw.bodyText ?? null;
        const bodyText = fetchedText && fetchedText.length >= (supplied?.length ?? 0) ? fetchedText : supplied;
        const article: RawArticle = { ...raw, publisherUrl: fetched.publisherUrl ?? raw.publisherUrl ?? null, bodyText };
        // Feed scaffolding is not an article: reading a link blob yields a
        // confident "no event", which is a false negative, not a verdict (§7).
        const text = readableArticleText(article.bodyText) ?? readableArticleText(article.snippet) ?? "";
        if (!text) { unreadable.push({ article }); continue; }
        const out = await readArticle({ title: article.title, text, provider: article.provider, sourceType: article.sourceType, publishedAt: article.publishedAt });
        addUsageTo(out.ok ? out.reading.usage : out.usage);
        if (!out.ok) { pendings.push({ article, text, error: out.error }); continue; }
        readings.push({ article, text, reading: out.reading });
      } catch (err) {
        progress.errors.push(`Read error (${raw.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, readWorker));
  progress.articlesTriaged = readings.length + pendings.length;
  for (const u of unreadable) {
    try { await storeUnreadable(u.article, run.id); }
    catch (err) { progress.errors.push(`Unreadable store error (${u.article.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`); }
  }
  for (const p of pendings) {
    try { await storePending(p.article, p.text, p.error, run.id); }
    catch (err) { progress.errors.push(`Pending store error (${p.article.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`); }
  }
  progress.articlesPending = pendings.length;

  // ── PHASE 2: STORE ──────────────────────────────────────────────────────────
  // Sequential by design: a re-report must be able to see the event stored a
  // moment earlier and attach to it rather than duplicate it.
  for (const r of readings) {
    try {
      progress.phase = "storing";
      if (r.reading.events.length === 0) { await storeNonEvent(r.article, r.text, r.reading, run.id); progress.articlesExcluded++; continue; }
      const c = await storeReading(r.article, r.text, r.reading, run.id);
      progress.eventsPublished += c.published;
      progress.eventsQueued += c.queued;
      progress.articlesMerged += c.merged;
      progress.eventsExtracted += c.published + c.queued;
      if (c.published + c.queued + c.merged === 0) progress.articlesExcluded++;   // events, but none with a tracked provider
    } catch (err) {
      progress.errors.push(`Store error (${r.article.url.slice(0, 60)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  progress.articlesProcessed = Math.min(cursor, dedupedArticles.length);
  progress.eventsDeferred = Math.max(0, dedupedArticles.length - cursor);

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
