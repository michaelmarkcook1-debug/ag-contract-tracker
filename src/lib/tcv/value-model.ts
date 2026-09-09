/**
 * Shared definitions for the fitted contract value model: the JSON shape the
 * fitter writes, the feature normalisers both fitter and engine must agree on,
 * and the text extractor for the client population an article says is served.
 */
export const VALUE_MODEL_VERSION = "value_model/1.0.0-2026-09-08";

export interface ResidualBand { p10: number; p25: number; p50: number; p75: number; p90: number; coverage80: number; n: number }
export interface ValueModel {
  version: string;
  fittedAt: string;
  n: number;
  lambda: number;
  target: string;
  features: string[];
  coefficients: number[];
  vocab: { lines: string[]; vendors: string[]; industries: string[]; regions: string[]; eventTypes: string[] };
  medianMonths: { PROCUREMENT: number; ANNOUNCED: number };
  residualBands: { PROCUREMENT: ResidualBand; ANNOUNCED: ResidualBand; ALL: ResidualBand };
  heldOut: { medianAbsLog10Error: number; typicalFactor: number; within2x: number; within3x: number };
  envelope: { PROCUREMENT: { p2: number; p98: number }; ANNOUNCED: { p2: number; p98: number } };
  /** Validation of the fit against an independent analyst house's estimates (never fitted on). */
  thirdPartyValidation?: { n: number; medianOffsetLog10: number; medianAbsLog10Error: number; within2x: number };
  /**
   * Deals that state a value are the larger ones (disclosure bias). For a deal
   * that did NOT state one, the point estimate is shifted by this log10 offset:
   * measured for procurement records against the analyst house's estimates of
   * undisclosed deals with the same features; assumed equal for announced deals,
   * where no external reference exists. Recorded here so it can be revised.
   */
  undisclosedAdjustment?: { PROCUREMENT: number; ANNOUNCED: number; basis: string };
}

/** The service-line labels in the store are several vocabularies; fold them to one. */
export function canonicalServiceLine(line: string | null | undefined): string {
  const l = (line ?? "").trim().toLowerCase();
  if (!l) return "other";
  if (/\bbpo\b|business process|contact cent|customer (service|experience|care)|\bcx\b|payroll|back[- ]office/.test(l)) return "BPO";
  if (/\bito\b|infrastructure|data cent|workplace|end[- ]user|service desk|network|telco|managed services/.test(l)) return "ITO";
  if (/application|\badm\b|\berp\b|enterprise app|software (development|engineering)|digital engineering/.test(l)) return "Application Services";
  if (/cloud|digital transformation|digital & cloud|modernis/.test(l)) return "Digital & Cloud";
  if (/\bai\b|analytics|data|machine learning|genai/.test(l)) return "AI & Analytics";
  if (/consult|advisory|strategy/.test(l)) return "Consulting";
  if (/cyber|security/.test(l)) return "Cybersecurity";
  if (/engineering|\ber&d\b|product engineering|embedded/.test(l)) return "Engineering";
  return "other";
}

const REGION: [RegExp, string][] = [
  [/\b(united states|usa|u\.s\.|us|canada|north america|mexico)\b/i, "NA"],
  [/\b(united kingdom|uk|u\.k\.|england|scotland|wales|britain|ireland)\b/i, "UK"],
  [/\b(india)\b/i, "INDIA"],
  [/\b(germany|france|spain|italy|netherlands|belgium|sweden|norway|denmark|finland|poland|switzerland|austria|portugal|europe|eu|nordic|czech|romania|hungary|luxembourg)\b/i, "EU"],
  [/\b(australia|new zealand|singapore|japan|china|hong kong|malaysia|philippines|indonesia|thailand|vietnam|korea|taiwan|apac|asia)\b/i, "APAC"],
  [/\b(brazil|argentina|chile|colombia|peru|latin america|latam)\b/i, "LATAM"],
  [/\b(uae|saudi|qatar|dubai|middle east|africa|south africa|nigeria|kenya|egypt|israel|turkey)\b/i, "MEA"],
  [/\b(global|worldwide|multi-country|international)\b/i, "GLOBAL"],
];
/** First recognisable region in the stored geography (a JSON array or plain text). */
export function regionOf(geography: string | null | undefined): string {
  if (!geography) return "unknown";
  let text = geography;
  try { const arr = JSON.parse(geography); if (Array.isArray(arr)) text = arr.join(" "); } catch { /* plain text */ }
  for (const [re, r] of REGION) if (re.test(text)) return r;
  return "unknown";
}

