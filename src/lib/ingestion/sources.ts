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

// ── Tier-1: Direct vendor newsroom / press RSS ──────────────────────────────
export const VENDOR_RSS_SOURCES: SourceDefinition[] = [
  { id: "capgemini-feed-rss",    name: "Capgemini News Feed",     provider: "Capgemini",      url: "https://www.capgemini.com/feed/",                          sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "nttdata-news-rss",      name: "NTT DATA News",           provider: "NTT DATA",       url: "https://www.nttdata.com/global/en/rss/news",               sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "atos-feed-rss",         name: "Atos News Feed",          provider: "Atos",           url: "https://atos.net/en/feed",                                 sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "soprasteria-feed-rss",  name: "Sopra Steria Feed",       provider: "Sopra Steria",   url: "https://www.soprasteria.com/feed",                         sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "concentrix-news-rss",   name: "Concentrix Newsroom",     provider: "Concentrix",     url: "https://www.concentrix.com/newsroom/feed/",                sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "infosys-press-rss",     name: "Infosys Press Releases",  provider: "Infosys",        url: "https://www.infosys.com/newsroom/rss-feeds/press-releases-background.xml", sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "wipro-press-rss",       name: "Wipro Press Releases",    provider: "Wipro",          url: "https://www.wipro.com/content/nexus/en/newsroom/press-releases/rss.xml", sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "cognizant-press-rss",   name: "Cognizant Press Releases", provider: "Cognizant",     url: "https://news.cognizant.com/rss",                           sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "hcl-press-rss",         name: "HCLTech News",            provider: "HCLTech",        url: "https://www.hcltech.com/rss/news",                         sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "dxc-press-rss",         name: "DXC Technology News",     provider: "DXC Technology", url: "https://dxc.com/us/en/newsroom/rss.xml",                   sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "accenture-press-rss",   name: "Accenture Newsroom",      provider: "Accenture",      url: "https://newsroom.accenture.com/rss/news-releases.xml",     sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "ibm-press-rss",         name: "IBM Newsroom",            provider: "IBM",            url: "https://newsroom.ibm.com/rss-feeds?term_node_tid_depth=All&feed_id=1", sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 6 },
  { id: "kyndryl-press-rss",     name: "Kyndryl Newsroom",        provider: "Kyndryl",        url: "https://www.kyndryl.com/us/en/about-us/news/rss.xml",      sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "cgi-press-rss",         name: "CGI News",                provider: "CGI",            url: "https://www.cgi.com/en/rss/news",                          sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "fujitsu-press-rss",     name: "Fujitsu News",            provider: "Fujitsu",        url: "https://www.fujitsu.com/global/about/resources/news/rss/",  sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "ltimindtree-press-rss", name: "LTIMindtree Newsroom",    provider: "LTIMindtree",    url: "https://www.ltimindtree.com/newsroom/feed/",               sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "genpact-press-rss",     name: "Genpact Newsroom",        provider: "Genpact",        url: "https://www.genpact.com/rss/pressreleases",                sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "techmahindra-press-rss", name: "Tech Mahindra News",     provider: "Tech Mahindra",  url: "https://www.techmahindra.com/en-in/rss/press-releases/",   sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 8 },
  { id: "coforge-press-rss",     name: "Coforge Newsroom",        provider: "Coforge",        url: "https://www.coforge.com/rss/news",                         sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
  { id: "unisys-press-rss",      name: "Unisys Press Releases",   provider: "Unisys",         url: "https://www.unisys.com/siteassets/rss/press-releases.xml",  sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 },
];

// ── Tier-1: Investor Relations RSS ──────────────────────────────────────────
function irSource(id: string, name: string, provider: string, url: string): SourceDefinition {
  return { id, name, provider, url, sourceType: "investor_relations_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 };
}

export const INVESTOR_RELATIONS_SOURCES: SourceDefinition[] = [
  irSource("accenture-ir-rss",   "Accenture Investor Relations",  "Accenture",      "https://newsroom.accenture.com/rss/investor-news.xml"),
  irSource("infosys-ir-rss",     "Infosys Investor News",         "Infosys",        "https://www.infosys.com/newsroom/rss-feeds/investors-corner.xml"),
  irSource("wipro-ir-rss",       "Wipro Investor Relations",      "Wipro",          "https://www.wipro.com/content/nexus/en/investors/rss.xml"),
  irSource("cognizant-ir-rss",   "Cognizant Investor Relations",  "Cognizant",      "https://news.cognizant.com/rss?tags=investor-relations"),
  irSource("ibm-ir-rss",         "IBM Investor Relations",        "IBM",            "https://newsroom.ibm.com/rss-feeds?term_node_tid_depth=1261&feed_id=1"),
  irSource("dxc-ir-rss",         "DXC Investor Relations",        "DXC Technology", "https://dxc.com/us/en/investor-relations/rss.xml"),
  irSource("capgemini-ir-rss",   "Capgemini Investor Relations",  "Capgemini",      "https://www.capgemini.com/investors/feed/"),
  irSource("nttdata-ir-rss",     "NTT DATA Investor Relations",   "NTT DATA",       "https://www.nttdata.com/global/en/rss/investor-relations"),
  irSource("kyndryl-ir-rss",     "Kyndryl Investor Relations",    "Kyndryl",        "https://investors.kyndryl.com/rss/news-releases.xml"),
  irSource("cgi-ir-rss",         "CGI Investor Relations",        "CGI",            "https://www.cgi.com/en/rss/investor-relations"),
  irSource("fujitsu-ir-rss",     "Fujitsu Investor Relations",    "Fujitsu",        "https://www.fujitsu.com/global/about/ir/rss/"),
  irSource("genpact-ir-rss",     "Genpact Investor Relations",    "Genpact",        "https://investor.genpact.com/rss/news-releases.xml"),
  irSource("hcl-ir-rss",         "HCLTech Investor Relations",    "HCLTech",        "https://www.hcltech.com/rss/investors"),
  irSource("ltimindtree-ir-rss", "LTIMindtree Investor News",     "LTIMindtree",    "https://www.ltimindtree.com/investors/feed/"),
  irSource("techmahindra-ir-rss","Tech Mahindra Investor News",   "Tech Mahindra",  "https://www.techmahindra.com/en-in/rss/investors/"),
  irSource("unisys-ir-rss",      "Unisys Investor Relations",     "Unisys",         "https://investor.unisys.com/rss/news-releases.xml"),
  irSource("concentrix-ir-rss",  "Concentrix Investor Relations", "Concentrix",     "https://investor.concentrix.com/rss/news-releases.xml"),
  irSource("coforge-ir-rss",     "Coforge Investor Relations",    "Coforge",        "https://www.coforge.com/rss/investors"),
];

// ── Tier-1: Wire services ───────────────────────────────────────────────────
export const WIRE_SOURCES: SourceDefinition[] = [
  { id: "businesswire-it-rss",   name: "BusinessWire Technology",   provider: "Market Wide", url: "https://feed.businesswire.com/rss/home/?rss=G1",                        sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
  { id: "prnewswire-it-rss",     name: "PR Newswire IT Services",   provider: "Market Wide", url: "https://www.prnewswire.com/rss/information-technology-latest-news.rss",  sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
  { id: "globenewswire-it-rss",  name: "GlobeNewsWire Technology",  provider: "Market Wide", url: "https://www.globenewswire.com/RssFeed/subjectcode/14-Information%20Technology/feedTitle/GlobeNewswire%20-%20Information%20Technology", sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
];

// ── Tier-2: Google News keyword RSS (aggregator) ────────────────────────────
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
  gnews("Accenture",         IT_SIGNAL_TERMS),
  gnews("IBM",               IT_SIGNAL_TERMS),
  gnews("Infosys",           IT_SIGNAL_TERMS),
  gnews("TCS",               `"Tata Consultancy" ${IT_SIGNAL_TERMS}`),
  gnews("Wipro",             IT_SIGNAL_TERMS),
  gnews("Cognizant",         IT_SIGNAL_TERMS),
  gnews("HCL Technologies",  IT_SIGNAL_TERMS),
  gnews("DXC Technology",    IT_SIGNAL_TERMS),
  gnews("Capgemini",         IT_SIGNAL_TERMS),
  gnews("Kyndryl",           IT_SIGNAL_TERMS),
  gnews("CGI Group",         `"CGI Inc" ${IT_SIGNAL_TERMS}`),
  gnews("Fujitsu",           IT_SIGNAL_TERMS),
  gnews("LTIMindtree",       IT_SIGNAL_TERMS),
  gnews("Genpact",           IT_SIGNAL_TERMS),
  gnews("Tech Mahindra",     IT_SIGNAL_TERMS),
  gnews("Coforge",           IT_SIGNAL_TERMS),
  gnews("Unisys",            IT_SIGNAL_TERMS),
  gnews("NTT DATA",          IT_SIGNAL_TERMS),
  gnews("Atos",              IT_SIGNAL_TERMS),
  gnews("Sopra Steria",      IT_SIGNAL_TERMS),
  gnews("Concentrix",        IT_SIGNAL_TERMS),
  gnews("Deloitte",          `"Deloitte" IT services ${IT_SIGNAL_TERMS}`),
  gnews("EY",                `"Ernst & Young" OR "EY" IT services ${IT_SIGNAL_TERMS}`),
  gnews("KPMG",              `"KPMG" IT services ${IT_SIGNAL_TERMS}`),
  gnews("PwC",               `"PricewaterhouseCoopers" OR "PwC" IT services ${IT_SIGNAL_TERMS}`),
];

// ── Tier-1: Government procurement API sources ──────────────────────────────
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

export const ALL_SOURCES: SourceDefinition[] = [
  ...VENDOR_RSS_SOURCES,
  ...INVESTOR_RELATIONS_SOURCES,
  ...WIRE_SOURCES,
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

// For direct vendor newsroom / IR RSS — require a strong commercial signal
const VENDOR_REQUIRE    = /\b(contract|award|outsourc|managed service|win\b|deal|selected by|engages?|acqui|partner(?:ship|s)?|merger|divest|joint venture|appoints?|restructur|delivery centre|opens?|launch|platform)\b/i;

export function isRelevantArticle(title: string, sourceType?: string): { relevant: boolean; family: string } {
  const t = title;
  if (HARD_EXCLUDE.test(t)) return { relevant: false, family: "EXCLUDED" };
  if (MA_TERMS.test(t))       return { relevant: true, family: "M_AND_A" };
  if (CONTRACT_TERMS.test(t)) return { relevant: true, family: "CONTRACT" };
  if (PARTNER_TERMS.test(t))  return { relevant: true, family: "PARTNERSHIP" };
  if (OFFERING_TERMS.test(t)) return { relevant: true, family: "NEW_OFFERING" };
  if (ORG_TERMS.test(t))      return { relevant: true, family: "ORG_CHANGE" };

  // For vendor RSS / IR (direct newsroom), require an explicit commercial signal
  if (sourceType === "vendor_press_release" || sourceType === "investor_relations_release") {
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
