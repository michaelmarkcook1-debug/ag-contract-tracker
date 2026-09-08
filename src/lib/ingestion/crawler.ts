import { SourceDefinition, matchTrackedVendor } from "./sources";

export interface RawArticle {
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  sourceId: string;
  provider: string;
  sourceType: string;
  /** Publisher page behind an aggregator link, once resolved (see article-text.ts). */
  publisherUrl?: string | null;
  /** Readable text of the publisher page, truncated; null when it could not be fetched. */
  bodyText?: string | null;
}

// ── RSS parser (handles RSS 2.0 + Atom, CDATA, self-closing link tags) ────────

function extractCDATA(str: string): string {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(str);
  if (m) return m[1].trim();
  return str.replace(/<[^>]*>/g, "").trim();
}

function extractTagText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m) return "";
  return extractCDATA(m[1])
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .trim();
}

function extractLink(xml: string): string {
  // Atom self-closing: <link href="..." rel="alternate" />
  const atom = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/.exec(xml);
  if (atom) return atom[1];
  // RSS <link>URL</link>
  const rss = /<link[^>]*>([^<]+)<\/link>/i.exec(xml);
  if (rss) return rss[1].trim();
  // guid fallback
  const guid = /<guid[^>]*>([^<]+)<\/guid>/i.exec(xml);
  if (guid && guid[1].startsWith("http")) return guid[1].trim();
  return "";
}

function extractDate(xml: string): string | null {
  const tags = ["pubDate", "published", "updated", "dc:date"];
  for (const tag of tags) {
    const m = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i").exec(xml);
    if (m) return m[1].trim();
  }
  return null;
}

function parseRss(text: string, sourceId: string, provider: string, sourceType: string): RawArticle[] {
  const items: RawArticle[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

  const processBlock = (block: string) => {
    const title = extractTagText(block, "title");
    const url = extractLink(block) || extractTagText(block, "link");
    const snippet = extractTagText(block, "description") || extractTagText(block, "summary") || extractTagText(block, "content");
    const publishedAt = extractDate(block);
    if (title && url) {
      items.push({ title, url, publishedAt, snippet: snippet.slice(0, 500) || null, sourceId, provider, sourceType });
    }
  };

  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(text))) processBlock(m[1]);
  if (items.length === 0) {
    while ((m = entryRe.exec(text))) processBlock(m[1]);
  }
  return items;
}

// ── UK Contracts Finder API ───────────────────────────────────────────────────
//
// Pulls recent AWARD notices market-wide and keeps those whose awarded supplier
// is a tracked vendor. The previous approach searched eight names from a
// separate, stale list (it included Leidos and SAIC, which the product
// deliberately excludes, and missed the other 110 tracked vendors). Matching
// on the OCDS supplier name is precise, and it is six requests instead of one
// per vendor. The API rate-limits hard (429) — requests are paced, and a 429
// ends the crawl with an error instead of hammering the endpoint.
const CF_BASE = "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
const CF_QUERIES = ["IT services", "software", "digital", "managed services", "outsourcing", "technology"];
const CF_LOOKBACK_DAYS = 14;

interface OcdsRelease {
  id?: string; ocid?: string; date?: string;
  buyer?: { name?: string };
  tender?: { title?: string; description?: string };
  awards?: Array<{
    id?: string; date?: string;
    value?: { amount?: number; currency?: string };
    suppliers?: Array<{ name?: string }>;
  }>;
}

// Supplier names are usually upper-case ("CAPITA BUSINESS SERVICES LTD"); the
// case-sensitive vendor forms (Capita, IBM, …) need the name tried both ways.
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
function trackedSupplier(names: string[]): string | null {
  for (const n of names) {
    const hit = matchTrackedVendor(n) ?? matchTrackedVendor(titleCase(n));
    if (hit) return hit;
  }
  return null;
}

