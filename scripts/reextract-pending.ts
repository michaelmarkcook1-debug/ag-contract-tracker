/**
 * Re-extract mid-confidence needs_review events (0.50–0.70) through Claude Haiku.
 *
 * For each event, sends title + existing metadata to Haiku for a fresh confidence
 * assessment. If the new confidence >= 0.72, auto-publish. If < 0.45, auto-exclude.
 * Otherwise leave as needs_review with updated score.
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
const PROGRESS_EVERY = 100;

interface PendingEvent {
  id: string;
  family: string;
  canonicalTitle: string;
  announcementDate: Date | null;
  confidenceScore: number;
  originalArticleUrl: string | null;
  analystInsight: string | null;
  contractDetails: {
    vendorRaw: string | null;
    clientRaw: string | null;
    tcvCommittedUsd: number | null;
    primaryMacroServiceLine: string | null;
  } | null;
}

interface ReassessResult {
  newConfidence: number;
  isRelevant: boolean;
  reasoning: string;
  improvedTitle: string | null;
}

async function fetchPending(): Promise<PendingEvent[]> {
  return prisma.canonicalMarketEvent.findMany({
    where: {
      publicationStatus: "needs_review",
      confidenceScore: { gte: 0.50, lt: 0.70 },
    },
    select: {
      id: true,
      family: true,
      canonicalTitle: true,
      announcementDate: true,
      confidenceScore: true,
      originalArticleUrl: true,
      analystInsight: true,
      contractDetails: {
        select: {
          vendorRaw: true,
          clientRaw: true,
          tcvCommittedUsd: true,
          primaryMacroServiceLine: true,
        },
      },
    },
  });
}

async function reassess(e: PendingEvent): Promise<ReassessResult | null> {
  const details = [
    `Title: ${e.canonicalTitle}`,
    `Family: ${e.family}`,
    `Date: ${e.announcementDate?.toISOString().slice(0, 10) ?? "unknown"}`,
    e.contractDetails?.vendorRaw ? `Vendor: ${e.contractDetails.vendorRaw}` : null,
    e.contractDetails?.clientRaw ? `Client: ${e.contractDetails.clientRaw}` : null,
    e.contractDetails?.tcvCommittedUsd ? `TCV: $${(e.contractDetails.tcvCommittedUsd / 1e6).toFixed(1)}m` : null,
    e.contractDetails?.primaryMacroServiceLine ? `Service: ${e.contractDetails.primaryMacroServiceLine}` : null,
    e.analystInsight ? `Insight: ${e.analystInsight.slice(0, 200)}` : null,
    e.originalArticleUrl ? `URL: ${e.originalArticleUrl.slice(0, 120)}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are a quality filter for an IT services market intelligence database tracking contracts, partnerships, M&A, and org changes among major IT service providers (Accenture, TCS, Infosys, Wipro, Cognizant, HCL, NTT DATA, Capgemini, DXC, Atos, etc.).

Assess whether this event is a REAL, commercially relevant IT services market event:

${details}

Criteria for relevance:
- Must involve a real IT services contract, partnership, acquisition, or organizational change
- Must involve identifiable companies (not generic industry reports or opinion pieces)
- Research reports, analyst opinions, job postings, and generic news are NOT relevant
- Award wins, conference appearances, and thought leadership are NOT relevant unless they announce a specific deal

Respond with ONLY valid JSON:
{
  "isRelevant": true/false,
  "newConfidence": 0.0-1.0,
  "reasoning": "one sentence",
  "improvedTitle": "cleaner title if the original is messy, or null"
}`;

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
      newConfidence: typeof parsed.newConfidence === "number" ? parsed.newConfidence : 0.5,
      isRelevant: !!parsed.isRelevant,
      reasoning: parsed.reasoning ?? "",
      improvedTitle: parsed.improvedTitle ?? null,
    };
  } catch {
    return null;
  }
}

async function main() {
  console.log("Loading mid-confidence needs_review events (0.50-0.70)...");
  const events = await fetchPending();
  console.log(`  ${events.length.toLocaleString()} events to re-assess`);

  if (events.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const startTime = Date.now();
  const stats = { processed: 0, published: 0, excluded: 0, kept: 0, errors: 0 };

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= events.length) return;
      const e = events[idx];
      const result = await reassess(e);

      if (!result) {
        stats.errors++;
      } else {
        const updateData: Record<string, unknown> = {
          confidenceScore: result.newConfidence,
        };

        if (result.improvedTitle && result.improvedTitle.length > 20) {
          updateData.canonicalTitle = result.improvedTitle.slice(0, 500);
        }

        if (result.isRelevant && result.newConfidence >= 0.72) {
          updateData.publicationStatus = "published";
          updateData.humanReviewRequired = false;
          stats.published++;
        } else if (!result.isRelevant || result.newConfidence < 0.45) {
          updateData.publicationStatus = "excluded_noise";
          updateData.humanReviewRequired = false;
          stats.excluded++;
        } else {
          // Still needs_review but with updated confidence
          stats.kept++;
        }

        try {
          await prisma.canonicalMarketEvent.update({
            where: { id: e.id },
            data: updateData,
          });
        } catch {
          stats.errors++;
        }
      }

      stats.processed++;
      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.processed / elapsed;
        const eta = ((events.length - stats.processed) / rate / 60).toFixed(1);
        console.log(
          `  ${stats.processed}/${events.length} | pub:${stats.published} excl:${stats.excluded} kept:${stats.kept} err:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(54)}`);
  console.log(`Re-extraction complete in ${totalMin} min:`);
  console.log(`  Assessed:     ${stats.processed.toLocaleString()}`);
  console.log(`  Published:    ${stats.published.toLocaleString()}`);
  console.log(`  Excluded:     ${stats.excluded.toLocaleString()}`);
  console.log(`  Still review: ${stats.kept.toLocaleString()}`);
  console.log(`  Errors:       ${stats.errors.toLocaleString()}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
