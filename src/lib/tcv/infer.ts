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
 * GATES (§15) — all must pass or the answer is NOT_RELIABLY_ESTIMABLE:
 *   - service line must be specific; generic/blank lines are not anchors
 *   - at least MIN_ANCHORS comparables in the cell
 *   - cell dispersion (p75/p25) within MAX_SPREAD
 * Provider identity, geography, recency or source type alone are NOT anchors.
 *
 * OUTPUT (§16) is a RANGE. The midpoint is retained for internal ordering only
 * and must never be presented as a fact.
 */
import { prisma } from "@/lib/db";

/** Service-line labels too generic to anchor on (§15). */
const GENERIC_LINES = new Set([
  "", "(none)", "general services", "unspecified", "other", "services", "general", "misc", "miscellaneous",
]);

export const MIN_ANCHORS = 8;
export const MAX_SPREAD = 6;          // p75/p25 within a cell
const LENGTH_ADJUST_CAP = 3;          // bound term scaling so outliers can't distort

export type TcvVerdict =
  | { state: "INFERRED"; lowUsd: number; highUsd: number; midUsd: number; anchors: number; basis: string }
  | { state: "NOT_RELIABLY_ESTIMABLE"; reason: string };

export type DealSegment = "PROCUREMENT" | "ANNOUNCED";

/** Procurement notices and announced deals are different value populations. */
export function segmentFor(sourceType: string | null | undefined): DealSegment {
  return sourceType === "procurement_notice" ? "PROCUREMENT" : "ANNOUNCED";
}

interface Anchor { value: number; months: number | null }
interface Cell { anchors: Anchor[]; p25: number; p75: number; medianMonths: number | null }

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
  for (const r of rows) {
    const line = (r.primaryMacroServiceLine ?? "").trim();
    if (GENERIC_LINES.has(line.toLowerCase())) continue;
    const se = r.canonicalEvent?.sourceEvents?.[0];
    // Historic GlobalData rows are the procurement population regardless of how
    // their sourceType was recorded at import time.
    const seg: DealSegment = se?.sourceName === "GlobalData" ? "PROCUREMENT" : segmentFor(se?.sourceType);
    const key = `${seg}|${line}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({ value: r.tcvCommittedUsd!, months: r.contractLengthMonths ?? null });
  }

  const pools = new Map<string, Cell>();
  for (const [key, anchors] of grouped) {
    const sorted = anchors.map(a => a.value).sort((a, b) => a - b);
    const months = anchors.map(a => a.months).filter((m): m is number => !!m && m > 0).sort((a, b) => a - b);
    pools.set(key, {
      anchors,
      p25: quantile(sorted, 0.25),
      p75: quantile(sorted, 0.75),
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
 * Produce a defensible range, or refuse. Refusing is a correct outcome and is
 * expected to be the common one — measured on the live estate, only 6 of the
 * populated cells clear the gates.
 */
export async function inferTcv(input: InferInput): Promise<TcvVerdict> {
  if (input.disclosedUsd != null) {
    return { state: "NOT_RELIABLY_ESTIMABLE", reason: "value_disclosed_no_inference_needed" };
  }
  const line = (input.serviceLine ?? "").trim();
  if (!line || GENERIC_LINES.has(line.toLowerCase())) {
    return { state: "NOT_RELIABLY_ESTIMABLE", reason: "no_specific_service_line" };
  }

  const pools = await loadComparablePools();
  const seg = segmentFor(input.sourceType);
  const cell = pools.get(`${seg}|${line}`);
  if (!cell) return { state: "NOT_RELIABLY_ESTIMABLE", reason: `no_comparables_for_${seg}/${line}` };
  if (cell.anchors.length < MIN_ANCHORS) {
    return { state: "NOT_RELIABLY_ESTIMABLE", reason: `too_few_comparables_${cell.anchors.length}` };
  }
  if (cell.p25 <= 0) return { state: "NOT_RELIABLY_ESTIMABLE", reason: "degenerate_comparable_pool" };

  const spread = cell.p75 / cell.p25;
  if (spread > MAX_SPREAD) {
    return { state: "NOT_RELIABLY_ESTIMABLE", reason: `comparables_too_dispersed_${spread.toFixed(1)}x` };
  }

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
    state: "INFERRED",
    lowUsd,
    highUsd,
    midUsd: Math.round((lowUsd + highUsd) / 2),   // internal ordering only — never shown as fact
    anchors: cell.anchors.length,
    basis: "comparable_inferred_v1",
  };
}

/** Basis string identifying values this engine produced. */
export const INFERRED_BASIS = "comparable_inferred_v1";
