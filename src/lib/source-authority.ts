export interface SourceAuthorityInput {
  sourceUrl?: string | null;
  sourceName?: string | null;
  sourceType?: string | null;
  sourceTitle?: string | null;
  publisherUrl?: string | null;
  rawText?: string | null;
}

export interface SourcePreferenceContext {
  referenceTitle?: string | null;
  providerName?: string | null;
  counterpartyNames?: readonly (string | null | undefined)[];
}

export type SourceAuthorityClass =
  | "provider_primary"
  | "official_public_record"
  | "curated_paid"
  | "press_wire"
  | "publisher"
  | "direct_web"
  | "google_aggregator"
  | "unknown";

const PROVIDER_PRIMARY_TYPES = new Set([
  "official_provider_website",
  "company_press_release",
  "vendor_press_release",
  "investor_relations_release",
  "annual_report",
  "quarterly_results",
  "earnings_release",
  "earnings_presentation",
  "earnings_transcript",
  "official_solution_page",
  "official_partner_page",
  "company_blog",
]);

const OFFICIAL_PUBLIC_TYPES = new Set([
  "procurement_notice",
  "regulatory_filing",
  "sec_filing",
  "government_notice",
]);

const PUBLISHER_TYPES = new Set([
  "news_article",
  "trade_publication",
  "analyst_summary",
  "archived_webpage",
]);

