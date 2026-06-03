/**
 * Semantic deduplication across all published CanonicalMarketEvent records.
 *
 * Strategy:
 *  1. Group events by (vendorRaw, clientRaw) — same pair within 90 days = candidate
 *  2. Within each group, generate all within-window pairs
 *  3. Send each pair to Claude Haiku for SAME / RELATED / DISTINCT verdict
 *  4. Write DedupDecision records
 *  5. Mark SAME duplicates as excluded_noise (keep lowest-confidence copy)
 */
import * as dotenv from "dotenv";
// Load .env first (base), then .env.local overrides (Vercel vars)
// ANTHROPIC_API_KEY lives in .env; DATABASE_URL lives in .env.local
dotenv.config({ path: ".env", override: true });
dotenv.config({ path: ".env.local", override: true });

import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set");
const adapter = new PrismaNeon({ connectionString });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter } as any);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");

const WINDOW_DAYS = 90;       // events within this window are candidates
const CONCURRENCY = 8;        // parallel Haiku calls
const PROGRESS_EVERY = 50;

interface EventRow {
  id: string;
  family: string;
  canonicalTitle: string;
  announcementDate: Date | null;
  confidenceScore: number;
  publicationStatus: string;
  vendorRaw: string | null;
  clientRaw: string | null;
  tcvUsd: number | null;
  contractLength: number | null;
  serviceLineRaw: string | null;
  originalUrl: string | null;
  ingestionSource: string | null;
}

type DedupVerdict = "SAME" | "RELATED" | "DISTINCT";

interface PairDecision {
  eventAId: string;
  eventBId: string;
  verdict: DedupVerdict;
  confidence: number;
  reasoning: string;
  keepId: string | null; // which one to keep if SAME
}

// ── Fetch all candidate events ────────────────────────────────────────────────
async function fetchEvents(): Promise<EventRow[]> {
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "published" },
    select: {
      id: true,
      family: true,
      canonicalTitle: true,
      announcementDate: true,
      confidenceScore: true,
      publicationStatus: true,
      originalArticleUrl: true,
      contractDetails: {
        select: {
          vendorRaw: true,
          clientRaw: true,
          tcvCommittedUsd: true,
          contractLengthMonths: true,
          primaryMacroServiceLine: true,
        },
      },
      sourceEvents: { select: { sourceName: true }, take: 1 },
    },
  });
  return rows.map(r => ({
    id: r.id,
    family: r.family,
    canonicalTitle: r.canonicalTitle,
    announcementDate: r.announcementDate,
    confidenceScore: r.confidenceScore,
    publicationStatus: r.publicationStatus,
    vendorRaw: r.contractDetails?.vendorRaw ?? null,
    clientRaw: r.contractDetails?.clientRaw ?? null,
    tcvUsd: r.contractDetails?.tcvCommittedUsd ?? null,
    contractLength: r.contractDetails?.contractLengthMonths ?? null,
    serviceLineRaw: r.contractDetails?.primaryMacroServiceLine ?? null,
    originalUrl: r.originalArticleUrl,
    ingestionSource: r.sourceEvents[0]?.sourceName ?? null,
  }));
}

// ── Generate candidate pairs ──────────────────────────────────────────────────
function generateCandidatePairs(events: EventRow[]): [EventRow, EventRow][] {
  // Group by normalised vendor+client key
  const groups = new Map<string, EventRow[]>();
  for (const e of events) {
    if (!e.vendorRaw) continue;
    const vendor = e.vendorRaw.toLowerCase().trim();
    const client = (e.clientRaw ?? "unknown").toLowerCase().trim();
    const key = `${vendor}|||${client}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  }

  const pairs: [EventRow, EventRow][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Sort by date
    group.sort((a, b) => (a.announcementDate?.getTime() ?? 0) - (b.announcementDate?.getTime() ?? 0));
    // Sliding window: compare each event to those within WINDOW_DAYS
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const da = group[i].announcementDate?.getTime() ?? 0;
        const db = group[j].announcementDate?.getTime() ?? 0;
        if (db - da > WINDOW_DAYS * 86_400_000) break;
        pairs.push([group[i], group[j]]);
      }
    }
  }
  return pairs;
}

// ── Skip pairs already decided ────────────────────────────────────────────────
async function filterAlreadyDecided(pairs: [EventRow, EventRow][]): Promise<[EventRow, EventRow][]> {
  const existing = await prisma.dedupDecision.findMany({
    select: { eventAId: true, eventBId: true },
  });
  const decided = new Set(existing.flatMap(d => [`${d.eventAId}|${d.eventBId}`, `${d.eventBId}|${d.eventAId}`]));
  return pairs.filter(([a, b]) => !decided.has(`${a.id}|${b.id}`));
}

// ── LLM pair comparison ───────────────────────────────────────────────────────
function formatEvent(e: EventRow): string {
  const parts = [
    `Title: ${e.canonicalTitle}`,
    `Family: ${e.family}`,
    `Date: ${e.announcementDate?.toISOString().slice(0, 10) ?? "unknown"}`,
    `Vendor: ${e.vendorRaw ?? "unknown"}`,
    `Client: ${e.clientRaw ?? "unknown"}`,
    e.tcvUsd ? `TCV: $${(e.tcvUsd / 1e6).toFixed(0)}m` : null,
    e.contractLength ? `Length: ${e.contractLength} months` : null,
    e.serviceLineRaw ? `Service line: ${e.serviceLineRaw}` : null,
    `Source: ${e.ingestionSource ?? "unknown"}`,
    e.originalUrl ? `URL: ${e.originalUrl.slice(0, 100)}` : null,
  ].filter(Boolean);
  return parts.join("\n");
}

async function llmCompare(a: EventRow, b: EventRow): Promise<PairDecision | null> {
  const prompt = `You are deduplicating an IT services market intelligence database.

Two events have the same vendor and client within a 90-day window. Determine if they describe:
- SAME: literally the same real-world deal (different articles covering one announcement)
- RELATED: the same deal at different stages (e.g. announcement then signing, or a renewal of the same contract)
- DISTINCT: genuinely different deals between the same parties

EVENT A (id: ${a.id}):
${formatEvent(a)}

EVENT B (id: ${b.id}):
${formatEvent(b)}

Respond with ONLY valid JSON, no prose:
{
  "verdict": "SAME|RELATED|DISTINCT",
  "confidence": 0.0,
  "reasoning": "one sentence",
  "keepId": "${a.id} or ${b.id} or null"
}
keepId: if SAME, the id of the record to KEEP (higher confidence, more complete data, newer source). If not SAME, null.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY!,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      eventAId: a.id,
      eventBId: b.id,
      verdict: parsed.verdict as DedupVerdict,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      reasoning: parsed.reasoning ?? "",
      keepId: parsed.keepId ?? null,
    };
  } catch {
    return null;
  }
}

