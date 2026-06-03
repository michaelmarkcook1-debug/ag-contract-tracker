/**
 * Entity-cluster deduplication — catches duplicates the title-overlap dedup misses.
 *
 * Strategy:
 *  1. Extract proper nouns (capitalized words) from each title as entity signals
 *  2. Group published events by date (±3 days)
 *  3. Within each group, find clusters sharing 2+ entities
 *  4. For each cluster, ask Haiku which events are the same real-world event
 *  5. Keep the highest-confidence one, exclude the rest
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

const CONCURRENCY = 8;
const PROGRESS_EVERY = 20;

// Common words that look like proper nouns but aren't entity names
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "its", "new", "has", "will", "can", "all",
  "partnership", "partners", "partner", "contract", "deal", "announced",
  "awarded", "strategic", "global", "digital", "services", "solutions",
  "technology", "expand", "expands", "launches", "launch", "acquires",
  "acquire", "acquisition", "alliance", "group", "enterprise", "platform",
  "company", "management", "business", "transformation", "consulting",
  "operations", "integration", "implementation", "capabilities", "enhance",
  "strengthen", "accelerate", "drive", "deliver", "enable", "support",
  "boost", "advance", "extend", "extends", "deepen", "deepens",
  "establish", "form", "forms", "join", "joins", "select", "selects",
  "selected", "named", "recognized", "report", "study", "research",
  "inc", "ltd", "corp", "pty", "plc", "limited",
]);

interface EventRow {
  id: string;
  canonicalTitle: string;
  announcementDate: Date | null;
  confidenceScore: number;
  family: string;
}

function extractEntities(title: string): string[] {
  // Split on spaces, find capitalised words that aren't stop words
  const words = title.split(/[\s,;:()|/\-–—]+/);
  const entities: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length < 3) continue;
    if (clean[0] !== clean[0].toUpperCase() || clean[0] === clean[0].toLowerCase()) continue;
    const lower = clean.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    entities.push(lower);
  }
  return [...new Set(entities)];
}

interface Cluster {
  date: string;
  events: EventRow[];
  sharedEntities: string[];
}

function buildClusters(events: EventRow[]): Cluster[] {
  // Group by date
  const byDate = new Map<string, EventRow[]>();
  for (const e of events) {
    const d = e.announcementDate?.toISOString().slice(0, 10) ?? "unknown";
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(e);
  }

  // Merge adjacent dates (±3 days) into windows
  const dates = [...byDate.keys()].filter(d => d !== "unknown").sort();
  const windows: EventRow[][] = [];
  const used = new Set<string>();

  for (const d of dates) {
    if (used.has(d)) continue;
    const window = [...(byDate.get(d) ?? [])];
    used.add(d);
    const dt = new Date(d).getTime();
    for (const d2 of dates) {
      if (used.has(d2)) continue;
      if (Math.abs(new Date(d2).getTime() - dt) <= 3 * 86_400_000) {
        window.push(...(byDate.get(d2) ?? []));
        used.add(d2);
      }
    }
    if (window.length >= 2) windows.push(window);
  }

  // Within each window, find clusters sharing 2+ entities
  const clusters: Cluster[] = [];
  const clusterSeen = new Set<string>();

  for (const window of windows) {
    const entityMap = window.map(e => ({ event: e, entities: new Set(extractEntities(e.canonicalTitle)) }));

    // Union-find approach: merge events sharing 2+ entities
    const groups = new Map<string, Set<number>>(); // entity-pair -> indices

    for (let i = 0; i < entityMap.length; i++) {
      const ents = [...entityMap[i].entities];
      for (let a = 0; a < ents.length; a++) {
        for (let b = a + 1; b < ents.length; b++) {
          const pairKey = [ents[a], ents[b]].sort().join("+");
          if (!groups.has(pairKey)) groups.set(pairKey, new Set());
          groups.get(pairKey)!.add(i);
        }
      }
    }

    // Merge overlapping groups
    for (const [pairKey, indices] of groups.entries()) {
      if (indices.size < 2) continue;
      const idxArr = [...indices];
      const eventIds = idxArr.map(i => entityMap[i].event.id).sort().join(",");
      if (clusterSeen.has(eventIds)) continue;
      clusterSeen.add(eventIds);

      const clusterEvents = idxArr.map(i => entityMap[i].event);
      const shared = pairKey.split("+");
      clusters.push({
        date: clusterEvents[0].announcementDate?.toISOString().slice(0, 10) ?? "unknown",
        events: clusterEvents,
        sharedEntities: shared,
      });
    }
  }

  // Deduplicate clusters that are subsets of larger ones
  // Sort by size descending, skip if all events already covered
  clusters.sort((a, b) => b.events.length - a.events.length);
  const coveredIds = new Set<string>();
  const uniqueClusters: Cluster[] = [];

  for (const c of clusters) {
    const newIds = c.events.filter(e => !coveredIds.has(e.id));
    if (newIds.length < 1) continue; // fully covered
    // Only keep if cluster has 2+ events
    if (c.events.length >= 2) {
      uniqueClusters.push(c);
      c.events.forEach(e => coveredIds.add(e.id));
    }
  }

  return uniqueClusters;
}

interface ClusterDecision {
  keepId: string;
  excludeIds: string[];
  reasoning: string;
}

async function llmJudgeCluster(cluster: Cluster): Promise<ClusterDecision | null> {
  const eventDescriptions = cluster.events.map((e, i) =>
    `  ${i + 1}. [${e.id.slice(0, 8)}] conf=${e.confidenceScore.toFixed(2)} family=${e.family} "${e.canonicalTitle}"`
  ).join("\n");

  const prompt = `You are deduplicating an IT services market intelligence database.

These ${cluster.events.length} events were published within 3 days of each other and share the entities: ${cluster.sharedEntities.join(", ")}.

${eventDescriptions}

Determine which events describe the SAME real-world event (just different articles/sources about one announcement).

Group them: events about the same deal go together. For each group of duplicates, pick the ONE to keep (best title, highest confidence).

Respond with ONLY valid JSON:
{
  "groups": [
    {
      "description": "what the event is about",
      "sameEventIds": ["id1", "id2"],
      "keepId": "best one to keep"
    }
  ],
  "distinctIds": ["ids that are genuinely different events"]
}

Use the 8-char IDs shown in brackets. If ALL events are distinct, return empty groups and all ids in distinctIds.`;

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
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text ?? "";
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    // Map short IDs back to full IDs
    const idMap = new Map(cluster.events.map(e => [e.id.slice(0, 8), e.id]));

    const excludeIds: string[] = [];
    let keepId: string | null = null;
    const reasoning: string[] = [];

    for (const group of (parsed.groups ?? [])) {
      if (!group.sameEventIds || group.sameEventIds.length < 2) continue;
      const fullKeep = idMap.get(group.keepId);
      if (!fullKeep) continue;
      keepId = fullKeep;
      reasoning.push(group.description ?? "");
      for (const sid of group.sameEventIds) {
        const fullId = idMap.get(sid);
        if (fullId && fullId !== fullKeep) excludeIds.push(fullId);
      }
    }

    if (excludeIds.length === 0) return null;
    return { keepId: keepId!, excludeIds, reasoning: reasoning.join("; ") };
  } catch {
    return null;
  }
}

async function main() {
  console.log("Loading published events...");
  const events = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "published" },
    select: {
      id: true,
      canonicalTitle: true,
      announcementDate: true,
      confidenceScore: true,
      family: true,
    },
  });
  console.log(`  ${events.length.toLocaleString()} published events`);

  console.log("Building entity-based clusters...");
  const clusters = buildClusters(events);
  console.log(`  ${clusters.length} clusters found (2+ events sharing entities on same date)`);

  if (clusters.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const startTime = Date.now();
  const stats = { processed: 0, excluded: 0, clustersWithDupes: 0, errors: 0 };

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= clusters.length) return;
      const cluster = clusters[idx];
      const decision = await llmJudgeCluster(cluster);

      if (!decision) {
        stats.errors++;
      } else if (decision.excludeIds.length > 0) {
        stats.clustersWithDupes++;
        // Exclude duplicates
        for (let i = 0; i < decision.excludeIds.length; i += 200) {
          const batch = decision.excludeIds.slice(i, i + 200);
          const result = await prisma.canonicalMarketEvent.updateMany({
            where: { id: { in: batch }, publicationStatus: "published" },
            data: { publicationStatus: "excluded_noise", humanReviewRequired: false },
          });
          stats.excluded += result.count;
        }
      }

      stats.processed++;
      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.processed / elapsed;
        const eta = ((clusters.length - stats.processed) / rate / 60).toFixed(1);
        console.log(
          `  ${stats.processed}/${clusters.length} | excl:${stats.excluded} dupeGroups:${stats.clustersWithDupes} err:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(54)}`);
  console.log(`Entity-cluster dedup complete in ${totalMin} min:`);
  console.log(`  Clusters judged:  ${stats.processed}`);
  console.log(`  With duplicates:  ${stats.clustersWithDupes}`);
  console.log(`  Events excluded:  ${stats.excluded}`);
  console.log(`  Errors:           ${stats.errors}`);

  const remaining = await prisma.canonicalMarketEvent.count({ where: { publicationStatus: "published" } });
  console.log(`  Published remaining: ${remaining}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
