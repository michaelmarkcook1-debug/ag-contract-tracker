import { SourceDefinition } from "./sources";

export interface RawArticle {
  title: string;
  url: string;
  publishedAt: string | null;
  snippet: string | null;
  sourceId: string;
  provider: string;
  sourceType: string;
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

const IT_VENDORS = [
  "Accenture", "IBM", "Infosys", "TCS", "Cognizant", "Wipro", "Capgemini",
  "HCL", "DXC", "Atos", "Kyndryl", "NTT", "Fujitsu", "Deloitte",
  "KPMG", "EY", "PwC", "CGI", "Tech Mahindra", "Sopra Steria",
  "Computacenter", "Leidos", "SAIC", "Unisys", "Concentrix", "Conduent",
];

async function fetchUKContractsFinder(): Promise<RawArticle[]> {
  const articles: RawArticle[] = [];
  const fromDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const seen = new Set<string>();

  for (const vendor of IT_VENDORS.slice(0, 8)) {
    try {
      const url = `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?queryString=${encodeURIComponent(vendor)}&size=20&publishedFrom=${fromDate}`;
      const res = await fetch(url, { headers: { "User-Agent": "ITMarketIntel/1.0" }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const data = await res.json() as { releases?: Array<{id: string; tender?: {title?: string; description?: string; value?: {amount?: number}}; awards?: Array<{value?: {amount?: number}}>; date?: string}> };
      if (!data.releases) continue;

      for (const rel of data.releases) {
        const id = rel.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const tender = rel.tender ?? {};
        const title = tender.title ?? "";
        if (!title) continue;
        const value = rel.awards?.[0]?.value?.amount ?? tender.value?.amount;
        const snippet = tender.description?.slice(0, 400) ?? null;
        articles.push({
          title: `${title}${value ? ` — £${(value / 1000).toFixed(0)}k` : ""}`,
          url: `https://www.contractsfinder.service.gov.uk/Notice/${id}`,
          publishedAt: rel.date ?? null,
          snippet,
          sourceId: "uk-contracts-finder-api",
          provider: vendor,
          sourceType: "procurement_notice",
        });
      }
      await new Promise(r => setTimeout(r, 400));
    } catch {
      // continue on individual vendor errors
    }
  }
  return articles;
}

// ── Main crawl function ───────────────────────────────────────────────────────

export async function crawlSource(source: SourceDefinition): Promise<{ articles: RawArticle[]; error?: string }> {
  try {
    if (source.fetchMethod === "api" && source.id === "uk-contracts-finder-api") {
      const articles = await fetchUKContractsFinder();
      return { articles };
    }

    // SAM.gov requires an api.data.gov key. Without one the endpoint returns
    // 401, so treat a missing key as "nothing to crawl" rather than an error —
    // otherwise it reports a failure on every single run.
    if (source.fetchMethod === "api" && source.id === "sam-gov-api") {
      if (!process.env.SAM_GOV_API_KEY) return { articles: [] };
      return { articles: [], error: "SAM.gov fetch not implemented yet" };
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