async function fetchUKContractsFinder(): Promise<{ articles: RawArticle[]; error?: string }> {
  const articles: RawArticle[] = [];
  const fromDate = new Date(Date.now() - CF_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set<string>();

  for (const [i, q] of CF_QUERIES.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 700));
    const url = `${CF_BASE}?queryString=${encodeURIComponent(q)}&stages=award&publishedFrom=${fromDate}&size=100`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": "ITMarketIntel/1.0" }, signal: AbortSignal.timeout(15000) });
    } catch (err) {
      return { articles, error: `Contracts Finder: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.status === 429) return { articles, error: "Contracts Finder: rate limited (429) — partial crawl" };
    if (!res.ok) return { articles, error: `Contracts Finder: HTTP ${res.status}` };
    const data = await res.json().catch(() => null) as { releases?: OcdsRelease[] } | null;

    for (const rel of data?.releases ?? []) {
      const title = rel.tender?.title ?? "";
      if (!title || !rel.id) continue;
      for (const award of rel.awards ?? []) {
        const supplierNames = (award.suppliers ?? []).map(s => s.name ?? "").filter(Boolean);
        const vendor = trackedSupplier(supplierNames);
        if (!vendor) continue;
        const key = `${rel.id}|${award.id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const amount = award.value?.amount;
        const currency = award.value?.currency ?? "GBP";
        articles.push({
          // "awarded" is the award-evidence word the relevance rules look for.
          title: `${vendor} awarded: ${title}${amount ? ` — ${currency} ${Math.round(amount).toLocaleString("en-GB")}` : ""}`,
          url: `https://www.contractsfinder.service.gov.uk/Notice/${rel.id}`,
          publishedAt: award.date ?? rel.date ?? null,
          snippet: [
            `Buyer: ${rel.buyer?.name ?? "unknown"}`,
            `Supplier: ${supplierNames.join(", ")}`,
            amount ? `Award value: ${currency} ${amount}` : null,
            rel.tender?.description?.slice(0, 300) ?? null,
          ].filter(Boolean).join(". "),
          sourceId: "uk-contracts-finder-api",
          provider: vendor,
          sourceType: "procurement_notice",
        });
      }
    }
  }
  return { articles };
}

// ── GDELT DOC API (historical backfill) ───────────────────────────────────────
// Rate-limited by GDELT (one request every few seconds is safe); the backfill
// script paces calls. A non-JSON body is what GDELT returns when throttled.
async function fetchGdelt(source: SourceDefinition): Promise<{ articles: RawArticle[]; error?: string }> {
  // GDELT throttles at roughly one request per 5s per client; back off on 429.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 6000 * attempt));
    res = await fetch(source.url, { headers: { "User-Agent": "ITMarketIntel/1.0" }, signal: AbortSignal.timeout(30000) });
    if (res.status !== 429) break;
  }
  if (!res) return { articles: [], error: "no response" };
  if (!res.ok) return { articles: [], error: `HTTP ${res.status}` };
  const text = await res.text();
  let data: { articles?: Array<{ url?: string; title?: string; seendate?: string; domain?: string; language?: string }> };
  try { data = JSON.parse(text); } catch { return { articles: [], error: `GDELT non-JSON response (throttled?): ${text.slice(0, 80)}` }; }
  const seen = new Set<string>();
  const articles: RawArticle[] = [];
  for (const a of data.articles ?? []) {
    if (!a.url || !a.title || seen.has(a.url)) continue;
    seen.add(a.url);
    // seendate is YYYYMMDDTHHMMSSZ
    const d = a.seendate && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate);
    articles.push({
      title: a.title, url: a.url,
      publishedAt: d ? `${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}Z` : null,
      snippet: null, sourceId: source.id, provider: source.provider, sourceType: source.sourceType,
    });
  }
  return { articles };
}

// ── Main crawl function ───────────────────────────────────────────────────────

export async function crawlSource(source: SourceDefinition): Promise<{ articles: RawArticle[]; error?: string }> {
  try {
    if (source.fetchMethod === "api" && source.id === "uk-contracts-finder-api") {
      return fetchUKContractsFinder();
    }

    // SAM.gov requires an api.data.gov key. Without one the endpoint returns
    // 401, so treat a missing key as "nothing to crawl" rather than an error —
    // otherwise it reports a failure on every single run.
    if (source.fetchMethod === "api" && source.id === "sam-gov-api") {
      if (!process.env.SAM_GOV_API_KEY) return { articles: [] };
      return { articles: [], error: "SAM.gov fetch not implemented yet" };
    }

    if (source.fetchMethod === "gdelt") {
      return fetchGdelt(source);
    }

    if (source.fetchMethod === "rss") {
      // Use a browser User-Agent: several vendor/IR hosts (Cloudflare, Akamai,
      // Q4) reject unknown bot agents with 403, and enterprise IR platforms can
      // take >15s to respond cold. Both were previously misreported as dead
      // feeds when the URL was actually fine.
      const res = await fetch(source.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(25000),
        redirect: "follow",
      });
      if (!res.ok) return { articles: [], error: `HTTP ${res.status}` };
      const text = await res.text();
      const articles = parseRss(text, source.id, source.provider, source.sourceType);
      return { articles };
    }

    return { articles: [], error: `Unsupported fetchMethod: ${source.fetchMethod}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { articles: [], error: msg };
  }
}
