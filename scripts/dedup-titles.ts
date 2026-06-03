/**
 * Title-similarity deduplication — catches duplicates the vendor+client dedup misses.
 *
 * Strategy:
 *  1. Group all published events by announcement date (same day)
 *  2. Within each group, find pairs with ≥50% word overlap in title
 *  3. Send each pair to Claude Haiku for SAME / RELATED / DISTINCT verdict
 *  4. Write DedupDecision records & mark SAME duplicates as excluded_noise
 *     Keeps the event with highest confidence score.
 */
import * as dotenv from "dotenv";
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

const CONCURRENCY = 10;
const PROGRESS_EVERY = 50;
const MIN_SIMILARITY = 0.50;

interface EventRow {
  id: string;
  family: string;
  canonicalTitle: string;
  announcementDate: Date | null;
  confidenceScore: number;
  originalUrl: string | null;
}

type DedupVerdict = "SAME" | "RELATED" | "DISTINCT";

interface PairDecision {
  eventAId: string;
  eventBId: string;
  verdict: DedupVerdict;
  confidence: number;
  reasoning: string;
  keepId: string | null;
}

// ── Fetch events ─────────────────────────────────────────────────────────────
async function fetchEvents(): Promise<EventRow[]> {
  return prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "published" },
    select: {
      id: true,
      family: true,
      canonicalTitle: true,
      announcementDate: true,
      confidenceScore: true,
      originalArticleUrl: true,
    },
  }).then(rows => rows.map(r => ({
    id: r.id,
    family: r.family,
    canonicalTitle: r.canonicalTitle,
    announcementDate: r.announcementDate,
    confidenceScore: r.confidenceScore,
    originalUrl: r.originalArticleUrl,
  })));
}

// ── Title similarity ─────────────────────────────────────────────────────────
function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3));
}

function titleSimilarity(a: string, b: string): number {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const overlap = [...wa].filter(w => wb.has(w)).length;
  return overlap / Math.max(wa.size, wb.size);
}

// ── Generate candidate pairs by title similarity within ±3 day window ────────
function generatePairs(events: EventRow[]): [EventRow, EventRow][] {
  // Group by date string
  const byDate = new Map<string, EventRow[]>();
  for (const e of events) {
    const d = e.announcementDate?.toISOString().slice(0, 10) ?? "unknown";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(e);
  }

  // Also compare adjacent days (±3 days) — same announcement can land on different days
  const dates = [...byDate.keys()].filter(d => d !== "unknown").sort();
  const megaGroups: EventRow[][] = [];

  for (let i = 0; i < dates.length; i++) {
    const cluster: EventRow[] = [...(byDate.get(dates[i]) ?? [])];
    for (let j = i + 1; j < dates.length; j++) {
      const da = new Date(dates[i]).getTime();
      const db = new Date(dates[j]).getTime();
      if (db - da > 3 * 86_400_000) break;
      cluster.push(...(byDate.get(dates[j]) ?? []));
    }
    if (cluster.length >= 2) megaGroups.push(cluster);
  }

  // Also add "unknown" date group
  const unknowns = byDate.get("unknown");
  if (unknowns && unknowns.length >= 2) megaGroups.push(unknowns);

  const seen = new Set<string>();
  const pairs: [EventRow, EventRow][] = [];

  for (const group of megaGroups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = [group[i].id, group[j].id].sort().join("|");
        if (seen.has(key)) continue;
        const sim = titleSimilarity(group[i].canonicalTitle, group[j].canonicalTitle);
        if (sim >= MIN_SIMILARITY) {
          seen.add(key);
          pairs.push([group[i], group[j]]);
        }
      }
    }
  }
  return pairs;
}

// ── Skip already-decided pairs ───────────────────────────────────────────────
async function filterAlreadyDecided(pairs: [EventRow, EventRow][]): Promise<[EventRow, EventRow][]> {
  const existing = await prisma.dedupDecision.findMany({
    select: { eventAId: true, eventBId: true },
  });
  const decided = new Set(existing.flatMap(d => [
    `${d.eventAId}|${d.eventBId}`,
    `${d.eventBId}|${d.eventAId}`,
  ]));
  return pairs.filter(([a, b]) => {
    const k = [a.id, b.id].sort().join("|");
    return !decided.has(k);
  });
}

