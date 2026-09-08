/**
 * Comparable-contract TCV inference.
 *
 * WHY THIS EXISTS
 * The extraction LLM is forbidden from inventing contract values (§24/§46).
 * This is the only approved route to an inferred value: a deterministic
 * comparison against DISCLOSED contracts, with gates that refuse to answer when
 * the evidence cannot support one. No model call, no cost, no guessing.
 *
 * WHY IT STRATIFIES BY POPULATION
 * The disclosed pool is not one population. Measured on the live estate:
 *   GlobalData procurement extract  4,071 rows  median   $2.34m
 *   Announced deals (wire/news/PR)    ~630 rows  median $315-440m
 * a 149x difference. Pooling them made single service lines look absurdly
 * dispersed (BPO p75/p25 = 75.8x, Consulting 80.2x) purely because $2m
 * procurement line items sat beside $300m mega-deals. Anchoring a press-release
 * contract against a pool 87% composed of procurement records would understate
 * it by two orders of magnitude. Segmenting first is what makes the comparison
 * meaningful rather than arithmetically valid but wrong.
 *
 * POLICY CHANGE 2026-09-08 — estimates are wanted, labelled as estimates.
 * The first version refused unless a cell had ≥8 anchors within a 6x spread;
 * on the live estate that produced 2 estimates against 2,300 undisclosed
 * contracts. Contract values genuinely span orders of magnitude within a
 * service line, so the spread gate mostly measured reality, not evidence
 * quality. Now: the most specific pool available answers — segment × service
 * line, then the whole segment, then everything — and the basis says which.
 * The extraction model's own range (from the article's scope, term and client)
 * is preferred when present; this engine is the fallback and the sanity
 * envelope. Disclosed values are never mixed with estimates: tcvCommittedUsd
 * stays null and the UI renders "Est. low–high".
 *
 * OUTPUT (§16) is a RANGE. The midpoint is retained for internal ordering only
 * and must never be presented as a fact.
 */
import { prisma } from "@/lib/db";

/** Service-line labels too generic to anchor on (§15). */
const GENERIC_LINES = new Set([
  "", "(none)", "general services", "unspecified", "other", "services", "general", "misc", "miscellaneous",
]);

export const MIN_ANCHORS = 5;
const LENGTH_ADJUST_CAP = 3;          // bound term scaling so outliers can't distort

/** Which comparable pool answered: the service-line cell, the whole segment, or everything. */
export type PoolTier = "line" | "segment" | "global";

export type TcvVerdict =
  | { state: "INFERRED"; lowUsd: number; highUsd: number; midUsd: number; anchors: number; basis: string; tier: PoolTier }
  | { state: "NOT_RELIABLY_ESTIMABLE"; reason: string };

export type DealSegment = "PROCUREMENT" | "ANNOUNCED";

/** Procurement notices and announced deals are different value populations. */
export function segmentFor(sourceType: string | null | undefined): DealSegment {
  return sourceType === "procurement_notice" ? "PROCUREMENT" : "ANNOUNCED";
}

interface Anchor { value: number; months: number | null }
interface Cell { anchors: Anchor[]; p25: number; p75: number; p2: number; p98: number; medianMonths: number | null }

const quantile = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

let cache: Map<string, Cell> | null = null;

/** Build the comparable pools from DISCLOSED values only. Cached per process. */
export async function loadComparablePools(force = false): Promise<Map<string, Cell>> {
  if (cache && !force) return cache;
  const rows = await prisma.contractDetails.findMany({
    where: { tcvCommittedUsd: { not: null } },      // disclosed only — never anchor on an estimate
    select: {
      tcvCommittedUsd: true, contractLengthMonths: true, primaryMacroServiceLine: true,
      canonicalEvent: { select: { sourceEvents: { select: { sourceName: true, sourceType: true }, take: 1 } } },
    },
  });

  const grouped = new Map<string, Anchor[]>();
  const add = (key: string, a: Anchor) => { if (!grouped.has(key)) grouped.set(key, []); grouped.get(key)!.push(a); };
  for (const r of rows) {
    if (!r.tcvCommittedUsd || r.tcvCommittedUsd <= 0) continue;
    const line = (r.primaryMacroServiceLine ?? "").trim();
    const se = r.canonicalEvent?.sourceEvents?.[0];
    // Historic GlobalData rows are the procurement population regardless of how
    // their sourceType was recorded at import time.
    const seg: DealSegment = se?.sourceName === "GlobalData" ? "PROCUREMENT" : segmentFor(se?.sourceType);
    const anchor = { value: r.tcvCommittedUsd, months: r.contractLengthMonths ?? null };
    if (!GENERIC_LINES.has(line.toLowerCase())) add(`${seg}|${line}`, anchor);
    add(`${seg}|*`, anchor);      // segment-wide fallback
    add(`*|*`, anchor);           // global fallback
  }

  const pools = new Map<string, Cell>();
  for (const [key, anchors] of grouped) {
    const sorted = anchors.map(a => a.value).sort((a, b) => a - b);
    const months = anchors.map(a => a.months).filter((m): m is number => !!m && m > 0).sort((a, b) => a - b);
    pools.set(key, {
      anchors,
      p25: quantile(sorted, 0.25),
      p75: quantile(sorted, 0.75),
      p2: quantile(sorted, 0.02),
      p98: quantile(sorted, 0.98),
      medianMonths: months.length ? months[Math.floor(months.length / 2)] : null,
    });
  }
  cache = pools;
  return pools;
}

