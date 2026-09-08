export type SourceTier = "tier_1_primary" | "tier_2_secondary";
export type FetchMethod = "rss" | "api" | "html" | "gdelt";
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
//   DXC, EPAM ...... Q4-hosted feeds (investors.*.com/rss/pressrelease.aspx)
//                    return 403 to every client since 2026-09 (bot check);
//                    the gcs-web.com alternates do not resolve.
// All of the above are still covered by their Google News feeds below.
export const VENDOR_RSS_SOURCES: SourceDefinition[] = [
  pressSource("atos-feed-rss",          "Atos News Feed",             "Atos",             "https://atos.net/en/feed"),
  pressSource("capgemini-feed-rss",     "Capgemini News Feed",        "Capgemini",        "https://www.capgemini.com/feed/", 6),
  pressSource("coforge-press-rss",      "Coforge Newsroom",           "Coforge",          "https://news.coforge.com/newsroom/press-release/rss.xml", 12),
  // Cognizant/Genpact/IBM use a Notified-style template — keep the query string.
  pressSource("cognizant-press-rss",    "Cognizant Press Releases",   "Cognizant",        "https://news.cognizant.com/newsannouncements?pagetemplate=rss", 6),
  // Concentrix: must be the WordPress *category* feed; /newsroom/feed/ is empty.
  pressSource("concentrix-news-rss",    "Concentrix Newsroom",        "Concentrix",       "https://www.concentrix.com/category/about/news/press-release/feed/", 12),
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
//   Cognizant, Concentrix .. Q4-hosted IR feeds 403 every client since 2026-09
//                            (removed; both keep their Google News feeds and
//                            Cognizant keeps its working newsroom feed)
//   DXC, EPAM, HCLTech ..... their IR feed is the same URL already crawled in
//                            VENDOR_RSS_SOURCES; not duplicated here
// Do NOT use ibm.gcs-web.com — returns 200 with 10 items dated 2001.
export const INVESTOR_RELATIONS_SOURCES: SourceDefinition[] = [
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
  // Business Wire — only Professional Services still carries items. The
  // Technology and Contract/Agreement channels answer 200 with an empty
  // channel since 2026-09 (nothing is published to them any more) and the
  // feed directory pages are bot-blocked (403), so no replacement ids could be
  // verified. The pipeline now flags any feed returning 0 items, so a silent
  // death like that shows in Source health instead of hiding behind "OK".
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
// One feed per tracked vendor — catches articles from any news source.
//
// Three facts about Google News search feeds shaped this (all measured 2026-09):
//  * Results are RELEVANCE-ranked across all time and capped at 100 items.
//    Without a date bound a vendor's feed is mostly evergreen and stock-site
//    articles: Infosys' feed held 3 items from the last 30 days, Sopra Steria's
//    oldest item was 11 years old. `when:Nd` is what makes the feed recent.
//  * The 100-item cap still bites high-volume vendors — IBM, TCS and Microsoft
//    fill 100 items inside 30 days — so those get a 7-day window. The pipeline
//    marks any feed that returns exactly 100 items "at cap" in Source health;
//    move a vendor into HIGH_VOLUME_VENDORS when that appears.
//  * `after:` / `before:` are NOT honoured by the RSS endpoint (a March-2026
//    window returned May–July items), so historical backfill cannot use these
//    feeds. The 18-month rerun needs a dated source (GDELT) instead.
function gnews(vendor: string, names: readonly string[], terms: string, windowDays: number): SourceDefinition {
  // Shape: when:Nd FIRST, then (name alternatives) (signal terms). Google
  // drops a trailing `when:` whenever it follows an OR-group of quoted names —
  // measured 2026-09: `("HCLTech" OR "HCL Technologies") (…) when:7d` returned
  // 52 of 100 items older than 60 days, the same query with `when:7d` in front
  // returned none. Nested groups did the same (SAP 95 of 100 stale).
  const alternatives = names.map(n => `"${n}"`).join(" OR ");
  const q = encodeURIComponent(`when:${windowDays}d (${alternatives}) (${terms})`);
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

// The verbs announcements are actually headlined with. The previous set
// (contract/award/outsourcing/partnership/acquisition/divest) had no
// "selected", "signs", "wins", "deal", "agreement", "renews" or "extends" —
// which is how most awards are written up. Measured 2026-09: item count is
// flat from 3 to 15 terms (Capita 41→44), so the longer list costs nothing.
const IT_SIGNAL_TERMS = "contract OR award OR selected OR signs OR wins OR deal OR agreement OR outsourcing OR renews OR extends OR expands OR partnership OR acquisition OR acquires OR divest";
// Hyperscalers / software platforms: product and licensing news dominates, so
// the terms are services language.
const PLATFORM_SIGNAL_TERMS = `outsourcing OR "managed services" OR "cloud migration" OR implementation OR "digital transformation" OR contract OR deal OR agreement OR selected OR partnership OR acquisition OR acquires`;
// Big-4: audit, tax and advisory news dominates; the terms are technology-services language.
const CONSULTING_SIGNAL_TERMS = `"IT services" OR technology OR outsourcing OR "managed services" OR "digital transformation" OR implementation OR contract OR deal OR agreement OR selected OR partnership OR acquisition OR acquires`;
const BIG4 = new Set(["Deloitte", "EY", "PwC", "KPMG"]);

/** Vendors whose feed fills the 100-item cap inside 30 days. */
const HIGH_VOLUME_VENDORS = new Set<string>([
  "Accenture", "IBM", "TCS", "Infosys", "Wipro", "HCLTech", "Cognizant", "Capgemini",
  "Deloitte", "EY", "PwC", "KPMG", "Microsoft", "AWS", "Google Cloud", "Oracle", "SAP",
  "Dell Technologies", "Tech Mahindra", "NTT DATA", "Fujitsu", "Kyndryl",
]);
export const GNEWS_WINDOW_DAYS = { highVolume: 7, standard: 30 } as const;
/** Google News caps a search feed at this many items; hitting it means the window is too wide. */
export const GNEWS_ITEM_CAP = 100;
const windowFor = (vendor: string) =>
  HIGH_VOLUME_VENDORS.has(vendor) ? GNEWS_WINDOW_DAYS.highVolume : GNEWS_WINDOW_DAYS.standard;

// Search names come from the same alias table the ingestion gate uses, so one
// edit changes both. Overrides are for names that are safe to MATCH in a
// headline but too ambiguous to SEARCH for ("NCS", bare "Dell").
const GNEWS_NAME_OVERRIDES: Record<string, readonly string[]> = {
  "CGI": ["CGI Inc", "CGI Group"],
  "NEC": ["NEC Corporation"],
  "NICE": ["NICE Systems", "NICE Ltd"],
  "UST": ["UST Global", "UST"],
  "ADP": ["ADP", "Automatic Data Processing"],
  "Dell Technologies": ["Dell Technologies"],
  "Singtel": ["Singtel", "NCS Group"],
  "T-Systems": ["T-Systems"],
  "Quest Global": ["Quest Global"],
};
function searchNames(vendor: string): readonly string[] {
  if (GNEWS_NAME_OVERRIDES[vendor]) return GNEWS_NAME_OVERRIDES[vendor];
  const aliases = VENDOR_ALIASES[vendor] ?? [];
  return AMBIGUOUS_BARE_NAMES.has(vendor) ? aliases : [vendor, ...aliases];
}

export const GOOGLE_NEWS_SOURCES: SourceDefinition[] = TRACKED_VENDORS.map(vendor => {
  const terms = PLATFORM_VENDORS.includes(vendor) ? PLATFORM_SIGNAL_TERMS
    : BIG4.has(vendor) ? CONSULTING_SIGNAL_TERMS
    : IT_SIGNAL_TERMS;
  return gnews(vendor, searchNames(vendor), terms, windowFor(vendor));
});

// ── Historical backfill: GDELT ─────────────────────────────────────────────
// Google News feeds cannot be windowed by date (see above), so a rerun over
// past months uses the GDELT DOC API, which indexes worldwide news with exact
// date ranges and returns PUBLISHER URLs (no redirect decoding). One source
// per vendor per calendar month keeps each request under GDELT's 250-record
// cap. Not part of ALL_SOURCES — only scripts/backfill-gdelt.ts uses these.
const GDELT_SIGNAL_TERMS = "contract OR deal OR agreement OR selected OR wins OR outsourcing OR partnership OR acquisition OR acquires";

function ymd(d: Date): string { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

export function gdeltBackfillSources(from: Date, to: Date, vendors: readonly string[] = TRACKED_VENDORS): SourceDefinition[] {
  const out: SourceDefinition[] = [];
  for (const vendor of vendors) {
    // GDELT only allows parentheses around OR'd statements — a lone name must not be wrapped.
    const forms = searchNames(vendor).map(n => `"${n}"`);
    const names = forms.length > 1 ? `(${forms.join(" OR ")})` : forms[0];
    let start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (start < to) {
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const q = encodeURIComponent(`${names} (${GDELT_SIGNAL_TERMS}) sourcelang:english`);
      out.push({
        id: `gdelt-${vendor.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${ymd(start).slice(0, 6)}`,
        name: `${vendor} — GDELT ${ymd(start).slice(0, 6)}`,
        provider: vendor,
        url: `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=250&sort=datedesc&startdatetime=${ymd(start)}000000&enddatetime=${ymd(new Date(Math.min(end.getTime(), to.getTime())))}000000`,
        sourceType: "wire_service",
        tier: "tier_2_secondary",
        fetchMethod: "gdelt",
        refreshHours: 24 * 365,
      });
      start = end;
    }
  }
  return out;
}

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

// Noise the triage model was KEEPING (measured 2026-09 on a 60-article sample):
// securities filings and share-price commentary, sponsorships, vendor/analyst
// awards, conference appearances. None of these are market events, and the
// share-price pieces are always re-reports of an event covered elsewhere.
const NOISE_EXCLUDE     = /\b(stock (?:grants?|awards?|units?|options?)|restricted stock|RSUs?|share buyback|buyback|price target|fair value|insider (?:buying|selling|purchase|sale)|hedge fund|mutual fund|open market (?:buys|purchases)|13F|should you buy|(?:stock|shares?) (?:jumps?|surges?|falls?|drops?|slides?|climbs?|rallies|plunges?|dips?|rises?|gains?|tumbles?|holds? steady|in focus|outlook|forecast|analysis|watch)|holds? steady|steady as|edges? (?:up|down|higher|lower)|ticks? (?:up|down)|trades? (?:higher|lower|flat)|investors eye|sponsor(?:ship|s|ed)?|football club|cricket|(?:innovation|excellence|leadership|practice|industry|technology|partner|vendor|employer|workplace|brand) awards?|awards? (?:ceremony|winner|gala)|named (?:an? )?honou?ree|to (?:showcase|exhibit)|keynote)\b/i;

// §3 — a CONTRACT requires evidence of an actual commercial award. Source type
// alone must NEVER establish one. These terms distinguish a concluded award
// from a procurement opportunity.
export const AWARD_EVIDENCE    = /\b(award(ed|s)?|has been selected|was selected|selected as|signed|renew(ed|al)|extend(ed|s|sion)|wins?|won|secured|appointed as (?:supplier|provider)|contract with|go[- ]live)\b/i;
export const OPPORTUNITY_ONLY  = /\b(tender|invitation to tender|\bITT\b|request for proposal|\bRFP\b|request for quote|\bRFQ\b|prior information notice|\bPIN\b|expression of interest|\bEOI\b|market engagement|seeking suppliers?|inviting bids?|opportunity|pre[- ]qualification|supplier registration|call for competition)\b/i;

// Widened 2026-09-08: "Kyndryl announces agreement to purchase Healthcare IT Leaders"
// was dropped from Kyndryl's own feed for lacking any of the original verbs.
const VENDOR_REQUIRE    = /\b(contract|award|outsourc|managed service|win\b|wins|deal|agreement|purchase|selected|selects|signs?|secures?|engages?|acqui|to acquire|completes|partner(?:ship|s)?|collaborat|alliance|merger|divest|joint venture|invest(?:s|ment)?|appoints?|names?|joins|restructur|delivery cent(?:re|er)|opens?|launch|unveils?|introduc|delivers?|expands?|renews?|extends?|platform|results|revenue|quarter|guidance|bookings|order)\b/i;

// Analyst-rating notes stay out even when they mention a deal — the deal is reported elsewhere.
const ANALYST_NOTE = /\b(price target|target price|rating|upgrades?|downgrades?|initiates coverage|brokerages?|analysts? (?:say|flag|see))\b/i;
// A headline that names a transaction — used to let such headlines past the noise rules.
const TRANSACTION_SIGNAL = /\b(contract|deal|agreement|acqui(?:res?|sition)|merger|selected(?: by)?|selects|signs?\b|bagg?(?:ing|s|ed)|secures?|mandate|order (?:worth|for|from)|worth [$£€]|[$£€]\s?\d)\b/i;

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

/**
 * Structural selection — the only pre-model filter the pipeline applies.
 * Market-wide wire feeds carry every company's press releases, so an item
 * that names no tracked vendor is dropped before any spend. Everything else
 * goes to the model, which reads the article and decides what it is. The
 * headline regexes below (isRelevantArticle) now serve only the rule-based
 * fallback used when no API key is configured.
 */
export function selectArticle(a: { title: string; snippet: string | null; provider: string }): { relevant: boolean; reason?: string } {
  if (!a.title.trim()) return { relevant: false, reason: "rules:no_title" };
  if (a.provider === "Market Wide" && !mentionsTrackedVendor(`${a.title} ${a.snippet ?? ""}`)) {
    return { relevant: false, reason: "rules:vendor_gate" };
  }
  return { relevant: true };
}

export interface RelevanceVerdict {
  relevant: boolean;
  family: string;
  /** Set when relevant is false — persisted as SourceEvent.exclusionReason. */
  reason?: string;
}

export function isRelevantArticle(title: string, sourceType?: string): RelevanceVerdict {
  const t = title;
  if (HARD_EXCLUDE.test(t))  return { relevant: false, family: "EXCLUDED", reason: "rules:hard_exclude" };
  // Noise rules yield to a TRANSACTION in the headline: "LTTS shares jump 3% after
  // bagging $75 million deal" is a share-price headline AND the only report of a
  // contract (retested 2026-09-08: the Indian financial press headlines awards this
  // way). The model decides those. "Partnership" and "award" alone do not exempt —
  // sponsorships and industry awards carry those words.
  if (NOISE_EXCLUDE.test(t) && (!TRANSACTION_SIGNAL.test(t) || ANALYST_NOTE.test(t))) {
    return { relevant: false, family: "EXCLUDED", reason: "rules:noise" };
  }

  // §3 — OPPORTUNITY GUARD, deliberately ahead of the family matchers.
  // A tender headline usually contains the word "contract" ("tender for a
  // five-year managed-services contract"), so CONTRACT_TERMS would otherwise
  // claim it before any source-type logic runs. An opportunity with no award
  // evidence is never a contract win, whatever the source.
  if (OPPORTUNITY_ONLY.test(t) && !AWARD_EVIDENCE.test(t)) {
    return { relevant: true, family: "UNCLASSIFIED" };
  }
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
      : { relevant: false, family: "EXCLUDED", reason: "rules:no_signal" };
  }

  // §3/§6 — procurement sources are relevant EVIDENCE but a notice is not a win.
  // An opportunity/tender never becomes CONTRACT here; only explicit award
  // language does. Anything ambiguous stays UNCLASSIFIED so the classifier (or
  // review) decides, rather than manufacturing a contract from source type.
  if (sourceType === "procurement_notice") {
    if (OPPORTUNITY_ONLY.test(t) && !AWARD_EVIDENCE.test(t)) {
      return { relevant: true, family: "UNCLASSIFIED" };
    }
    return AWARD_EVIDENCE.test(t)
      ? { relevant: true, family: "CONTRACT" }
      : { relevant: true, family: "UNCLASSIFIED" };
  }

  // §7 — wire services carry every event type. Source provenance says nothing
  // about event semantics, so these proceed to real classification.
  if (sourceType === "wire_service") {
    return { relevant: true, family: "UNCLASSIFIED" };
  }

  return { relevant: false, family: "UNCLASSIFIED", reason: "rules:unsupported_source" };
}