// ── LLM comparison ───────────────────────────────────────────────────────────
async function llmCompare(a: EventRow, b: EventRow): Promise<PairDecision | null> {
  const prompt = `You are deduplicating an IT services market intelligence database.

Two events were published within 3 days of each other and have very similar titles. Determine if they describe:
- SAME: the same real-world event reported by different sources (different articles about one announcement)
- RELATED: closely related but distinct events (e.g. announcement then follow-up, or different phases)
- DISTINCT: genuinely different events that happen to have similar titles

EVENT A (id: ${a.id}):
Title: ${a.canonicalTitle}
Family: ${a.family}
Date: ${a.announcementDate?.toISOString().slice(0, 10) ?? "unknown"}
Confidence: ${a.confidenceScore}
URL: ${a.originalUrl?.slice(0, 120) ?? "none"}

EVENT B (id: ${b.id}):
Title: ${b.canonicalTitle}
Family: ${b.family}
Date: ${b.announcementDate?.toISOString().slice(0, 10) ?? "unknown"}
Confidence: ${b.confidenceScore}
URL: ${b.originalUrl?.slice(0, 120) ?? "none"}

Respond with ONLY valid JSON:
{
  "verdict": "SAME|RELATED|DISTINCT",
  "confidence": 0.0,
  "reasoning": "one sentence",
  "keepId": "${a.id} or ${b.id} or null"
}
keepId: if SAME, the id of the record to KEEP (prefer higher confidence, more specific title). If not SAME, null.`;

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

// ── Apply decisions ──────────────────────────────────────────────────────────
async function applyDecisions(decisions: PairDecision[]): Promise<number> {
  const same = decisions.filter(d => d.verdict === "SAME" && d.confidence >= 0.75 && d.keepId);
  const excludeIds = same.map(d => (d.keepId === d.eventAId ? d.eventBId : d.eventAId));
  const unique = [...new Set(excludeIds)];
  if (unique.length === 0) return 0;

  // Batch in groups of 200 to avoid connection timeouts
  let excluded = 0;
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200);
    const result = await prisma.canonicalMarketEvent.updateMany({
      where: { id: { in: batch }, publicationStatus: { not: "excluded_noise" } },
      data: { publicationStatus: "excluded_noise", humanReviewRequired: false },
    });
    excluded += result.count;
  }
  return excluded;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Loading published events...");
  const events = await fetchEvents();
  console.log(`  ${events.length.toLocaleString()} published events`);

  console.log("Generating title-similarity pairs (≥50% word overlap, ±3 days)...");
  const allPairs = generatePairs(events);
  console.log(`  ${allPairs.length.toLocaleString()} candidate pairs`);

  const pairs = await filterAlreadyDecided(allPairs);
  console.log(`  ${pairs.length.toLocaleString()} new pairs (${allPairs.length - pairs.length} already decided)`);

  if (pairs.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const startTime = Date.now();
  const stats = { processed: 0, same: 0, related: 0, distinct: 0, errors: 0, excluded: 0 };
  const allDecisions: PairDecision[] = [];

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
        } catch { /* race condition — safe */ }
      }

      stats.processed++;
      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.processed / elapsed;
        const eta = ((pairs.length - stats.processed) / rate / 60).toFixed(1);
        console.log(
          `  ${stats.processed}/${pairs.length} | SAME:${stats.same} REL:${stats.related} DIST:${stats.distinct} ERR:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("\nApplying exclusions for high-confidence SAME decisions (≥0.75)...");
  const excluded = await applyDecisions(allDecisions);
  stats.excluded = excluded;

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(54)}`);
  console.log(`Title deduplication complete in ${totalMin} min:`);
  console.log(`  Pairs evaluated:  ${stats.processed.toLocaleString()}`);
  console.log(`  SAME:             ${stats.same.toLocaleString()}`);
  console.log(`  RELATED:          ${stats.related.toLocaleString()}`);
  console.log(`  DISTINCT:         ${stats.distinct.toLocaleString()}`);
  console.log(`  Errors:           ${stats.errors.toLocaleString()}`);
  console.log(`  Excluded (≥0.75): ${stats.excluded.toLocaleString()} events marked excluded_noise`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
