/**
 * Deal Maker grades and write-up — ports of FedSpend's client-side gradeRisk, gradeUrgency, gradeChurn, gradeAI and
 * buildAnalysis (public/index.html), adapted to commercial IT services:
 *   - FedSpend's hand-curated vendor lists (RISK_INTEL, CHURN_INTEL) and GDELT news score are replaced by a vendor
 *     signal score computed from this catalogue's own events (leadership departures, restructuring and layoffs,
 *     terminations and disputes, M&A, wins).
 *   - AI readiness uses the reader's aiRelevance field where FedSpend used a keyword regex.
 */
import type { ContractRow, Scores } from "./model";

export interface Grade { key: string; label: string; tip: string }

/** Days from today to the contract's end; negative once ended. */
export const daysToEnd = (c: Pick<ContractRow, "end">, today = new Date()) => c.end ? Math.round((c.end.getTime() - today.getTime()) / 86_400_000) : null;

export const WINDOWS = [
  { key: "expired30", label: "Ended in the last 30 days", test: (d: number) => d < 0 && d >= -30 },
  { key: "0-3", label: "0–3 months", test: (d: number) => d >= 0 && d <= 91 },
  { key: "3-6", label: "3–6 months", test: (d: number) => d > 91 && d <= 182 },
  { key: "6-12", label: "6–12 months", test: (d: number) => d > 182 && d <= 365 },
  { key: "12-18", label: "12–18 months", test: (d: number) => d > 365 && d <= 548 },
  { key: "18+", label: "18 months +", test: (d: number) => d > 548 },
] as const;
export type WindowKey = typeof WINDOWS[number]["key"];
export const windowOf = (d: number | null): WindowKey | null => d == null ? null : WINDOWS.find(w => w.test(d))?.key ?? null;

export function gradeUrgency(d: number | null): Grade {
  if (d == null) return { key: "unknown", label: "Unknown", tip: "No end date" };
  if (d < 0) return { key: "expired", label: `Ended ${-d}d ago`, tip: "Recently ended — check who won the follow-on" };
  if (d <= 30) return { key: "critical", label: `${d}d — critical`, tip: "Immediate action" };
  if (d <= 90) return { key: "urgent", label: `${d}d — urgent`, tip: "Active pursuit phase" };
  if (d <= 180) return { key: "near", label: `${d}d — near-term`, tip: "Competitive evaluation window" };
  if (d <= 365) return { key: "mid", label: `${d}d — mid-term`, tip: "Positioning window" };
  return { key: "early", label: `${d}d — early`, tip: "Early pipeline" };
}

/** Re-compete risk: value × time to expiry, raised by a vendor whose recent events signal stress. */
export function gradeRisk(tcv: number, d: number | null, vendorSignal: number): Grade {
  const stressed = vendorSignal >= 60, strained = vendorSignal >= 45;
  const money = tcv >= 1e9 ? `$${(tcv / 1e9).toFixed(2)}bn` : `$${(tcv / 1e6).toFixed(0)}m`;
  if ((tcv > 1e9 && d != null && d <= 60 && d >= -60) || (stressed && tcv > 250e6 && d != null && d <= 90 && d >= -30))
    return { key: "critical", label: "Critical", tip: `${money} contract ${d != null && d < 0 ? `ended ${-d}d ago` : `ends in ${d}d`}${stressed ? " · incumbent under stress" : ""}` };
  if ((tcv > 250e6 && d != null && d <= 90 && d >= -30) || stressed || (tcv > 100e6 && d != null && d <= 30 && d >= -30))
    return { key: "urgent", label: "Urgent", tip: stressed ? "The incumbent's recent events signal stress (departures, restructuring, lost or disputed contracts)" : `Large contract (${money}) near expiry` };
  if ((tcv > 50e6 && d != null && d <= 365) || strained || (d != null && d >= -30 && d < 0))
    return { key: "concern", label: "Some concerns", tip: strained ? "Some stress signals at the incumbent" : "Material value or recent expiry — watch for a re-compete" };
  if (tcv > 0 && d != null && d > 540 && tcv < 50e6) return { key: "positive", label: "Positive", tip: "Long runway, modest scale" };
  return { key: "standard", label: "Standard", tip: "No elevated risk signals" };
}

