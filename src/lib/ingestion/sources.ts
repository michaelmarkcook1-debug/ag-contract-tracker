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
// TRACKED VENDORS — the coverage universe (63 IT services providers)
//
// THIS IS THE SINGLE PLACE TO EXPAND COVERAGE. Adding a name here automatically:
//   1. creates a dedicated Google News feed for it (GOOGLE_NEWS_SOURCES below),
//   2. admits its articles through the market-wide ingestion gate
//      (mentionsTrackedVendor), and
//   3. adds it to the vendor universe sent to the LLM in classifier.ts.
// No other file needs editing.
//
// Two optional follow-ups when adding a vendor:
//   - If headlines commonly use a different form (e.g. "Tata Consultancy" for
//     TCS), add it to VENDOR_ALIASES further down so the gate still matches.
//   - If the name is ambiguous or very short, check GOOGLE_NEWS_SOURCES below
//     for a disambiguating search-term override.
// Vendors also need an Entity row to link events to a profile page; run
// `npm run backfill:vendors` after expanding this list.
// ══════════════════════════════════════════════════════════════════════════════
// DELIBERATELY EXCLUDED — US federal IT primes (SAIC, Leidos, Booz Allen, CACI,
// GDIT, Peraton). These are covered by the separate FedSpend product. They
// appear heavily in the legacy imported data and are screened out here.
export const TRACKED_VENDORS = [
  "Accenture", "ADP", "Alight", "Alorica", "Amdocs", "Arvato", "Atento", "Atos", "AWS",
  "Birlasoft", "Broadridge",
  "Capgemini", "Capita", "CGI", "Coforge", "Cognizant", "Computacenter", "Concentrix", "Conduent", "CSS Corp",
  "Datamatics", "Deloitte", "Dell Technologies", "DXC Technology",
  "Endava", "EPAM", "EXL", "EY",
  "Firstsource", "Foundever", "Fujitsu",
  "Genpact", "Globant", "Google Cloud",
  "HCLTech", "Hexaware", "HGS", "Hitachi Digital Services",
  "IBM", "Infosys", "iQor",
  "KPMG", "Kyndryl",
  "L&T Technology Services", "LTIMindtree",
  "Majorel", "Mastek", "Maximus", "Microsoft", "Mphasis",
  "Nagarro", "NEC", "Netcompany", "NICE", "NTT DATA",
  "Oracle", "Orange Business",
  "Persistent", "PwC",
  "SAP", "Searce", "Serco", "Singtel", "Softtek", "Sopra Steria", "Startek", "Stefanini", "Sutherland", "Synechron",
  "TaskUs", "TCS", "Tech Mahindra", "Teleperformance", "TELUS International", "Thoughtworks", "Tietoevry", "Transcom", "T-Systems", "TTEC",
  "Unisys", "UST",
  "Virtusa",
  "Wipro", "WNS",
  // ── BPO / CX specialists ──
  "eClerx", "IGT Solutions", "[24]7.ai", "Everise", "VXI Global", "ResultsCX",
  // ── ITO / infrastructure & managed services ──
  "Insight Enterprises", "Rackspace", "Ensono", "SoftwareOne", "Bechtle", "Cancom",
  "Inetum", "Indra", "Reply", "Devoteam", "Kainos", "Version 1", "Claranet",
  "Crayon", "Advania", "NNIT", "Getronics", "Telefonica Tech",
  // ── Engineering / R&D services ──
  "Cyient", "KPIT", "Tata Elxsi", "Quest Global", "ALTEN", "Expleo", "Akkodis",
  // ── India mid-tier IT ──
  "Happiest Minds", "Sonata Software",
  "Zensar",
] as const;

/**
 * Vendors that are hyperscalers / software platforms rather than services
 * outsourcers. Tracked because they win large IT deals, but they generate a lot
 * of product and licensing news that is NOT outsourcing — their Google News
 * queries below are therefore narrowed to services language.
 */
export const PLATFORM_VENDORS: readonly string[] = ["AWS", "Microsoft", "Oracle", "Google Cloud", "SAP"];

