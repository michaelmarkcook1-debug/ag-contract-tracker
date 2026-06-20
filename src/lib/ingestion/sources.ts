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

// ══════════════════════════════════════════════════════════════════════════════
// TRACKED VENDORS — 63 IT services providers
// ══════════════════════════════════════════════════════════════════════════════
export const TRACKED_VENDORS = [
  "Accenture", "ADP", "Alorica", "Amdocs", "Atento", "Atos",
  "Birlasoft", "Broadridge",
  "Capita", "Capgemini", "CGI", "Coforge", "Cognizant", "Concentrix", "Conduent", "CSS Corp",
  "Datamatics", "Deloitte", "Dell Technologies", "DXC Technology",
  "EPAM", "EXL", "EY",
  "Firstsource", "Foundever", "Fujitsu",
  "Genpact",
  "HCLTech", "Hexaware", "Hitachi Digital Services",
  "IBM", "Infosys",
  "KPMG", "Kyndryl",
  "L&T Technology Services", "LTIMindtree",
  "Majorel", "Mastek", "Mphasis",
  "Nagarro", "NEC", "NICE", "NTT DATA",
  "Orange Business",
  "Persistent", "PwC",
  "Searce", "Singtel", "Sopra Steria", "Stefanini", "Sutherland", "Synechron",
  "TCS", "Tech Mahindra", "Teleperformance", "TELUS International", "Tietoevry", "TTEC",
  "Unisys", "UST",
  "Virtusa",
  "Wipro", "WNS",
] as const;

// ── Tier-1: Direct vendor newsroom / press RSS ──────────────────────────────
// Only vendors with known working RSS feeds
function pressSource(id: string, name: string, provider: string, url: string, hours = 8): SourceDefinition {
  return { id, name, provider, url, sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: hours };
}

// NOTE: Direct vendor newsroom RSS is fragile — many vendors rotate or remove
// these URLs without notice. Only feeds verified reachable (2026-06) are kept
// here; the rest were returning HTTP 404/403 and added nothing because every
// tracked vendor is already covered by a dedicated Google News feed below.
// Removed (dead as of 2026-06): Accenture, CGI, Coforge, DXC, EPAM, Genpact,
// HCLTech, IBM, Infosys, Kyndryl, Nagarro, Persistent, Tech Mahindra, Unisys,
// Wipro. Re-add with a corrected URL once verified via a dry run.
export const VENDOR_RSS_SOURCES: SourceDefinition[] = [
  pressSource("atos-feed-rss",          "Atos News Feed",             "Atos",                "https://atos.net/en/feed"),
  pressSource("capgemini-feed-rss",     "Capgemini News Feed",        "Capgemini",           "https://www.capgemini.com/feed/", 6),
  pressSource("cognizant-press-rss",    "Cognizant Press Releases",   "Cognizant",           "https://news.cognizant.com/rss", 6),
  pressSource("concentrix-news-rss",    "Concentrix Newsroom",        "Concentrix",          "https://www.concentrix.com/newsroom/feed/", 12),
  pressSource("fujitsu-press-rss",      "Fujitsu News",               "Fujitsu",             "https://www.fujitsu.com/global/about/resources/news/rss/"),
  pressSource("ltimindtree-press-rss",  "LTIMindtree Newsroom",       "LTIMindtree",         "https://www.ltimindtree.com/newsroom/feed/", 12),
  pressSource("nttdata-news-rss",       "NTT DATA News",              "NTT DATA",            "https://www.nttdata.com/global/en/rss/news", 6),
  pressSource("soprasteria-feed-rss",   "Sopra Steria Feed",          "Sopra Steria",        "https://www.soprasteria.com/feed", 12),
  pressSource("tietoevry-press-rss",    "Tietoevry Newsroom",         "Tietoevry",           "https://www.tietoevry.com/en/newsroom/rss/"),
];

