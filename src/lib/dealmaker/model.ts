/**
 * Deal Maker renewal model — a port of FedSpend's score_renewal.py
 * (~/Dev/ag-contract-sources) to commercial IT-services contracts.
 *
 * Two scores per contract, both 5–95:
 *   renewalProb       relative propensity for the scope to come back to market (re-awarded, renewed or re-competed).
 *                     50 is an average contract. It is a propensity, not a probability: coverage is announcement-based,
 *                     so a successor we never saw is mostly missing data, not evidence that there was none.
 *   displacementRisk  how likely the incumbent is to LOSE the scope when it does come back. Anchored on the observed
 *                     incumbent-retention rate, which is well estimated because it is conditioned on outcomes we saw.
 *
 * Evidence of an outcome, per contract, comes from two places:
 *   explicit   a later announcement for the same client and service line that says what happened: a RENEWAL or
 *              EXTENSION by the same provider (retained), a COMPETITIVE_TAKEAWAY or REPLACEMENT that names this
 *              provider as displaced, or a TERMINATION (lost). FedSpend had no such field; press releases do.
 *   successor  as in FedSpend: another contract for the same client family starting within ±180 days of this one's
 *              end, with a materially similar scope. Same provider = retained, another provider = displaced.
 *
 * A "family" is (client, service line); the client is the resolved entity when there is one, else the normalised
 * client name. Unnamed clients ("a US telecoms client") never form families.
 */
export const MODEL_VERSION = "dealmaker-renewal/1.0.0-2026-11-27";

const DAY = 86_400_000;
const RENEWAL_WINDOW_DAYS = 180;
const SCOPE_JACCARD_MIN = 0.34;
const SCOPE_CONTAIN_MIN = 0.6;
const MIN_SCOPE_TOKENS = 3;

export interface ContractRow {
  id: string;
  title: string;
  announced: Date | null;
  start: Date | null;
  end: Date | null;
  /** How the end date is known: "stated" (day/month precision), "estimated" (derived from start + term, or estimated). */
  endBasis: "stated" | "estimated" | null;
  termMonths: number | null;
  vendorId: string | null;
  vendorName: string;
  vendorSlug: string | null;
  clientKey: string | null;
  clientName: string | null;
  clientAnonymised: boolean;
  industry: string | null;
  sector: string | null;
  region: string | null;
  country: string | null;
  serviceLine: string | null;
  microServiceLine: string | null;
  tcvUsd: number | null;
  tcvIsEstimate: boolean;
  commercialType: string | null;
  displacedVendor: string | null;
  eventStatus: string | null;
  aiRelevance: string | null;
  scope: string | null;
  url: string | null;
  writeUp: string | null;
}

export interface Scores {
  renewalProb: number;
  displacementRisk: number;
  /** What moved each score, in plain words, for the detail panel. */
  factors: string[];
  familySize: number;
  familyVendors: number;
}

const STOP = new Set(`a an and are as at be by for from has have in into is it its of on or that the to was were will with within via per not no nor but if then than
contract contracts agreement framework deal award awarded win wins new renewal renewed extension extended expansion multi year years month months annual
service services provide provider provision solution solutions support delivery partner partnership strategic global leading transformation program programme project
ltd limited plc inc llc pty gmbh corp corporation group holdings company client customer undisclosed unnamed`.split(/\s+/));

export function scopeTokens(text: string | null): Set<string> {
  if (!text) return new Set();
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));
}

export function sameScope(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  if (!inter) return false;
  const union = a.size + b.size - inter;
  if (union && inter / union >= SCOPE_JACCARD_MIN) return true;
  return inter / Math.min(a.size, b.size) >= SCOPE_CONTAIN_MIN;
}

const LEGAL = /\b(inc|incorporated|ltd|limited|plc|llc|llp|lp|corp|corporation|co|company|group|groupe|holdings?|gmbh|ag|sa|se|nv|bv|pty|spa|srl|sarl|oy|ab|as|kk|the)\b/g;
/** A client name reduced to what identifies it ("Department for Work and Pensions (DWP)" → "department for work and pensions dwp"). */
export function normaliseClient(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  return n.length >= 2 ? n : null;
}