// ── Apply decisions ───────────────────────────────────────────────────────────
async function applyDecisions(decisions: PairDecision[]): Promise<number> {
  const same = decisions.filter(d => d.verdict === "SAME" && d.confidence >= 0.80 && d.keepId);
  const excludeIds = same.map(d => (d.keepId === d.eventAId ? d.eventBId : d.eventAId));
  const unique = [...new Set(excludeIds)];
  if (unique.length === 0) return 0;
  await prisma.canonicalMarketEvent.updateMany({
    where: { id: { in: unique }, publicationStatus: { not: "excluded_noise" } },
    data: { publicationStatus: "excluded_noise", humanReviewRequired: false },
  });
  return unique.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Loading published events from Neon...");
  const events = await fetchEvents();
  console.log(`  ${events.length.toLocaleString()} published events loaded`);

  const allPairs = generateCandidatePairs(events);
  console.log(`  ${allPairs.length.toLocaleString()} candidate pairs within ${WINDOW_DAYS}-day windows`);

  const pairs = await filterAlreadyDecided(allPairs);
  console.log(`  ${pairs.length.toLocaleString()} new pairs to evaluate (${allPairs.length - pairs.length} already decided)`);

  if (pairs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const startTime = Date.now();
  const stats = { processed: 0, same: 0, related: 0, distinct: 0, errors: 0, excluded: 0 };
  const allDecisions: PairDecision[] = [];

  // Bounded concurrency
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= pairs.length) return;
      const [a, b] = pairs[idx];
      const decision = await llmCompare(a, b);
      if (!decision) { stats.errors++; }
      else {
        allDecisions.push(decision);
        if (decision.verdict === "SAME")     stats.same++;
        if (decision.verdict === "RELATED")  stats.related++;
        if (decision.verdict === "DISTINCT") stats.distinct++;

        // Write to DB in batches
        try {
          await prisma.dedupDecision.create({
            data: {
              eventAId: decision.eventAId,
              eventBId: decision.eventBId,
              decision: decision.verdict,
              confidence: decision.confidence,
              mergeRecommended: decision.verdict === "SAME",
              linkRecommended: decision.verdict === "RELATED",
              reasonCodes: JSON.stringify([decision.reasoning.slice(0, 200)]),
              riskFlags: "[]",
              humanReviewRequired: decision.confidence < 0.85,
            },
          });
        } catch { /* pair already exists race condition — safe to ignore */ }
      }

      stats.processed++;
      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.processed / elapsed;
        const eta = ((pairs.length - stats.processed) / rate / 60).toFixed(1);
        console.log(
          `  ${stats.processed}/${pairs.length} | SAME:${stats.same} RELATED:${stats.related} DISTINCT:${stats.distinct} ERR:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Apply exclusions
  console.log("\nApplying exclusions for high-confidence SAME decisions...");
  const excluded = await applyDecisions(allDecisions);
  stats.excluded = excluded;

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(54)}`);
  console.log(`Deduplication complete in ${totalMin} min:`);
  console.log(`  Pairs evaluated:  ${stats.processed.toLocaleString()}`);
  console.log(`  SAME:             ${stats.same.toLocaleString()} (exact duplicate)`);
  console.log(`  RELATED:          ${stats.related.toLocaleString()} (linked, kept)`);
  console.log(`  DISTINCT:         ${stats.distinct.toLocaleString()} (different deals)`);
  console.log(`  Errors:           ${stats.errors.toLocaleString()}`);
  console.log(`  Excluded (≥0.80): ${stats.excluded.toLocaleString()} events marked excluded_noise`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
