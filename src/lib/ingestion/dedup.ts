/**
 * Organisation-name matching for deduplication. Pure functions; the DB lookups
 * live in the pipeline.
 *
 * Several outlets report one event over several days with the counterparty
 * spelled differently ("Porsche", "Porsche AG", "Porsche (MHP)"). Exact keys
 * on the raw string missed all of those — measured 2026-09: 18 of 49 kept
 * articles in a sample were re-reports of six stories.
 */

const LEGAL_SUFFIX = /\b(inc|incorporated|ltd|limited|plc|llc|llp|corp|corporation|co|company|group|holdings?|sa|ag|se|nv|bv|gmbh|spa|pty|pvt|private|public|the|of)\b/g;

/** Lower-case, strip parentheticals, punctuation and legal suffixes. */
export function normaliseOrg(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words that carry no identity on their own. "UK Ministry of Justice" and
// "UK Ministry of Defence" share two of three tokens; "Deutsche Bank" and
// "Danske Bank" share one of two. Only the distinctive tokens may match.
const GENERIC_TOKENS = new Set([
  "uk", "us", "usa", "eu", "ministry", "department", "dept", "government", "govt", "bank", "services", "service",
  "solutions", "technologies", "technology", "tech", "systems", "international", "global", "national", "council",
  "university", "hospital", "health", "healthcare", "authority", "agency", "office", "city", "state", "federal",
  "digital", "consulting", "partners", "industries", "energy", "telecom", "telecommunications", "insurance",
  "financial", "finance", "capital", "markets", "mutual", "fund", "and", "de", "la", "le", "el", "of", "the",
  "north", "south", "east", "west", "new", "trust", "foundation", "association", "board", "region", "regional",
  // Announcement boilerplate. Two different awards to the same vendor share
  // "has been awarded a five-year contract" word for word; that is not
  // evidence they are the same award.
  "awarded", "award", "awards", "contract", "contracts", "contracted", "agreement", "agreements", "deal", "deals",
  "five", "three", "four", "seven", "multi", "year", "years", "group", "limited", "provide", "provides", "providing",
  "announces", "announced", "announce", "signs", "signed", "sign", "selected", "selects", "wins", "win", "secures",
  "secured", "company", "corp", "corporation", "subsidiary", "part", "with", "from", "into", "over", "under",
  "million", "billion", "crore", "worth", "valued", "been", "have", "will", "that", "this", "their", "which",
]);

function distinctiveTokens(s: string): Set<string> {
  return new Set(s.split(" ").filter(w => w.length > 1 && !GENERIC_TOKENS.has(w)));
}

/**
 * True when two organisation names plausibly denote the same body: identical
 * after normalisation, one contains the other (≥4 chars), or half or more of
 * the shorter name's DISTINCTIVE tokens appear in the other. Deliberately not
 * looser — merging two different clients' contracts is worse than keeping a
 * duplicate.
 */
export function orgsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normaliseOrg(a), y = normaliseOrg(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  const tx = distinctiveTokens(x), ty = distinctiveTokens(y);
  if (tx.size === 0 || ty.size === 0) return false;
  let inter = 0;
  tx.forEach(t => { if (ty.has(t)) inter++; });
  return inter >= 1 && inter / Math.min(tx.size, ty.size) >= 0.5;
}

/**
 * Jaccard similarity of the distinctive words in two titles. Used only when
 * NEITHER side names a counterparty (results, org changes, launches), where
 * "same vendor, same week" is not specific enough on its own.
 */
// "completes" / "completed" / "completion" should count as one word.
function stem(w: string): string {
  return w.length > 5 ? w.replace(/(?:ation|ments?|ings?|ies|es|ed|s)$/, "") : w;
}
export function titleSimilarity(a: string, b: string): number {
  const tok = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 3 && !GENERIC_TOKENS.has(w)).map(stem));
  const x = tok(a), y = tok(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0; x.forEach(w => { if (y.has(w)) inter++; });
  return inter / (x.size + y.size - inter);
}

/** Window for events without a counterparty — results and launches are re-reported within days, not weeks. */
export const SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY = 7;
export const TITLE_MATCH_THRESHOLD = 0.5;
/** Stricter title threshold used when both sides name a counterparty but the names failed to match (acronym vs full name). */
export const TITLE_FALLBACK_THRESHOLD = 0.6;
/** Families where one announcement is re-reported under very different headlines within the week. */
export const VENDOR_WINDOW_FAMILIES = new Set(["FINANCIAL_RESULTS"]);
/** …but the headlines must still share something, or a results release swallows a same-week fundraise. */
export const RESULTS_TITLE_THRESHOLD = 0.25;

/**
 * First monetary amount in a title, in units of the stated currency (millions
 * and billions expanded). Two reports of one award quote the same figure;
 * two different awards to the same buyer in one week — common in procurement
 * feeds — quote different ones, and must not be merged on the buyer alone.
 */
export function titleAmount(title: string): number | null {
  const m = /(?:[$£€]|USD|GBP|EUR|AUD|CAD|INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(billion|bn|million|mn|m|crore|cr|k)?\b/i.exec(title)
    ?? /([\d,]+(?:\.\d+)?)\s*(billion|bn|million|mn|crore)\b/i.exec(title);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = /^(billion|bn)$/.test(unit) ? 1e9 : /^(million|mn|m)$/.test(unit) ? 1e6 : /^(crore|cr)$/.test(unit) ? 1e7 : unit === "k" ? 1e3 : 1;
  return n * mult;
}

/** True when both titles state an amount and the amounts differ by more than 10%. */
export function amountsConflict(a: string, b: string): boolean {
  const x = titleAmount(a), y = titleAmount(b);
  if (x === null || y === null) return false;
  return Math.abs(x - y) / Math.max(x, y) > 0.1;
}

/**
 * Counterparty from a title when the row has none stored. Two forms:
 *  - the pipeline's canonical "Vendor | EventType | Client | ServiceLine";
 *  - the imported procurement wording "X has been awarded a contract by Y to…",
 *    "selected by Y", "agreement with Y". Without this, those rows have no
 *    counterparty at all and would only ever be compared on boilerplate.
 */
const BUYER_PATTERNS = [
  /awarded (?:an? |the )?(?:[^.]*? )?(?:contract|order|framework|agreement)s? (?:by|from) ([^.,(]+?)(?: to | for | worth | valued |\.|,|\(|$)/i,
  /(?:selected|chosen|appointed|picked|engaged|retained) by ([^.,(]+?)(?: to | for | as |\.|,|\(|$)/i,
  /(?:contract|agreement|deal|engagement|partnership) with ([^.,(]+?)(?: to | for | worth | valued |\.|,|\(|$)/i,
];
export function titleCounterparty(title: string): string | null {
  const parts = title.split("|").map(p => p.trim());
  if (parts.length >= 3 && parts[2]) return parts[2];
  for (const re of BUYER_PATTERNS) {
    const m = re.exec(title);
    if (m && m[1].trim().length >= 3) return m[1].trim();
  }
  return null;
}

/** Families whose events are meaningless without a counterparty — never merged on title wording alone. */
export const COUNTERPARTY_FAMILIES = new Set(["CONTRACT", "M_AND_A", "PARTNERSHIP"]);

/** Announcement dates within `days` of each other (either may be missing → false). */
export function withinDays(a: Date | null | undefined, b: Date | null | undefined, days: number): boolean {
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) <= days * 86_400_000;
}

/** Days either side of an announcement within which a re-report is the same event. */
export const SAME_EVENT_WINDOW_DAYS = 14;
