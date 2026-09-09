/**
 * Contract value engine — calculated, labelled ESTIMATES for contracts whose
 * value was not disclosed.
 *
 * POLICY (reaffirmed 2026-09-08). Every contract carries a value: the disclosed
 * figure when one exists, otherwise a calculated estimate range. The two never
 * mix: `tcvCommittedUsd` holds only what an article stated, estimates live in
 * `tcvEstimateLow/Mid/High` with their method, inputs and version beside them.
 * "Missing means missing" applies to the stated field; the estimate is a
 * separate, labelled fact about the analyst's model.
 *
 * THREE ROUTES, most specific first:
 *   1. bpo_rate_card — bottom-up from what a BPO announcement states: agents or
 *      seats deployed, delivery location, kind of work, term. TCV = agents ×
 *      billed rate per agent-year (by delivery geography and work type) × years.
 *   2. value_model   — the ridge model fitted on ~4,000 historical contracts
 *      that disclosed a value (scripts/tcv/fit-value-model.ts), predicting from
 *      service line, term, provider, industry, region, event type, the client
 *      population served and the record's population. Interval from held-out
 *      residuals, so the range is as wide as the model's real error.
 *   3. comparables   — the segment × service-line pool (tcv/infer.ts) when the
 *      model has nothing to go on.
 *
 * THIS ENGINE NEVER DECIDES WHETHER SOMETHING IS A CONTRACT. It returns a
 * range or null. It has no access to publication status and no opinion on it.
 */
import { inferTcv, segmentFor } from "./infer";
import { canonicalServiceLine, regionOf, extractUsersServed, featureRow, type ValueModel } from "./value-model";
import valueModelJson from "./value-model.json";
import rateCardJson from "./bpo-rate-card.json";

export const VALUE_ENGINE_BASIS = "value_engine_v1";
export type EstimateMethod = "bpo_rate_card" | "value_model" | "comparables";

export interface ValueInputs {
  serviceLine: string | null;
  sourceType: string | null;
  sourceName?: string | null;
  contractLengthMonths: number | null;
  provider: string | null;
  industry: string | null;
  geography: string | string[] | null;
  eventType: string | null;
  anonymised: boolean;
  usersServed?: number | null;
  announcementYear?: number | null;
  agentCount?: number | null;
  agentTarget?: number | null;
  deliveryLocations?: string[] | null;
  workType?: string | null;
  buyerCountry?: string | null;
  /** Article text, used only to find a stated client population when none was passed. */
  text?: string | null;
}

export interface ValueEstimate {
  lowUsd: number; midUsd: number; highUsd: number;
  method: EstimateMethod;
  /** Stored in tcvBasis; prefixed so analytics can recognise engine output. */
  basis: string;
  version: string;
  inputs: Record<string, unknown>;
  explanation: string;
}

const model = valueModelJson as ValueModel;
type Band = { low: number; high: number; domesticLow?: number; domesticHigh?: number; countries?: string[] };
const card = rateCardJson as { version: string; bands: Record<string, Band>; workTypeMultipliers: Record<string, number>; rampFactorWhenOnlyTargetStated: number; assumedTermMonthsWhenUnstated: number };

