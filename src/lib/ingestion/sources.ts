export type SourceTier = "tier_1_primary" | "tier_2_secondary";
export type FetchMethod = "rss" | "api" | "html";
export type SourceType =
  | "vendor_press_release"
  | "procurement_notice"
  | "wire_service"
  | "investor_relations_release"
  | "regulatory_filing";

export interface SourceDefinition {
  id: string;
  name: string;
  provider: string;
  url: string;
  sourceType: SourceType;
  tier: SourceTier;
  fetchMethod: FetchMethod;
  refreshHours: number;
}

// ── Tier-1: Direct vendor newsroom RSS (verified working 2026-06-01) ──────────
export const VENDOR_RSS_SOURCES: SourceDefinition[] = [
  // Direct newsroom feeds — verified returning items
  { id: "capgemini-feed-rss",    name: "Capgemini News Feed",   provider: "Capgemini",  url: "https://www.capgemini.com/feed/",                sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "nttdata-news-rss",      name: "NTT Data News",         provider: "NTT Data",   url: "https://www.nttdata.com/global/en/rss/news",     sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "atos-feed-rss",         name: "Atos News Feed",        provider: "Atos",       url: "https://atos.net/en/feed",                       sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "soprasteria-feed-rss",  name: "Sopra Steria Feed",     provider: "Sopra Steria", url: "https://www.soprasteria.com/feed",             sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "concentrix-news-rss",   name: "Concentrix Newsroom",   provider: "Concentrix", url: "https://www.concentrix.com/newsroom/feed/",      sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  // BusinessWire IT services vertical
  { id: "businesswire-it-rss",   name: "BusinessWire Technology", provider: "Market Wide", url: "https://feed.businesswire.com/rss/home/?rss=G1", sourceType: "wire_service",        tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
];

// ── Tier-2: Google News keyword RSS (always live, aggregator) ─────────────────
// Format: targeted vendor + intent keywords so we surface contract/M&A signals
function gnews(vendor: string, terms: string): SourceDefinition {
  const q = encodeURIComponent(`"${vendor}" (${terms})`);
  return {
    id: `gnews-${vendor.toLowerCase().replace(/\s+/g, "-")}`,
    name: `${vendor} — Google News signals`,
    provider: vendor,
    url: `https://news.google.com/rss/search?q=${q}&hl=en&gl=US&ceid=US:en`,
    sourceType: "wire_service",
    tier: "tier_2_secondary",
    fetchMethod: "rss",
    refreshHours: 6,
  };
}

const IT_SIGNAL_TERMS = "contract OR award OR outsourcing OR partnership OR acquisition OR divest";

export const GOOGLE_NEWS_SOURCES: SourceDefinition[] = [
  gnews("Accenture",        IT_SIGNAL_TERMS),
  gnews("IBM",              IT_SIGNAL_TERMS),
  gnews("Infosys",          IT_SIGNAL_TERMS),
  gnews("TCS",              `"Tata Consultancy" ${IT_SIGNAL_TERMS}`),
  gnews("Wipro",            IT_SIGNAL_TERMS),
  gnews("Cognizant",        IT_SIGNAL_TERMS),
  gnews("HCL Technologies", IT_SIGNAL_TERMS),
  gnews("DXC Technology",   IT_SIGNAL_TERMS),
  gnews("Capgemini",        IT_SIGNAL_TERMS),
  gnews("Kyndryl",          IT_SIGNAL_TERMS),
  gnews("CGI Group",        `"CGI Inc" ${IT_SIGNAL_TERMS}`),
  gnews("Fujitsu",          IT_SIGNAL_TERMS),
  gnews("LTIMindtree",      IT_SIGNAL_TERMS),
  gnews("Genpact",          IT_SIGNAL_TERMS),
];

// ── Tier-1: Government procurement API sources ────────────────────────────────
export const PROCUREMENT_SOURCES: SourceDefinition[] = [
  {
    id: "uk-contracts-finder-api",
    name: "UK Contracts Finder",
    provider: "Market Wide",
    url: "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search",
    sourceType: "procurement_notice",
    tier: "tier_1_primary",
    fetchMethod: "api",
    refreshHours: 12,
  },
  {
    id: "sam-gov-api",
    name: "SAM.gov Opportunities",
    provider: "Market Wide",
    url: "https://api.sam.gov/opportunities/v2/search",
    sourceType: "procurement_notice",
    tier: "tier_1_primary",
    fetchMethod: "api",
    refreshHours: 12,
  },
];

// ── Wire sources (kept for completeness but most are down) ────────────────────
export const WIRE_SOURCES: SourceDefinition[] = [];

export const ALL_SOURCES: SourceDefinition[] = [
  ...VENDOR_RSS_SOURCES,
  ...GOOGLE_NEWS_SOURCES,
  ...PROCUREMENT_SOURCES,
];

// Relevance: does this article title mention IT services market activity?
const CONTRACT_TERMS    = /\b(contract|award|select|chosen|signed?|outsourc|managed service|win\b|deal|engagement|framework award|task order|procurement)\b/i;
const MA_TERMS          = /\b(acqui|merger|divest|stake acquisition|joint venture|\bJV\b|buyout|takeover)\b/i;
const PARTNER_TERMS     = /\b(strategic alliance|technology partnership|co-deliver|collaboration agreement|ecosystem partner)\b/i;
const OFFERING_TERMS    = /\b(launch|unveil|introduc|new platform|new service|new offering|new capability|practice area|delivery cent)\b/i;
const ORG_TERMS         = /\b(appoints?|hires?|joins? as|names? .*(?:CEO|CTO|CFO|COO|President|EVP)|restructur|headcount reduction|spin[- ]off)\b/i;

// Hard exclusions — anything matching this is noise regardless of source
const HARD_EXCLUDE      = /\b(earnings?|revenue|quarter|annual report|full[- ]year|guidance|dividend|share price|\bstock\b|EPS|analyst (?:upgrade|rate|target)|market research|magic quadrant|peer review|gartner|forrester|isg provider|everest group|leadership development|women in|csr|sustainab|carbon|climate|award for excellence|recognised as|named .*leader by|ranked .*in|survey finds?|study shows?|webinar|podcast|blog post|opinion|thought leadership|self[- ]service)\b/i;

// For direct vendor newsroom RSS — require a strong commercial signal; thought-leadership misses
// "selected by" not "selected as" (awards/rankings); "engagement" only with contract context
const VENDOR_REQUIRE    = /\b(contract|award|outsourc|managed service|win\b|deal|selected by|engages?|acqui|partner(?:ship|s)?|merger|divest|joint venture|appoints?|restructur|delivery centre|opens?|launch|platform)\b/i;

export function isRelevantArticle(title: string, sourceType?: string): { relevant: boolean; family: string } {
  const t = title;
  if (HARD_EXCLUDE.test(t)) return { relevant: false, family: "EXCLUDED" };
  if (MA_TERMS.test(t))       return { relevant: true, family: "M_AND_A" };
  if (CONTRACT_TERMS.test(t)) return { relevant: true, family: "CONTRACT" };
  if (PARTNER_TERMS.test(t))  return { relevant: true, family: "PARTNERSHIP" };
  if (OFFERING_TERMS.test(t)) return { relevant: true, family: "NEW_OFFERING" };
  if (ORG_TERMS.test(t))      return { relevant: true, family: "ORG_CHANGE" };

  // For vendor RSS (direct newsroom), require an explicit commercial signal — don't pass through everything
  if (sourceType === "vendor_press_release") {
    return VENDOR_REQUIRE.test(t)
      ? { relevant: true, family: "CONTRACT" }
      : { relevant: false, family: "EXCLUDED" };
  }

  // Wire / procurement / Google News — already keyword-targeted, pass through
  if (sourceType === "procurement_notice" || sourceType === "wire_service") {
    return { relevant: true, family: "CONTRACT" };
  }

  return { relevant: false, family: "UNCLASSIFIED" };
}