/**
 * The size of the client population an article says the work serves —
 * "supports 35,000 employees across Premier Inn…", "used by 91,000 employees".
 * A strong size proxy for ITO and application deals. Takes the largest stated
 * figure, ignores the provider's own headcount when the sentence is about the
 * provider, and ignores anything under 50 (a team, not a population).
 */
export function extractUsersServed(text: string): number | null {
  const re = /\b(\d{1,3}(?:,\d{3})+|\d{2,7})\s*(?:\+|plus)?\s*(employees|staff|users|end[- ]users|people|workers|colleagues|members|customers|policyholders|citizens|students|seats|desktops|devices)\b/gi;
  let best: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 80), m.index).toLowerCase();
    if (/\b(our|its own|the company'?s? own|we employ|headcount of|workforce of|employs)\b/.test(before) && /\b(provider|we|our)\b/.test(before)) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 50 || n > 5_000_000) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

export interface FeatureInputs {
  segment: "PROCUREMENT" | "ANNOUNCED";
  months: number | null;
  usersServed: number | null;
  anonymised: boolean;
  year: number | null;
  line: string | null;
  vendor: string | null;
  industry: string | null;
  geography: string | null;
  eventType: string | null;
}

/** The feature names, in coefficient order, for a vocabulary. */
export function featureNames(vocab: ValueModel["vocab"]): string[] {
  const names = ["intercept", "segment:PROCUREMENT", "log_months", "months_missing", "log_users", "users_missing", "anonymised", "year_c"];
  for (const v of vocab.lines) names.push(`line:${v}`);
  for (const v of vocab.vendors) names.push(`vendor:${v}`);
  for (const v of vocab.industries) names.push(`industry:${v}`);
  for (const v of vocab.regions) names.push(`region:${v}`);
  for (const v of vocab.eventTypes) names.push(`event:${v}`);
  return names;
}

/** One design-matrix row. The fitter and the engine both call this, so they cannot disagree. */
export function featureRow(f: FeatureInputs, m: Pick<ValueModel, "vocab" | "medianMonths" | "features">): number[] {
  const names = m.features.length ? m.features : featureNames(m.vocab);
  const idx = new Map(names.map((n, i) => [n, i]));
  const x = new Array<number>(names.length).fill(0);
  const set = (k: string, v = 1) => { const i = idx.get(k); if (i != null) x[i] = v; };
  set("intercept");
  if (f.segment === "PROCUREMENT") set("segment:PROCUREMENT");
  const months = f.months && f.months > 0 ? f.months : null;
  set("log_months", Math.log10(months ?? m.medianMonths[f.segment]));
  set("months_missing", months ? 0 : 1);
  set("log_users", f.usersServed ? Math.log10(f.usersServed) : 0);
  set("users_missing", f.usersServed ? 0 : 1);
  set("anonymised", f.anonymised ? 1 : 0);
  set("year_c", (f.year ?? 2024) - 2024);
  const line = canonicalServiceLine(f.line);
  set(`line:${m.vocab.lines.includes(line) ? line : "other"}`);
  set(`vendor:${f.vendor && m.vocab.vendors.includes(f.vendor) ? f.vendor : "other"}`);
  set(`industry:${f.industry && m.vocab.industries.includes(f.industry) ? f.industry : "other"}`);
  const region = regionOf(f.geography);
  set(`region:${m.vocab.regions.includes(region) ? region : "unknown"}`);
  set(`event:${f.eventType && m.vocab.eventTypes.includes(f.eventType) ? f.eventType : "other"}`);
  return x;
}
