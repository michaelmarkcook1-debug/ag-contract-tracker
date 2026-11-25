import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { MODEL_TIERS, MODEL_PRICING, costOf } from "@/lib/ingestion/classifier";

export const dynamic = "force-dynamic";

// Typical token shape per call, used only when there is no historical data yet.
// Replaced by measured averages as soon as any run has recorded spend.
const FALLBACK_TRIAGE = { input: 800, output: 150 };
const FALLBACK_ANALYSIS = { input: 1100, output: 700 };

// GET /api/costs — model tiers, historical spend, and a per-run estimate.
export async function GET() {
  const [runs, totals] = await Promise.all([
    prisma.ingestionRun.findMany({
      where: { costUsd: { gt: 0 } },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true, runType: true, startedAt: true, status: true,
        eventsExtracted: true, articlesFound: true,
        inputTokens: true, outputTokens: true, costUsd: true,
      },
    }),
    prisma.ingestionRun.aggregate({
      _sum: { costUsd: true, inputTokens: true, outputTokens: true, eventsExtracted: true },
    }),
  ]);

  const totalCost = totals._sum.costUsd ?? 0;
  const totalExtractions = totals._sum.eventsExtracted ?? 0;

  // Prefer measured cost-per-article; fall back to a token-shape estimate.
  const measuredPerArticle = totalExtractions > 0 ? totalCost / totalExtractions : null;
  const modelledTriage = costOf(MODEL_TIERS.triage, FALLBACK_TRIAGE.input, FALLBACK_TRIAGE.output);
  const modelledAnalysis = costOf(MODEL_TIERS.analysis, FALLBACK_ANALYSIS.input, FALLBACK_ANALYSIS.output);

  return NextResponse.json({
    tiers: {
      triage: { model: MODEL_TIERS.triage, pricing: MODEL_PRICING[MODEL_TIERS.triage], costPerCall: modelledTriage },
      analysis: { model: MODEL_TIERS.analysis, pricing: MODEL_PRICING[MODEL_TIERS.analysis], costPerCall: modelledAnalysis },
    },
    totals: {
      costUsd: totalCost,
      inputTokens: totals._sum.inputTokens ?? 0,
      outputTokens: totals._sum.outputTokens ?? 0,
      extractions: totalExtractions,
    },
    perArticle: {
      measured: measuredPerArticle,
      // Worst case: every article promoted to the analysis tier.
      modelledMax: modelledTriage + modelledAnalysis,
      // Best case: everything filtered out at triage.
      modelledMin: modelledTriage,
    },
    recentRuns: runs.map(r => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      costPerArticle: r.eventsExtracted > 0 ? r.costUsd / r.eventsExtracted : 0,
    })),
  });
}