const money = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${(n / 1e3).toFixed(0)}k`;
const round3 = (n: number) => { const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(1, n))) - 2)); return Math.round(n / p) * p; };

function bandFor(location: string): { key: string; band: Band } {
  const l = location.toLowerCase();
  for (const key of ["offshore", "nearshore", "onshore"]) {
    const b = card.bands[key];
    if (b.countries?.some(c => l === c || l.includes(c))) return { key, band: b };
  }
  return { key: "unknown", band: card.bands.unknown };
}

/** Route 1 — bottom-up from stated agents, location, work type and term. */
export function estimateBpo(i: ValueInputs): ValueEstimate | null {
  const stated = i.agentCount ?? null, target = i.agentTarget ?? null;
  if (!stated && !target) return null;
  const line = canonicalServiceLine(i.serviceLine);
  if (line !== "BPO" && !i.workType) return null;                 // agents stated for a non-BPO deal are not a price basis
  const agents = stated && target ? (stated + target) / 2 : stated ?? Math.round(target! * card.rampFactorWhenOnlyTargetStated);
  const months = i.contractLengthMonths && i.contractLengthMonths > 0 ? i.contractLengthMonths : card.assumedTermMonthsWhenUnstated;
  const years = months / 12;
  const locs = (i.deliveryLocations ?? []).filter(Boolean);
  const bands = locs.length ? locs.map(bandFor) : [{ key: "unknown", band: card.bands.unknown }];
  const buyer = (i.buyerCountry ?? "").toLowerCase();
  const domestic = !!buyer && bands.some(b => b.band.countries?.some(c => buyer === c || buyer.includes(c))) && bands.every(b => b.key !== "onshore");
  const rateLow = bands.reduce((s, b) => s + (domestic ? (b.band.domesticLow ?? b.band.low) : b.band.low), 0) / bands.length;
  const rateHigh = bands.reduce((s, b) => s + (domestic ? (b.band.domesticHigh ?? b.band.high) : b.band.high), 0) / bands.length;
  const mult = card.workTypeMultipliers[(i.workType ?? "UNKNOWN").toUpperCase()] ?? 1;
  const lowUsd = round3(agents * rateLow * mult * years), highUsd = round3(agents * rateHigh * mult * years);
  const midUsd = round3(Math.sqrt(lowUsd * highUsd));
  const where = locs.length ? `${locs.join("/")} (${[...new Set(bands.map(b => b.key))].join("+")}${domestic ? ", domestic market" : ""})` : "location unstated";
  return {
    lowUsd, midUsd, highUsd, method: "bpo_rate_card", basis: `${VALUE_ENGINE_BASIS}:bpo_rate_card`, version: card.version,
    inputs: { agents, agentCount: stated, agentTarget: target, months, termAssumed: !i.contractLengthMonths, deliveryLocations: locs, band: bands.map(b => b.key), domestic, workType: i.workType ?? "UNKNOWN", ratePerAgentYear: [rateLow * mult, rateHigh * mult] },
    explanation: `${agents} agents × $${Math.round(rateLow * mult / 1000)}k–$${Math.round(rateHigh * mult / 1000)}k per agent-year (${where}, ${i.workType ?? "work type unstated"}) × ${years.toFixed(1)} years${i.contractLengthMonths ? "" : " (term assumed)"} = ${money(lowUsd)}–${money(highUsd)}`,
  };
}

/** Route 2 — the fitted model. */
export function estimateFromModel(i: ValueInputs): ValueEstimate | null {
  if (!model?.coefficients?.length) return null;
  const segment = i.sourceName === "GlobalData" ? "PROCUREMENT" : segmentFor(i.sourceType);
  const users = i.usersServed ?? (i.text ? extractUsersServed(i.text) : null);
  const geography = Array.isArray(i.geography) ? JSON.stringify(i.geography) : i.geography;
  const x = featureRow({ segment, months: i.contractLengthMonths, usersServed: users, anonymised: i.anonymised, year: i.announcementYear ?? new Date().getFullYear(), line: i.serviceLine, vendor: i.provider, industry: i.industry, geography, eventType: i.eventType }, model);
  const fitted = x.reduce((s, v, j) => s + v * model.coefficients[j], 0);
  // Deals that state a value are the larger ones; an undisclosed deal is shifted
  // by the measured offset (see value-model.json undisclosedAdjustment).
  const adjustment = model.undisclosedAdjustment?.[segment] ?? 0;
  const log = fitted + adjustment;
  const band = model.residualBands[segment] ?? model.residualBands.ALL;
  const env = model.envelope[segment];
  const clamp = (v: number) => Math.min(Math.max(v, env.p2), env.p98);
  // Displayed range = interquartile band (half of disclosed deals fall inside it);
  // the 80% band is kept beside it so nobody mistakes the range for certainty.
  const lowUsd = round3(clamp(Math.pow(10, log + band.p25))), highUsd = round3(clamp(Math.pow(10, log + band.p75)));
  const midUsd = round3(clamp(Math.pow(10, log + band.p50)));
  const band80 = [round3(clamp(Math.pow(10, log + band.p10))), round3(clamp(Math.pow(10, log + band.p90)))];
  const line = canonicalServiceLine(i.serviceLine);
  const bits = [line !== "other" ? line : null, i.contractLengthMonths ? `${i.contractLengthMonths}-month term` : "term unstated", i.provider && model.vocab.vendors.includes(i.provider) ? i.provider : null, i.industry && model.vocab.industries.includes(i.industry) ? i.industry : null, regionOf(geography) !== "unknown" ? regionOf(geography) : null, users ? `${users.toLocaleString()} users served` : null].filter(Boolean);
  return {
    lowUsd, midUsd, highUsd, method: "value_model", basis: `${VALUE_ENGINE_BASIS}:value_model`, version: model.version,
    inputs: { segment, serviceLine: line, months: i.contractLengthMonths, provider: i.provider, industry: i.industry, region: regionOf(geography), eventType: i.eventType, usersServed: users, anonymised: i.anonymised, fittedLog10: Number(fitted.toFixed(3)), undisclosedAdjustmentLog10: adjustment, predictedLog10: Number(log.toFixed(3)), band80 },
    explanation: `fitted on ${model.n} contracts that stated a value (${bits.join(", ")})${adjustment ? `, shifted ×${Math.pow(10, adjustment).toFixed(2)} because undisclosed deals run smaller (${segment === "PROCUREMENT" ? "measured against" : "assumed from"} ${model.thirdPartyValidation?.n ?? 0} analyst estimates)` : ""}: ${money(lowUsd)}–${money(highUsd)} is the 50% band; 80% band ${money(band80[0])}–${money(band80[1])}; typical error ${model.heldOut.typicalFactor.toFixed(1)}x`,
  };
}

/** Route 3 — the comparables pool. */
export async function estimateFromComparables(i: ValueInputs): Promise<ValueEstimate | null> {
  const v = await inferTcv({ serviceLine: i.serviceLine, sourceType: i.sourceType, contractLengthMonths: i.contractLengthMonths });
  if (v.state !== "INFERRED") return null;
  return { lowUsd: v.lowUsd, midUsd: v.midUsd, highUsd: v.highUsd, method: "comparables", basis: `${VALUE_ENGINE_BASIS}:comparables`, version: "comparables/2", inputs: { serviceLine: i.serviceLine, months: i.contractLengthMonths, anchors: v.anchors, tier: v.tier }, explanation: `${v.anchors} comparable disclosed contracts (${v.tier} pool): ${money(v.lowUsd)}–${money(v.highUsd)}` };
}

/**
 * The estimate for an undisclosed contract, most specific route first.
 * Returns null only when nothing can be said; it never returns a verdict on
 * whether the event is a contract.
 */
export async function estimateContractValue(i: ValueInputs): Promise<ValueEstimate | null> {
  return estimateBpo(i) ?? estimateFromModel(i) ?? (await estimateFromComparables(i));
}