// ── Tier-1: Investor Relations RSS ──────────────────────────────────────────
function irSource(id: string, name: string, provider: string, url: string): SourceDefinition {
  return { id, name, provider, url, sourceType: "investor_relations_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 };
}

export const INVESTOR_RELATIONS_SOURCES: SourceDefinition[] = [
  irSource("accenture-ir-rss",    "Accenture Investor Relations",  "Accenture",       "https://newsroom.accenture.com/rss/investor-news.xml"),
  irSource("capgemini-ir-rss",    "Capgemini Investor Relations",  "Capgemini",       "https://www.capgemini.com/investors/feed/"),
  irSource("cognizant-ir-rss",    "Cognizant Investor Relations",  "Cognizant",       "https://news.cognizant.com/rss?tags=investor-relations"),
  irSource("concentrix-ir-rss",   "Concentrix Investor Relations", "Concentrix",      "https://investor.concentrix.com/rss/news-releases.xml"),
  irSource("dxc-ir-rss",          "DXC Investor Relations",        "DXC Technology",  "https://dxc.com/us/en/investor-relations/rss.xml"),
  irSource("epam-ir-rss",         "EPAM Investor Relations",       "EPAM",            "https://investors.epam.com/rss/news-releases.xml"),
  irSource("fujitsu-ir-rss",      "Fujitsu Investor Relations",    "Fujitsu",         "https://www.fujitsu.com/global/about/ir/rss/"),
  irSource("genpact-ir-rss",      "Genpact Investor Relations",    "Genpact",         "https://investor.genpact.com/rss/news-releases.xml"),
  irSource("hcl-ir-rss",          "HCLTech Investor Relations",    "HCLTech",         "https://www.hcltech.com/rss/investors"),
  irSource("ibm-ir-rss",          "IBM Investor Relations",        "IBM",             "https://newsroom.ibm.com/rss-feeds?term_node_tid_depth=1261&feed_id=1"),
  irSource("infosys-ir-rss",      "Infosys Investor News",         "Infosys",         "https://www.infosys.com/newsroom/rss-feeds/investors-corner.xml"),
  irSource("kyndryl-ir-rss",      "Kyndryl Investor Relations",    "Kyndryl",         "https://investors.kyndryl.com/rss/news-releases.xml"),
  irSource("ltimindtree-ir-rss",  "LTIMindtree Investor News",     "LTIMindtree",     "https://www.ltimindtree.com/investors/feed/"),
  irSource("nttdata-ir-rss",      "NTT DATA Investor Relations",   "NTT DATA",        "https://www.nttdata.com/global/en/rss/investor-relations"),
  irSource("techmahindra-ir-rss", "Tech Mahindra Investor News",   "Tech Mahindra",   "https://www.techmahindra.com/en-in/rss/investors/"),
  irSource("unisys-ir-rss",       "Unisys Investor Relations",     "Unisys",          "https://investor.unisys.com/rss/news-releases.xml"),
  irSource("wipro-ir-rss",        "Wipro Investor Relations",      "Wipro",           "https://www.wipro.com/content/nexus/en/investors/rss.xml"),
  irSource("coforge-ir-rss",      "Coforge Investor Relations",    "Coforge",         "https://www.coforge.com/rss/investors"),
  irSource("exl-ir-rss",          "EXL Investor Relations",        "EXL",             "https://ir.exlservice.com/rss/news-releases.xml"),
  irSource("virtusa-ir-rss",      "Virtusa Investor Relations",    "Virtusa",         "https://ir.virtusa.com/rss/news-releases.xml"),
  irSource("wns-ir-rss",          "WNS Investor Relations",        "WNS",             "https://ir.wns.com/rss/news-releases.xml"),
  irSource("mphasis-ir-rss",      "Mphasis Investor Relations",    "Mphasis",         "https://www.mphasis.com/investors/feed/"),
];

// ── Tier-1: Wire services ───────────────────────────────────────────────────
export const WIRE_SOURCES: SourceDefinition[] = [
  { id: "businesswire-it-rss",   name: "BusinessWire Technology",   provider: "Market Wide", url: "https://feed.businesswire.com/rss/home/?rss=G1",                        sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
  { id: "prnewswire-it-rss",     name: "PR Newswire IT Services",   provider: "Market Wide", url: "https://www.prnewswire.com/rss/information-technology-latest-news.rss",  sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
  { id: "globenewswire-it-rss",  name: "GlobeNewsWire Technology",  provider: "Market Wide", url: "https://www.globenewswire.com/RssFeed/subjectcode/14-Information%20Technology/feedTitle/GlobeNewswire%20-%20Information%20Technology", sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 },
];

// ── Tier-2: Google News keyword RSS (aggregator) ────────────────────────────
// One feed per tracked vendor — catches articles from any news source
function gnews(vendor: string, terms: string): SourceDefinition {
  const q = encodeURIComponent(`"${vendor}" (${terms})`);
  return {
    id: `gnews-${vendor.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
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

export const GOOGLE_NEWS_SOURCES: SourceDefinition[] = TRACKED_VENDORS.map(vendor => {
  // Some vendors need search term adjustments for disambiguation
  switch (vendor) {
    case "TCS":
      return gnews("TCS", `"Tata Consultancy" ${IT_SIGNAL_TERMS}`);
    case "CGI":
      return gnews("CGI", `"CGI Inc" OR "CGI Group" ${IT_SIGNAL_TERMS}`);
    case "EY":
      return gnews("EY", `"Ernst & Young" OR "EY" IT services ${IT_SIGNAL_TERMS}`);
    case "PwC":
      return gnews("PwC", `"PricewaterhouseCoopers" OR "PwC" IT services ${IT_SIGNAL_TERMS}`);
    case "KPMG":
      return gnews("KPMG", `"KPMG" IT services ${IT_SIGNAL_TERMS}`);
    case "Deloitte":
      return gnews("Deloitte", `"Deloitte" IT services ${IT_SIGNAL_TERMS}`);
    case "NICE":
      return gnews("NICE", `"NICE Systems" OR "NICE Ltd" ${IT_SIGNAL_TERMS}`);
    case "NEC":
      return gnews("NEC", `"NEC Corporation" ${IT_SIGNAL_TERMS}`);
    case "UST":
      return gnews("UST", `"UST Global" OR "UST" IT services ${IT_SIGNAL_TERMS}`);
    case "ADP":
      return gnews("ADP", `"ADP" "Automatic Data Processing" ${IT_SIGNAL_TERMS}`);
    case "Dell Technologies":
      return gnews("Dell Technologies", `"Dell Technologies" IT services ${IT_SIGNAL_TERMS}`);
    case "L&T Technology Services":
      return gnews("L&T Technology Services", `"LTTS" OR "L&T Technology" ${IT_SIGNAL_TERMS}`);
    case "Orange Business":
      return gnews("Orange Business", `"Orange Business" OR "Orange Business Services" ${IT_SIGNAL_TERMS}`);
    case "Singtel":
      return gnews("Singtel", `"Singtel" OR "NCS" IT services ${IT_SIGNAL_TERMS}`);
    default:
      return gnews(vendor, IT_SIGNAL_TERMS);
  }
});

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

// Order matters: the pipeline crawls in this sequence and may be cut short by
// the serverless time budget. Put the highest-yield, most-reliable sources
// FIRST (Google News covers every tracked vendor and rarely fails), so a short
// run still returns real data. The fragile direct vendor/IR feeds go last.
export const ALL_SOURCES: SourceDefinition[] = [
  ...GOOGLE_NEWS_SOURCES,
  ...WIRE_SOURCES,
  ...PROCUREMENT_SOURCES,
  ...VENDOR_RSS_SOURCES,
  ...INVESTOR_RELATIONS_SOURCES,
];

// ── Relevance filter ────────────────────────────────────────────────────────
const CONTRACT_TERMS    = /\b(contract|award|select|chosen|signed?|outsourc|managed service|win\b|deal|engagement|framework award|task order|procurement)\b/i;
const MA_TERMS          = /\b(acqui|merger|divest|stake acquisition|joint venture|\bJV\b|buyout|takeover)\b/i;
const PARTNER_TERMS     = /\b(strategic alliance|technology partnership|co-deliver|collaboration agreement|ecosystem partner)\b/i;
const OFFERING_TERMS    = /\b(launch|unveil|introduc|new platform|new service|new offering|new capability|practice area|delivery cent)\b/i;
const ORG_TERMS         = /\b(appoints?|hires?|joins? as|names? .*(?:CEO|CTO|CFO|COO|President|EVP)|restructur|headcount reduction|spin[- ]off)\b/i;

const HARD_EXCLUDE      = /\b(earnings?|revenue|quarter|annual report|full[- ]year|guidance|dividend|share price|\bstock\b|EPS|analyst (?:upgrade|rate|target)|market research|magic quadrant|peer review|gartner|forrester|isg provider|everest group|leadership development|women in|csr|sustainab|carbon|climate|award for excellence|recognised as|named .*leader by|ranked .*in|survey finds?|study shows?|webinar|podcast|blog post|opinion|thought leadership|self[- ]service)\b/i;

const VENDOR_REQUIRE    = /\b(contract|award|outsourc|managed service|win\b|deal|selected by|engages?|acqui|partner(?:ship|s)?|merger|divest|joint venture|appoints?|restructur|delivery centre|opens?|launch|platform)\b/i;

export function isRelevantArticle(title: string, sourceType?: string): { relevant: boolean; family: string } {
  const t = title;
  if (HARD_EXCLUDE.test(t)) return { relevant: false, family: "EXCLUDED" };
  if (MA_TERMS.test(t))       return { relevant: true, family: "M_AND_A" };
  if (CONTRACT_TERMS.test(t)) return { relevant: true, family: "CONTRACT" };
  if (PARTNER_TERMS.test(t))  return { relevant: true, family: "PARTNERSHIP" };
  if (OFFERING_TERMS.test(t)) return { relevant: true, family: "NEW_OFFERING" };
  if (ORG_TERMS.test(t))      return { relevant: true, family: "ORG_CHANGE" };

  if (sourceType === "vendor_press_release" || sourceType === "investor_relations_release") {
    return VENDOR_REQUIRE.test(t)
      ? { relevant: true, family: "CONTRACT" }
      : { relevant: false, family: "EXCLUDED" };
  }

  if (sourceType === "procurement_notice" || sourceType === "wire_service") {
    return { relevant: true, family: "CONTRACT" };
  }

  return { relevant: false, family: "UNCLASSIFIED" };
}