/** Clear the cached pools (use after ingesting new disclosed values). */
export function resetComparablePools() { cache = null; }

export interface InferInput {
  serviceLine: string | null;
  sourceType: string | null;
  contractLengthMonths: number | null;
  /** Set when the value is already disclosed — inference is then not attempted. */
  disclosedUsd?: number | null;
}

/**
 * Produce a range from the most specific comparable pool available. Refuses
 * only when the value is already disclosed or no pool exists at all.
 */
export async function inferTcv(input: InferInput): Promise<TcvVerdict> {
  if (input.disclosedUsd != null) {
    return { state: "NOT_RELIABLY_ESTIMABLE", reason: "value_disclosed_no_inference_needed" };
  }
  const pools = await loadComparablePools();
  const seg = segmentFor(input.sourceType);
  const line = (input.serviceLine ?? "").trim();
  const candidates: [string, PoolTier][] = [
    [`${seg}|${line}`, "line"], [`${seg}|*`, "segment"], [`*|*`, "global"],
  ];
  for (const [key, tier] of candidates) {
    if (tier === "line" && (!line || GENERIC_LINES.has(line.toLowerCase()))) continue;
    const cell = pools.get(key);
    if (!cell || cell.anchors.length < MIN_ANCHORS || cell.p25 <= 0) continue;

    // Term adjustment: only when both sides state a term, and bounded so an
    // unusual contract length cannot stretch the range arbitrarily.
    let factor = 1;
    if (input.contractLengthMonths && cell.medianMonths) {
      const raw = input.contractLengthMonths / cell.medianMonths;
      factor = Math.min(LENGTH_ADJUST_CAP, Math.max(1 / LENGTH_ADJUST_CAP, raw));
    }
    const lowUsd = Math.round(cell.p25 * factor);
    const highUsd = Math.round(cell.p75 * factor);
    return {
      state: "INFERRED", lowUsd, highUsd,
      midUsd: Math.round((lowUsd + highUsd) / 2),   // internal ordering only — never shown as fact
      anchors: cell.anchors.length,
      basis: `${INFERRED_BASIS}:${tier}${tier === "line" ? `:${line}` : ""}`,
      tier,
    };
  }
  return { state: "NOT_RELIABLY_ESTIMABLE", reason: "no_comparable_pool" };
}

/**
 * Keep a model-estimated range inside the envelope of disclosed values for its
 * segment (2nd–98th percentile). An estimate outside that band is not evidence
 * of a record deal; it is a model that lost the units.
 */
export async function clampEstimate(sourceType: string | null | undefined, lowUsd: number, highUsd: number):
  Promise<{ lowUsd: number; highUsd: number; clamped: boolean }> {
  const pools = await loadComparablePools();
  const cell = pools.get(`${segmentFor(sourceType)}|*`) ?? pools.get("*|*");
  if (!cell || cell.p2 <= 0) return { lowUsd, highUsd, clamped: false };
  const lo = Math.min(Math.max(lowUsd, cell.p2), cell.p98);
  const hi = Math.min(Math.max(highUsd, lo), cell.p98);
  return { lowUsd: Math.round(lo), highUsd: Math.round(hi), clamped: lo !== lowUsd || hi !== highUsd };
}

/** Basis prefix identifying values this engine produced. */
export const INFERRED_BASIS = "comparable_inferred_v2";
/** Basis prefix for ranges the extraction model produced from the article. */
export const MODEL_ESTIMATE_BASIS = "model_estimated_v2";
/** Bases the UI and analytics may present as an estimate (older methods stay quarantined). */
export function isApprovedEstimateBasis(basis: string | null | undefined): boolean {
  return !!basis && (basis.startsWith(INFERRED_BASIS) || basis.startsWith(MODEL_ESTIMATE_BASIS) || basis === "comparable_inferred_v1");
}