function hostname(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isSameOrSubdomain(host: string, domain: string): boolean {
  return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`)));
}

export function isProviderWebsiteUrl(
  sourceUrl: string | null | undefined,
  providerWebsiteUrl?: string | null,
): boolean {
  return isSameOrSubdomain(hostname(sourceUrl), hostname(providerWebsiteUrl));
}

export function isGoogleNewsSource(source: SourceAuthorityInput): boolean {
  const name = (source.sourceName ?? "").toLowerCase();
  return hostname(source.sourceUrl) === "news.google.com"
    || name.includes("google news")
    || name === "googlenews";
}

export function isProviderOwnedSource(
  source: SourceAuthorityInput,
  providerWebsiteUrl?: string | null,
): boolean {
  return !isGoogleNewsSource(source)
    && (PROVIDER_PRIMARY_TYPES.has((source.sourceType ?? "").toLowerCase())
      || isProviderWebsiteUrl(source.sourceUrl, providerWebsiteUrl));
}

export function sourceAuthorityClass(
  source: SourceAuthorityInput,
  providerWebsiteUrl?: string | null,
): SourceAuthorityClass {
  if (isGoogleNewsSource(source)) return "google_aggregator";

  const type = (source.sourceType ?? "").toLowerCase();
  const name = (source.sourceName ?? "").toLowerCase();
  const host = hostname(source.sourceUrl);

  if (isProviderOwnedSource(source, providerWebsiteUrl)) return "provider_primary";
  if (OFFICIAL_PUBLIC_TYPES.has(type)) return "official_public_record";
  if (/^(talentgenius|contrackgenius)(:|$)/i.test(source.sourceName ?? "")) return "curated_paid";
  if (type === "wire_service" || /business\s*wire|pr\s*newswire|globe\s*newswire/.test(name)
    || /businesswire\.com$|prnewswire\.com$|globenewswire\.com$/.test(host)) return "press_wire";
  if (PUBLISHER_TYPES.has(type)) return "publisher";
  if (host) return "direct_web";
  return "unknown";
}

// The 100,000-point separation is deliberate. Completeness can break ties
// inside a tier, but can never make Google News outrank a provider-owned page.
const AUTHORITY_TIER: Record<SourceAuthorityClass, number> = {
  official_public_record: 8,
  provider_primary: 7,
  curated_paid: 5,
  press_wire: 4,
  publisher: 3,
  direct_web: 2,
  google_aggregator: 1,
  unknown: 0,
};

export function sourceAuthorityTier(
  source: SourceAuthorityInput,
  providerWebsiteUrl?: string | null,
): number {
  return AUTHORITY_TIER[sourceAuthorityClass(source, providerWebsiteUrl)];
}

export function sourceAuthorityScore(
  source: SourceAuthorityInput,
  providerWebsiteUrl?: string | null,
): number {
  const tier = sourceAuthorityTier(source, providerWebsiteUrl);
  const textScore = Math.min(20_000, source.rawText?.length ?? 0);
  const titleScore = source.sourceTitle?.trim() ? 2_000 : 0;
  const urlScore = hostname(source.sourceUrl) ? 1_000 : 0;
  return tier * 100_000 + textScore + titleScore + urlScore;
}

export function isPublicHttpUrl(url: string | null | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return Boolean(parsed.hostname && !parsed.username && !parsed.password && !/\s/.test(parsed.hostname));
  } catch {
    return false;
  }
}

const GENERIC_EVENT_TOKENS = new Set([
  "artificial", "business", "client", "cloud", "company", "customer", "data", "digital",
  "enterprise", "global", "industry", "intelligence", "managed", "market", "operations",
  "platform", "provider", "service", "services", "solution", "support", "technology",
  "transformation", "update", "announce", "announced", "announces", "announcement",
  "agreement", "award", "awarded", "awards", "contract", "contracts", "deal", "deals",
  "earnings", "financial", "press", "release", "result", "results", "quarter", "quarterly",
  "selected", "wins", "with", "from", "their", "full", "year", "about", "launch",
  "launches", "offering", "partnership",
]);

function comparableUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/$/, "").toLowerCase();
  }
}

function identityTokens(value: string | null | undefined, providerName?: string | null): Set<string> {
  const providerTokens = new Set((providerName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean));
  return new Set((value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((token) => token.length >= 3 && !providerTokens.has(token) && !GENERIC_EVENT_TOKENS.has(token)));
}

const normalise = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function parties(context?: SourcePreferenceContext) {
  return (context?.counterpartyNames ?? []).filter((v): v is string =>
    !!v?.trim() && !/^(unknown|undisclosed|unnamed|not (?:named|specified|disclosed)|an? )\b/i.test(v));
}

export function mentionsParty(text: string, name: string): boolean {
  const haystack = " " + normalise(text) + " ";
  const full = normalise(name);
  const core = full.replace(/\b(?:limited|ltd|inc|plc|corporation|corp|gmbh|ag|llc)\b/g, " ").replace(/\s+/g, " ").trim();
  // Do not infer "UNITED" or "BANK" as an alias from all-caps legal names.
  const acronym = /[a-z]/.test(name) ? /^([A-Z]{3,8})\b/.exec(name)?.[1] : undefined;
  const alias = /\(([A-Z][A-Z0-9&.-]{1,9})\)/.exec(name)?.[1];
  const generic = new Set(["the","and","bank","united","federal","national","company","client","customer","group","government","ministry","department","authority"]);
  return [full, core, acronym, alias].some(v => v && v.length >= 2 && !generic.has(normalise(v)) && haystack.includes(" " + normalise(v) + " "));
}

export function sourceMatchesReference(
  source: SourceAuthorityInput,
  context?: SourcePreferenceContext,
): boolean {
  const referenceTitle = context?.referenceTitle?.trim();
  if (!referenceTitle) return true;

  const candidateText = [source.sourceTitle, (() => {
    try { return new URL(source.sourceUrl ?? "").pathname; } catch { return ""; }
  })()].filter(Boolean).join(" ");
  const named = parties(context);
  if (named.length) return named.some(name => mentionsParty(candidateText, name));
  const reference = identityTokens(referenceTitle, context?.providerName);
  const candidate = identityTokens(candidateText, context?.providerName);
  const shared = [...reference].filter((token) => candidate.has(token));

  // Two shared event-specific terms are strong evidence. One sufficiently
  // distinctive term (typically a client, target, product or reporting period)
  // is enough when provider and source authority are already known.
  return shared.length >= 2 || shared.some((token) => token.length >= 5 || /\d/.test(token));
}

// Opaque IDs and filings can support a real event without naming a client
// in their URL. Retain the original as a last resort, never upgrade to an
// uncorroborated alternative on domain authority alone.
function keepUnresolvedOriginal(source: SourceAuthorityInput | null, context?: SourcePreferenceContext) {
  if (!source) return null;
  if (!parties(context).length || sourceMatchesReference(source, context)) return source;
  const type = (source.sourceType ?? "").toLowerCase();
  if (OFFICIAL_PUBLIC_TYPES.has(type) || /^(annual_report|quarterly_results|earnings_release|earnings_presentation|earnings_transcript)$/.test(type)) return source;
  try {
    if (!source.sourceTitle && (isGoogleNewsSource(source) || /^(?:\d+[./-]?)+$/.test(new URL(source.sourceUrl!).pathname.split("/").filter(Boolean).pop() ?? ""))) return source;
  } catch { /* No usable public identity. */ }
  return null;
}

/** Selects the best browser-facing link without replacing a valid direct link
 * with a same-tier alternative or exposing internal dataset URI schemes. */
export function preferredPublicArticleSource<T extends SourceAuthorityInput>(
  sources: readonly T[],
  fallbackUrl?: string | null,
  providerWebsiteUrl?: string | null,
  context?: SourcePreferenceContext,
): SourceAuthorityInput | T | null {
  const publicSources: Array<SourceAuthorityInput | T> = sources.filter((source) => isPublicHttpUrl(source.sourceUrl));
  for (const source of sources) {
    if (isPublicHttpUrl(source.publisherUrl) && isProviderWebsiteUrl(source.publisherUrl, providerWebsiteUrl)) {
      if (parties(context).length && !sourceMatchesReference({ sourceUrl: source.publisherUrl }, context)) continue;
      publicSources.push({ ...source, sourceUrl: source.publisherUrl, sourceName: null, sourceType: "official_provider_website" });
    }
  }
  const normalizedFallback = comparableUrl(fallbackUrl);
  const fallback = isPublicHttpUrl(fallbackUrl)
    ? publicSources.find((source) => comparableUrl(source.sourceUrl) === normalizedFallback)
      ?? { sourceUrl: fallbackUrl, sourceName: "Canonical article link" }
    : null;

  return publicSources.reduce<SourceAuthorityInput | T | null>((best, candidate) => {
    if (!best) return sourceMatchesReference(candidate, context) ? candidate : null;
    if (sourceAuthorityTier(candidate, providerWebsiteUrl) <= sourceAuthorityTier(best, providerWebsiteUrl)) return best;
    return sourceMatchesReference(candidate, context) ? candidate : best;
  }, fallback && sourceMatchesReference(fallback, context) ? fallback : null)
    ?? keepUnresolvedOriginal(fallback, context);
}

export function preferredArticleSource<T extends SourceAuthorityInput>(
  sources: readonly T[],
  fallbackUrl?: string | null,
  providerWebsiteUrl?: string | null,
  context?: SourcePreferenceContext,
): SourceAuthorityInput | T | null {
  const candidates: Array<SourceAuthorityInput | T> = [...sources];
  const normalizedFallback = comparableUrl(fallbackUrl);
  const fallback = fallbackUrl
    ? candidates.find((source) => comparableUrl(source.sourceUrl) === normalizedFallback)
      ?? { sourceUrl: fallbackUrl, sourceName: "Canonical article link" }
    : null;
  return candidates.reduce<SourceAuthorityInput | T | null>((best, candidate) => {
    if (!best) return sourceMatchesReference(candidate, context) ? candidate : null;
    if (sourceAuthorityScore(candidate, providerWebsiteUrl) <= sourceAuthorityScore(best, providerWebsiteUrl)) return best;
    return sourceMatchesReference(candidate, context) ? candidate : best;
  }, fallback && sourceMatchesReference(fallback, context) ? fallback : null)
    ?? keepUnresolvedOriginal(fallback, context);
}