export const vendorKey = (c: Pick<ContractRow, "vendorId" | "vendorName">) => c.vendorId ?? c.vendorName.toLowerCase();
export const familyKey = (c: Pick<ContractRow, "clientKey" | "clientAnonymised" | "serviceLine">) => c.clientKey && !c.clientAnonymised ? `${c.clientKey}|${c.serviceLine ?? "?"}` : null;
const sectorKey = (c: ContractRow) => c.industry ?? c.sector ?? "unknown";
const clip = (x: number) => Math.max(0.05, Math.min(0.95, x));
const RETAINED_TYPES = new Set(["RENEWAL", "EXTENSION", "EXPANSION"]);
const TAKEAWAY_TYPES = new Set(["COMPETITIVE_TAKEAWAY", "REPLACEMENT"]);

/** The model fitted to a set of contracts; `score` answers for any of them. */
export function fitModel(contracts: ContractRow[], today = new Date()) {
  const byFamily = new Map<string, ContractRow[]>();
  for (const c of contracts) { const k = familyKey(c); if (k) (byFamily.get(k) ?? byFamily.set(k, []).get(k)!).push(c); }
  const tokens = new Map(contracts.map(c => [c.id, scopeTokens(`${c.title} ${c.scope ?? ""}`)]));

  // Outcome per judged contract: renewed (came back to market) and, if so, whether the incumbent kept it.
  const famStats = new Map<string, { judged: number; renewed: number; retained: number }>();
  const vendStats = new Map<string, { judged: number; retained: number }>();
  for (const [fk, recs] of byFamily) {
    const st = { judged: 0, renewed: 0, retained: 0 };
    const sorted = recs.filter(r => r.start ?? r.announced).sort((a, b) => +(a.start ?? a.announced)! - +(b.start ?? b.announced)!);
    for (const r of sorted) {
      const tok = tokens.get(r.id)!;
      const ended = r.end && r.end.getTime() < today.getTime() - 30 * DAY;
      let renewed = false, retained = false, judged = false;
      // Explicit: a later announcement in the family that says what happened to this provider's scope.
      for (const s of sorted) {
        if (s === r) continue;
        const sStart = (s.start ?? s.announced)!.getTime(), rStart = (r.start ?? r.announced)!.getTime();
        if (sStart <= rStart) continue;
        const sameVendor = vendorKey(s) === vendorKey(r);
        if (sameVendor && s.commercialType && RETAINED_TYPES.has(s.commercialType)) { judged = renewed = retained = true; break; }
        if (!sameVendor && s.commercialType && TAKEAWAY_TYPES.has(s.commercialType)
          && (!s.displacedVendor || s.displacedVendor.toLowerCase().includes(r.vendorName.toLowerCase().split(" ")[0]))) { judged = renewed = true; retained = false; break; }
      }
      // Successor: FedSpend's test, for ended contracts with enough scope text to match on.
      if (!judged && ended && tok.size >= MIN_SCOPE_TOKENS) {
        judged = true;
        const lo = r.end!.getTime() - RENEWAL_WINDOW_DAYS * DAY, hi = r.end!.getTime() + RENEWAL_WINDOW_DAYS * DAY;
        for (const s of sorted) {
          if (s === r) continue;
          const t = (s.start ?? s.announced)!.getTime();
          if (t < lo || t > hi || !sameScope(tok, tokens.get(s.id)!)) continue;
          renewed = true;
          if (vendorKey(s) === vendorKey(r)) { retained = true; break; }
        }
      }
      if (!judged) continue;
      st.judged++; if (renewed) st.renewed++; if (retained) st.retained++;
      const v = vendStats.get(vendorKey(r)) ?? { judged: 0, retained: 0 };
      if (renewed) { v.judged++; if (retained) v.retained++; }
      vendStats.set(vendorKey(r), v);
    }
    famStats.set(fk, st);
  }

  // Sector and global rates. Renewal is a lower bound (truncated coverage); retention is the trustworthy quantity.
  const sec = new Map<string, { judged: number; renewed: number; retained: number }>();
  for (const [fk, st] of famStats) {
    const k = sectorKey(byFamily.get(fk)![0]);
    const s = sec.get(k) ?? { judged: 0, renewed: 0, retained: 0 };
    s.judged += st.judged; s.renewed += st.renewed; s.retained += st.retained; sec.set(k, s);
  }
  let tj = 0, tr = 0, ti = 0;
  for (const s of sec.values()) { tj += s.judged; tr += s.renewed; ti += s.retained; }
  const globalRate = tj ? tr / tj : 0.2;
  const globalRetention = tr ? ti / tr : 0.5;
  const secRate = (k: string) => { const s = sec.get(k); return s && s.judged >= 20 ? s.renewed / s.judged : null; };
  const secRetention = (k: string) => { const s = sec.get(k); return s && s.renewed >= 15 ? s.retained / s.renewed : null; };
  const famVendors = new Map([...byFamily].map(([k, v]) => [k, new Set(v.map(vendorKey)).size]));

  function score(c: ContractRow): Scores {
    const factors: string[] = [];
    const fk = familyKey(c);
    const fam = (fk && famStats.get(fk)) || { judged: 0, renewed: 0, retained: 0 };
    const ven = vendStats.get(vendorKey(c)) ?? { judged: 0, retained: 0 };
    const sk = sectorKey(c), sr = secRate(sk);

    // ── Renewal propensity ──
    let p = 0.5;
    if (sr != null && globalRate > 0) { const d = Math.max(-0.12, Math.min(0.12, ((sr - globalRate) / globalRate) * 0.12)); p += d; if (Math.abs(d) >= 0.03) factors.push(`${sk} contracts come back to market ${d > 0 ? "more" : "less"} often than average`); }
    if (fam.judged >= 3) {
      const fr = fam.renewed / fam.judged;
      if (fr > globalRate) { p += Math.min(0.2, (fr - globalRate) * 0.6); factors.push(`this client re-awards this service line often (${fam.renewed} of ${fam.judged})`); }
      else p -= Math.min(0.06, (globalRate - fr) * 0.3);
    } else if (fam.renewed >= 1) { p += 0.08; factors.push("a re-award has been seen for this client and service line"); }
    if (ven.judged >= 5) p += Math.max(-0.05, Math.min(0.1, (ven.retained / ven.judged - globalRetention) * 0.2));
    const v = c.tcvUsd ?? 0;
    if (v >= 100e6) { p += 0.1; factors.push("a large deal (≥ $100m)"); } else if (v >= 10e6) p += 0.05; else if (v > 0 && v < 1e6) p -= 0.05;
    const yrs = c.termMonths != null ? c.termMonths / 12 : c.start && c.end ? (c.end.getTime() - c.start.getTime()) / (365.25 * DAY) : null;
    if (yrs != null) { if (yrs >= 5) { p += 0.1; factors.push(`a long term (${Math.round(yrs)} years)`); } else if (yrs >= 3) p += 0.06; else if (yrs >= 1) p += 0.02; else if (yrs < 0.5) p -= 0.05; }
    if (c.end) { const since = (today.getTime() - c.end.getTime()) / DAY; if (since > 3 * 365) p -= 0.12; else if (since > 365) p -= 0.05; }

    // ── Displacement risk ──
    let d = 1 - globalRetention;
    if (fam.renewed >= 3) { d = 0.55 * (1 - fam.retained / fam.renewed) + 0.45 * d; factors.push(`incumbents ${fam.retained / fam.renewed >= 0.5 ? "usually keep" : "often lose"} this client's re-awards (${fam.retained} of ${fam.renewed} kept)`); }
    else { const s = secRetention(sk); if (s != null) d = 0.3 * (1 - s) + 0.7 * d; }
    if (ven.judged >= 8) { d = 0.7 * d + 0.3 * (1 - ven.retained / ven.judged); factors.push(`${c.vendorName} kept ${ven.retained} of ${ven.judged} scopes that came back`); }
    const nFam = fk ? byFamily.get(fk)!.length : 0, nVen = fk ? famVendors.get(fk)! : 0;
    if (nFam >= 8) d += Math.max(-0.05, Math.min(0.08, (nVen / nFam - 0.5) * 0.16));
    const start = c.start ?? c.announced;
    if (start) { const age = (today.getTime() - start.getTime()) / (365.25 * DAY); if (age >= 8) { d += 0.06; factors.push("a long-held contract (8+ years) invites fresh scrutiny"); } else if (age >= 5) d += 0.03; }

    return { renewalProb: Math.round(clip(p) * 100), displacementRisk: Math.round(clip(d) * 100), factors, familySize: nFam, familyVendors: nVen };
  }

  /** A vendor's record on scopes that came back to market: how many it kept. */
  const vendorRecord = (c: Pick<ContractRow, "vendorId" | "vendorName">) => vendStats.get(vendorKey(c)) ?? { judged: 0, retained: 0 };
  return { score, vendorRecord, byFamily, stats: { contracts: contracts.length, families: byFamily.size, judged: tj, globalRenewalRate: globalRate, globalRetention } };
}