// ── Tier-1: Direct vendor newsroom / press RSS ──────────────────────────────
// Only vendors with known working RSS feeds
function pressSource(id: string, name: string, provider: string, url: string, hours = 8): SourceDefinition {
  return { id, name, provider, url, sourceType: "vendor_press_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: hours };
}

// All URLs below were verified live (2026-08) — each returns real, current
// press releases. Vendor RSS rots constantly, so re-check with:
//     npm run check:feeds
//
// Deliberately ABSENT because no working feed exists (verified, not assumed):
//   Accenture ...... newsroom migrated to Adobe Edge Delivery; zero feeds in
//                    its 3,663-URL sitemap. A structured query-index.json
//                    endpoint exists if a custom adapter is ever wanted.
//   CGI ............ retired its RSS; its own feed-list page has the anchors
//                    stripped and every historical feed path 404s.
//   Fujitsu ........ moved to global.fujitsu SPA; no feed in its 9k sitemap.
//   LTIMindtree .... rebranded to LTM; old feed path is a redirect stub.
//   Sopra Steria ... Sitefinity soft-404s every path (why /feed "worked").
//   Tietoevry ...... newsroom offers email subscription only, no RSS.
//   Infosys ........ Akamai 403s all non-browser clients at the origin.
//   Persistent ..... Radware bot manager blocks the whole site.
//   Tech Mahindra .. only /rss.xml exists and it serves generic service pages,
//                    NOT news — ingesting it would pollute the DB.
//   Wipro .......... press-release-feed.xml parses but is abandoned (newest
//                    item 2023-10), so it can never yield new articles.
// All of the above are still covered by their Google News feeds below.
export const VENDOR_RSS_SOURCES: SourceDefinition[] = [
  pressSource("atos-feed-rss",          "Atos News Feed",             "Atos",             "https://atos.net/en/feed"),
  pressSource("capgemini-feed-rss",     "Capgemini News Feed",        "Capgemini",        "https://www.capgemini.com/feed/", 6),
  pressSource("coforge-press-rss",      "Coforge Newsroom",           "Coforge",          "https://news.coforge.com/newsroom/press-release/rss.xml", 12),
  // Cognizant/Genpact/IBM use a Notified-style template — keep the query string.
  pressSource("cognizant-press-rss",    "Cognizant Press Releases",   "Cognizant",        "https://news.cognizant.com/newsannouncements?pagetemplate=rss", 6),
  // Concentrix: must be the WordPress *category* feed; /newsroom/feed/ is empty.
  pressSource("concentrix-news-rss",    "Concentrix Newsroom",        "Concentrix",       "https://www.concentrix.com/category/about/news/press-release/feed/", 12),
  // DXC/EPAM publish press releases via their Q4 investor platform.
  pressSource("dxc-press-rss",          "DXC Technology News",        "DXC Technology",   "https://investors.dxc.com/rss/pressrelease.aspx"),
  pressSource("epam-press-rss",         "EPAM Newsroom",              "EPAM",             "https://investors.epam.com/rss/pressrelease.aspx", 12),
  pressSource("genpact-press-rss",      "Genpact Newsroom",           "Genpact",          "https://media.genpact.com/news-releases?pagetemplate=rss", 12),
  // HCLTech: site-wide feed — carries news but also case studies/videos.
  pressSource("hcl-press-rss",          "HCLTech News",               "HCLTech",          "https://www.hcltech.com/rss.xml", 6),
  pressSource("ibm-press-rss",          "IBM Newsroom",               "IBM",              "https://newsroom.ibm.com/announcements?pagetemplate=rss", 6),
  pressSource("nagarro-press-rss",      "Nagarro Newsroom",           "Nagarro",          "https://www.nagarro.com/en/news-press-release/rss.xml", 12),
  pressSource("nttdata-news-rss",       "NTT DATA News",              "NTT DATA",         "https://www.nttdata.com/global/en/rss/news", 6),
];

// ── Tier-1: Investor Relations RSS ──────────────────────────────────────────
function irSource(id: string, name: string, provider: string, url: string): SourceDefinition {
  return { id, name, provider, url, sourceType: "investor_relations_release", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 12 };
}

// All URLs verified live (2026-08). Note the two Q4-platform conventions:
// Cloudflare-fronted IR sites use `/rss/pressrelease.aspx`, while *.gcs-web.com
// hosts use `/rss/news-releases.xml` — the wrong one 404s. These sites also
// reject non-browser User-Agents, which the crawler now sends.
//
// Excluded — verified to have NO usable IR feed:
//   Accenture, Capgemini ... no IR feed (Capgemini's /feed/ is blog content
//                            only; its press-release "feed" is a comments feed)
//   Fujitsu, Infosys ....... Infosys' advertised feeds return 200 with 30 items
//                            but serve stale Infosys Public Services content
//                            (2015-2023) — a trap, not a usable feed
//   LTIMindtree, NTT DATA, Tech Mahindra, Wipro, Coforge, Mphasis ... none exist
//   Virtusa ................ gcs-web feed returns 200/10 items but is FROZEN at
//                            Feb 2021 (went private) — dead archive
//   WNS .................... IR site returns 401 site-wide post-Capgemini deal
//   DXC, EPAM, HCLTech ..... their IR feed is the same URL already crawled in
//                            VENDOR_RSS_SOURCES; not duplicated here
// Do NOT use ibm.gcs-web.com — returns 200 with 10 items dated 2001.
export const INVESTOR_RELATIONS_SOURCES: SourceDefinition[] = [
  irSource("cognizant-ir-rss",    "Cognizant Investor Relations",  "Cognizant",   "https://investors.cognizant.com/rss/pressrelease.aspx"),
  irSource("concentrix-ir-rss",   "Concentrix Investor Relations", "Concentrix",  "https://ir.concentrix.com/rss/pressrelease.aspx"),
  irSource("genpact-ir-rss",      "Genpact Investor Relations",    "Genpact",     "https://genpact.gcs-web.com/rss/news-releases.xml"),
  irSource("ibm-ir-rss",          "IBM Investor Relations",        "IBM",         "https://newsroom.ibm.com/press-releases-corporate?pagetemplate=rss"),
  irSource("kyndryl-ir-rss",      "Kyndryl Investor Relations",    "Kyndryl",     "https://investors.kyndryl.com/rss/news-releases.xml"),
  irSource("exl-ir-rss",          "EXL Investor Relations",        "EXL",         "https://ir.exlservice.com/rss/news-releases.xml"),
  irSource("unisys-ir-rss",       "Unisys Investor Relations",     "Unisys",      "https://ir.unisys.com/rss/news-releases.xml"),
];

// ── Tier-1: Wire services ───────────────────────────────────────────────────
// Market-wide feeds: highest value per source since one feed covers every
// vendor at once. All URLs below verified live (2026-08).
//
// Two traps fixed here, both of which silently returned nothing/wrong data:
//  * Business Wire `?rss=G1` was NOT a valid channel id — the feed responded
//    200 with "RSS channel ID is not available in the request" and zero items.
//    Real ids are the opaque tokens below (Technology / Contract-Agreement /
//    Professional Services).
//  * GlobeNewswire selects content by the NUMERIC code; the trailing label is
//    cosmetic. The old `subjectcode/14-Information Technology` actually serves
//    code 14 = *Economic News*. Replaced with genuinely IT-scoped feeds.
function wire(id: string, name: string, url: string): SourceDefinition {
  return { id, name, provider: "Market Wide", url, sourceType: "wire_service", tier: "tier_1_primary", fetchMethod: "rss", refreshHours: 4 };
}

export const WIRE_SOURCES: SourceDefinition[] = [
  // Business Wire — verified 117 / 29 / 117 items
  wire("businesswire-tech-rss",      "BusinessWire Technology",           "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpQWg%3D%3D"),
  wire("businesswire-contract-rss",  "BusinessWire Contracts",            "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEF5XWA%3D%3D"),
  wire("businesswire-prof-svc-rss",  "BusinessWire Professional Services","https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpQWw%3D%3D"),
  // PR Newswire — scheme changed to /rss/<category>/<category>-list.rss (20 each)
  wire("prnewswire-biztech-rss",     "PR Newswire Business Technology",   "https://www.prnewswire.com/rss/business-technology-latest-news/business-technology-latest-news-list.rss"),
  wire("prnewswire-telecom-rss",     "PR Newswire Telecommunications",    "https://www.prnewswire.com/rss/telecommunications-latest-news/telecommunications-latest-news-list.rss"),
  // GlobeNewswire — industry-scoped feeds (20 each)
  wire("globenewswire-contracts-rss","GlobeNewsWire Business Contracts",  "https://www.globenewswire.com/RssFeed/subjectcode/7-Business%20Contracts/feedTitle/GlobeNewswire%20-%20Business%20Contracts"),
  wire("globenewswire-compsvc-rss",  "GlobeNewsWire Computer Services",   "https://www.globenewswire.com/RssFeed/industry/9533-Computer%20Services/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Computer%20Services"),
  wire("globenewswire-software-rss", "GlobeNewsWire Software",            "https://www.globenewswire.com/RssFeed/industry/9537-Software/feedTitle/GlobeNewswire%20-%20Industry%20News%20on%20Software"),
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

    // ── Platform vendors ─────────────────────────────────────────────────────
    // Narrowed to services language. Without this these feeds are dominated by
    // product launches, licensing and earnings rather than outsourcing deals.
    case "AWS":
      return gnews("AWS", `"Amazon Web Services" (migration OR "managed services" OR outsourcing OR "cloud contract") ${IT_SIGNAL_TERMS}`);
    case "Microsoft":
      return gnews("Microsoft", `"Microsoft" ("managed services" OR outsourcing OR "cloud migration" OR "digital transformation contract") ${IT_SIGNAL_TERMS}`);
    case "Oracle":
      return gnews("Oracle", `"Oracle Corporation" OR "Oracle" (ERP implementation OR "managed services" OR outsourcing) ${IT_SIGNAL_TERMS}`);
    case "Google Cloud":
      return gnews("Google Cloud", `"Google Cloud" (migration OR "managed services" OR outsourcing OR partnership) ${IT_SIGNAL_TERMS}`);
    case "SAP":
      return gnews("SAP", `"SAP SE" OR "SAP" (S/4HANA OR implementation OR "managed services" OR outsourcing) ${IT_SIGNAL_TERMS}`);

    // ── Ambiguous brand names ────────────────────────────────────────────────
    case "Maximus":
      return gnews("Maximus", `"Maximus Inc" OR "Maximus" (BPO OR government services OR outsourcing) ${IT_SIGNAL_TERMS}`);
    case "Alight":
      return gnews("Alight", `"Alight Solutions" ${IT_SIGNAL_TERMS}`);
    case "HGS":
      return gnews("HGS", `"Hinduja Global Solutions" OR "HGS" BPO ${IT_SIGNAL_TERMS}`);
    case "T-Systems":
      return gnews("T-Systems", `"T-Systems" ${IT_SIGNAL_TERMS}`);
    case "Serco":
      return gnews("Serco", `"Serco" (outsourcing OR BPO OR government contract) ${IT_SIGNAL_TERMS}`);
    case "Transcom":
      return gnews("Transcom", `"Transcom" (BPO OR "customer experience" OR outsourcing) ${IT_SIGNAL_TERMS}`);
    case "Arvato":
      return gnews("Arvato", `"Arvato" (BPO OR outsourcing OR "supply chain services") ${IT_SIGNAL_TERMS}`);

    // Ordinary-word names need explicit company context or the feed fills with
    // unrelated news ("reply", "crayon", "version 1", "indra" as a first name).
    case "Reply":
      return gnews("Reply", `"Reply S.p.A" OR "Reply Group" ${IT_SIGNAL_TERMS}`);
    case "Crayon":
      return gnews("Crayon", `"Crayon Group" ${IT_SIGNAL_TERMS}`);
    case "Indra":
      return gnews("Indra", `"Indra Sistemas" OR "Minsait" ${IT_SIGNAL_TERMS}`);
    case "Version 1":
      return gnews("Version 1", `"Version 1" (IT services OR consulting) ${IT_SIGNAL_TERMS}`);
    case "Quest Global":
      return gnews("Quest Global", `"Quest Global" OR "QuEST Global" engineering ${IT_SIGNAL_TERMS}`);
    case "Everise":
      return gnews("Everise", `"Everise" (BPO OR customer experience) ${IT_SIGNAL_TERMS}`);
    case "IGT Solutions":
      return gnews("IGT Solutions", `"IGT Solutions" ${IT_SIGNAL_TERMS}`);
    case "Insight Enterprises":
      return gnews("Insight Enterprises", `"Insight Enterprises" ${IT_SIGNAL_TERMS}`);
    case "Telefonica Tech":
      return gnews("Telefonica Tech", `"Telefonica Tech" OR "Telefónica Tech" ${IT_SIGNAL_TERMS}`);
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
// NOTE on anchoring: these alternations contain word STEMS (acqui, outsourc,
// restructur, sustainab). A trailing \b would stop "acqui" matching "acquire"
// or "sustainab" matching "sustainability", so the closing \b is deliberately
// omitted. Terms that do need a right-hand boundary carry their own (win\b).
const MA_TERMS          = /\b(acqui|merger|divest|stake acquisition|joint venture|\bJV\b|buyout|takeover)/i;
const PARTNER_TERMS     = /\b(strategic alliance|technology partnership|co-deliver|collaboration agreement|ecosystem partner)\b/i;
const OFFERING_TERMS    = /\b(launch|unveil|introduc|new platform|new service|new offering|new capability|practice area|delivery cent)\b/i;
const ORG_TERMS         = /\b(appoints?|hires?|joins? as|names? .*(?:CEO|CTO|CFO|COO|President|EVP)|restructur|headcount reduction|spin[- ]off)\b/i;

// Earnings / results coverage is a TRACKED CATEGORY (FINANCIAL_RESULTS), not
// noise. These terms used to sit inside HARD_EXCLUDE, which meant every
// earnings article was discarded before it ever reached the LLM.
const FINANCIAL_TERMS   = /\b(earnings?|revenue|quarterly results|\bQ[1-4]\b|quarter|annual report|full[- ]year|guidance|dividend|share price|\bstock\b|EPS|bookings|profit|margin|analyst (?:upgrade|rate|target))\b/i;

// Genuine noise only — marketing, research-firm rankings, thought leadership.
const HARD_EXCLUDE      = /\b(market research|magic quadrant|peer review|gartner|forrester|isg provider|everest group|leadership development|women in|csr|sustainab|carbon|climate|award for excellence|recognised as|named .*leader by|ranked .*in|survey finds?|study shows?|webinar|podcast|blog post|opinion|thought leadership|self[- ]service)/i;

const VENDOR_REQUIRE    = /\b(contract|award|outsourc|managed service|win\b|deal|selected by|engages?|acqui|partner(?:ship|s)?|merger|divest|joint venture|appoints?|restructur|delivery centre|opens?|launch|platform)\b/i;

// ── Tracked-vendor gate ─────────────────────────────────────────────────────
// Vendor-specific sources (Google News per vendor, vendor press, IR) are
// inherently scoped to a tracked vendor. Market-wide sources are NOT — e.g. the
// Business Wire technology feed returns ~117 general items per pull covering
// every industry. Without this gate that noise consumes the per-run LLM budget.
//
// Aliases only for names that genuinely appear differently in headlines; the
// rest are matched from TRACKED_VENDORS directly, so updating that list is all
// that is needed to change coverage.
const VENDOR_ALIASES: Record<string, string[]> = {
  "TCS": ["Tata Consultancy"],
  "HCLTech": ["HCL Technologies", "HCL Tech"],
  "NTT DATA": ["NTT Data"],
  "EY": ["Ernst & Young"],
  "PwC": ["PricewaterhouseCoopers"],
  "L&T Technology Services": ["LTTS", "L&T Technology"],
  "Orange Business": ["Orange Business Services"],
  "UST": ["UST Global"],
  "ADP": ["Automatic Data Processing"],
  "NICE": ["NICE Systems", "NICE Ltd"],
  "NEC": ["NEC Corporation"],
  "Persistent": ["Persistent Systems"],
  "Singtel": ["NCS"],
  "DXC Technology": ["DXC"],
  "Dell Technologies": ["Dell"],
  "Hitachi Digital Services": ["Hitachi Vantara", "Hitachi Digital"],
  "TELUS International": ["TELUS Digital"],
  "EXL": ["ExlService"],
  "Concentrix": ["Webhelp"],
  "CSS Corp": ["Movate"],
  "Indra": ["Indra Sistemas", "Minsait"],
  "Reply": ["Reply S.p.A", "Reply SpA"],
  "Version 1": ["Version1"],
  "Crayon": ["Crayon Group"],
  "Telefonica Tech": ["Telefónica Tech"],
  "SoftwareOne": ["SoftwareONE"],
  "Insight Enterprises": ["Insight Direct"],
  "Rackspace": ["Rackspace Technology"],
  "KPIT": ["KPIT Technologies"],
  "ALTEN": ["ALTEN Group"],
  "Akkodis": ["Adecco Akkodis"],
  "Quest Global": ["QuEST Global"],
  "eClerx": ["eClerx Services"],
  // Added 2026-08 with the universe expansion
  "AWS": ["Amazon Web Services"],
  "Google Cloud": ["Google Cloud Platform"],
  "SAP": ["SAP SE"],
  "Oracle": ["Oracle Corporation", "Oracle Corp"],
  "HGS": ["Hinduja Global Solutions"],
  "T-Systems": ["T Systems", "Deutsche Telekom IT"],
  "Alight": ["Alight Solutions"],
  "Maximus": ["Maximus Inc"],
  "Thoughtworks": ["ThoughtWorks"],
  "Zensar": ["Zensar Technologies"],
  "Softtek": ["SoftTek"],
  "Startek": ["StarTek"],
};

/**
 * Names that must match case-SENSITIVELY. Two groups:
 *  - acronyms that are also ordinary lowercase words ("SAP" vs "sap",
 *    "NICE" vs "nice", "HGS", "AWS", "EXL", "ADP", "NEC", "UST", "EY"),
 *  - brand names that are ordinary English words ("Alight", "Oracle",
 *    "Maximus", "Capita").
 * Matching these case-insensitively produced false positives — e.g. "a nice
 * contract" registering as the vendor NICE.
 */
const CASE_SENSITIVE_FORMS = new Set([
  "AWS", "SAP", "HGS", "NICE", "NEC", "UST", "EY", "EXL", "ADP", "CGI", "IBM", "TCS",
  "DXC", "WNS", "TTEC", "KPMG", "PwC", "LTTS", "NCS", "GCP",
  "Alight", "Oracle", "Maximus", "Capita",
  "NNIT", "ALTEN", "KPIT", "IGT Solutions", "VXI Global",
  // lowercase "insight enterprises" is an ordinary phrase
  "Insight Enterprises", "Everise", "Ensono",
]);

// Some tracked firms are named after ordinary words. Matching their bare name
// would flood the gate with false positives ("in reply to", "a box of crayons",
// "version 1 of the spec"), and case-sensitivity does not help because
// headlines capitalise sentence-initial words. For these, ONLY the unambiguous
// alias forms are matched.
const AMBIGUOUS_BARE_NAMES = new Set(["Reply", "Crayon", "Indra", "Version 1"]);

// Word boundaries stop short names matching inside other words ("UST" inside
// "August", "NEC" inside "connect").
const VENDOR_MATCHERS: { vendor: string; re: RegExp }[] = TRACKED_VENDORS.flatMap((vendor) => {
  const aliases = VENDOR_ALIASES[vendor] ?? [];
  const forms = AMBIGUOUS_BARE_NAMES.has(vendor) ? aliases : [vendor, ...aliases];
  return forms.map((form) => ({
    vendor,
    re: new RegExp(
      `(^|[^A-Za-z0-9])${form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`,
      CASE_SENSITIVE_FORMS.has(form) ? "" : "i",
    ),
  }));
});

/** True if the text names one of the tracked vendors. */
export function mentionsTrackedVendor(text: string): boolean {
  return VENDOR_MATCHERS.some(({ re }) => re.test(text));
}

/** Which tracked vendor the text names, if any. */
export function matchTrackedVendor(text: string): string | null {
  return VENDOR_MATCHERS.find(({ re }) => re.test(text))?.vendor ?? null;
}

/**
 * Same as matchTrackedVendor, but resolves ties using an explicit precedence
 * list first. Needed where one string names several tracked vendors — e.g.
 * "IBM and CGI" or "PwC, KPMG, AECOM" — so attribution is deterministic rather
 * than falling out of the order TRACKED_VENDORS happens to be written in.
 */
export function matchTrackedVendorPreferring(text: string, priority: readonly string[]): string | null {
  for (const vendor of priority) {
    if (VENDOR_MATCHERS.some(m => m.vendor === vendor && m.re.test(text))) return vendor;
  }
  return matchTrackedVendor(text);
}

export function isRelevantArticle(title: string, sourceType?: string): { relevant: boolean; family: string } {
  const t = title;
  if (HARD_EXCLUDE.test(t)) return { relevant: false, family: "EXCLUDED" };
  // Deal families are checked BEFORE financial so that genuine deal news which
  // happens to mention revenue (e.g. "Wipro wins Harman deal; Q3 revenue up")
  // stays a CONTRACT rather than being reclassified as an earnings story.
  if (MA_TERMS.test(t))       return { relevant: true, family: "M_AND_A" };
  if (CONTRACT_TERMS.test(t)) return { relevant: true, family: "CONTRACT" };
  if (PARTNER_TERMS.test(t))  return { relevant: true, family: "PARTNERSHIP" };
  if (OFFERING_TERMS.test(t)) return { relevant: true, family: "NEW_OFFERING" };
  if (ORG_TERMS.test(t))      return { relevant: true, family: "ORG_CHANGE" };
  if (FINANCIAL_TERMS.test(t)) return { relevant: true, family: "FINANCIAL_RESULTS" };

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