export function gradeChurn(tcv: number, d: number | null, singleVendorClient: boolean, vendorExpiring: number): Grade {
  let s = 0;
  if (d != null) { if (d <= 30) s += 4; else if (d <= 90) s += 3; else if (d <= 180) s += 2; else if (d <= 365) s += 1; }
  if (tcv > 500e6) s += 3; else if (tcv > 100e6) s += 2; else if (tcv > 20e6) s += 1;
  if (singleVendorClient) s += 1;
  if (vendorExpiring > 20) s += 1;
  if (s >= 6) return { key: "critical", label: "Critical", tip: "Near expiry with a lot at stake" };
  if (s >= 4) return { key: "elevated", label: "Elevated", tip: "Re-compete likely" };
  if (s >= 2) return { key: "moderate", label: "Moderate", tip: "Monitor positioning" };
  return { key: "low", label: "Low", tip: "Stable, early window" };
}

const AI_SUITED = new Set(["BPO", "Application Services", "AI & Analytics", "Digital & Cloud", "ITO", "Cybersecurity", "ERP & Enterprise Apps"]);
export function gradeAI(c: Pick<ContractRow, "aiRelevance" | "serviceLine">, tcv: number): Grade {
  if (c.aiRelevance === "EXPLICIT_AI" || c.aiRelevance === "AI_MATERIAL") return { key: "active", label: "AI active", tip: "AI is part of the scope already" };
  if (c.serviceLine && AI_SUITED.has(c.serviceLine)) {
    if (tcv > 100e6) return { key: "high", label: "High potential", tip: `${c.serviceLine} at this scale is a strong AI-led re-bid` };
    if (tcv > 10e6) return { key: "moderate", label: "Moderate", tip: "AI enhancement possible at re-bid" };
    return { key: "low", label: "Low potential", tip: "Smaller scope for AI" };
  }
  return { key: "limited", label: "Limited", tip: "Service line less suited to AI" };
}

export type Action = "pitch" | "defend" | "monitor" | null;
export function suggestedAction(s: Scores): Action {
  if (s.renewalProb >= 60 && s.displacementRisk >= 60) return "pitch";
  if (s.renewalProb >= 60 && s.displacementRisk < 40) return "defend";
  if (s.renewalProb < 30) return "monitor";
  return null;
}
export const ACTION_LABELS: Record<Exclude<Action, null>, string> = {
  pitch: "Competitive pitch", defend: "Defend the account", monitor: "Monitor only",
};

/** The analysis paragraph from FedSpend's buildAnalysis, in plain text. */
export function analysis(c: ContractRow, s: Scores, d: number | null): string {
  const scope = c.serviceLine ?? "this scope";
  const parts: string[] = [];
  const r = s.renewalProb, x = s.displacementRisk;
  parts.push(`Renewal propensity is ${r >= 65 ? "above average" : r >= 40 ? "about average" : "below average"} (${r}/100, where 50 is a typical contract)${s.factors.length ? ` — ${s.factors.slice(0, 2).join("; ")}` : ""}.`);
  parts.push(`The incumbent's position is ${x >= 65 ? "weak" : x >= 40 ? "even" : "strong"} (displacement risk ${x}/100): ${x >= 65 ? `${c.vendorName} tends to lose re-awards like this` : x >= 40 ? `${c.vendorName} has roughly even odds of keeping it` : `${c.vendorName} is a defensible incumbent here`}.`);
  if (d != null && d >= 0 && d <= 540) {
    const val = c.tcvUsd ? (c.tcvUsd >= 1e9 ? `$${(c.tcvUsd / 1e9).toFixed(1)}bn` : `$${(c.tcvUsd / 1e6).toFixed(0)}m`) : "an undisclosed-value";
    parts.push(`With ${d} days to expiry on ${val} ${scope} deal, this is ${d <= 90 ? "a hot pursuit window" : d <= 180 ? "a near-term pursuit" : "a strategic-plan target"}.`);
  }
  const a = suggestedAction(s);
  if (a === "pitch") parts.push("Suggested action: prioritise a competitive pitch.");
  else if (a === "defend") parts.push("Suggested action: defend the account; the incumbent is entrenched.");
  else if (a === "monitor") parts.push("Suggested action: monitor only; this scope is not reliably re-contracted.");
  if (c.endBasis === "estimated") parts.push("The end date is estimated from the start date and term.");
  return parts.join(" ");
}
