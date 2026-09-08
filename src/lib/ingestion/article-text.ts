/**
 * Article body retrieval for the analysis tier.
 *
 * Google News feed items carry only a headline: the RSS "description" is the
 * redirect link itself, so the extraction model was asked for value, term,
 * scope and an analyst insight from a title alone and — honestly — reported
 * ~0.5 confidence, which is what filled the review queue. This module turns a
 * feed item into the publisher URL plus a few thousand characters of readable
 * text, so the model reasons over the actual release.
 *
 * Google News redirect decoding follows the documented-in-the-wild
 * `batchexecute` flow: the article page carries `data-n-a-sg` / `data-n-a-ts`
 * signatures, which are posted back to obtain the target URL. Verified live
 * 2026-09-06. It is best-effort: any failure returns null and the caller
 * falls back to the headline, never to a guess.
 */

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 1_500_000;
export const DEFAULT_MAX_CHARS = 5_000;

const GOOGLE_NEWS_ARTICLE = /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\/([^/?#]+)/;

/** Decoded redirects for this process — the same article shows up under several vendor feeds. */
const redirectCache = new Map<string, string | null>();

export function isGoogleNewsUrl(url: string): boolean {
  return GOOGLE_NEWS_ARTICLE.test(url);
}

async function fetchText(url: string, init?: RequestInit): Promise<{ status: number; body: string; finalUrl: string } | null> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9", ...(init?.headers ?? {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, body: await res.text(), finalUrl: res.url };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
    reader.cancel().catch(() => {});
    const body = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
    return { status: res.status, body, finalUrl: res.url };
  } catch {
    return null;
  }
}

/**
 * Google News article URL → publisher URL. Returns null when the page has no
 * signature (layout change, consent wall) or the decode call fails.
 */
export async function resolveGoogleNewsUrl(url: string): Promise<string | null> {
  const m = GOOGLE_NEWS_ARTICLE.exec(url);
  if (!m) return url;
  const id = m[1];
  if (redirectCache.has(id)) return redirectCache.get(id) ?? null;

  const page = await fetchText(`https://news.google.com/rss/articles/${id}?oc=5`);
  const sg = page && /data-n-a-sg="([^"]+)"/.exec(page.body)?.[1];
  const ts = page && /data-n-a-ts="([^"]+)"/.exec(page.body)?.[1];
  if (!sg || !ts) { redirectCache.set(id, null); return null; }

  const inner = JSON.stringify([
    "garturlreq",
    [["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]],
      "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0],
    id, Number(ts), sg,
  ]);
  const freq = JSON.stringify([[["Fbv4je", inner, null, "generic"]]]);
  const res = await fetchText("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `f.req=${encodeURIComponent(freq)}`,
  });
  let target: string | null = null;
  if (res && res.status === 200) {
    // Response is `)]}'` followed by a JSON envelope whose payload is itself a
    // JSON string: [["wrb.fr","Fbv4je","[\"garturlres\",\"<url>\",...]",...]]
    try {
      const envelope = JSON.parse(res.body.replace(/^\)\]\}'\s*/, "")) as unknown[];
      const payload = (envelope as unknown[][]).find(row => Array.isArray(row) && row[1] === "Fbv4je")?.[2];
      if (typeof payload === "string") {
        const decoded = JSON.parse(payload) as unknown[];
        if (decoded[0] === "garturlres" && typeof decoded[1] === "string") target = decoded[1];
      }
    } catch { /* fall through to the regex */ }
    if (!target) {
      const hit = /https?:\/\/(?!news\.google\.com)[^"\\\s]+/.exec(res.body);
      target = hit ? hit[0] : null;
    }
  }
  redirectCache.set(id, target);
  return target;
}

// ── HTML → readable text ──────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|br)\s*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Site chrome the readable text should not start with. Removed as blocks before extraction. */
function dropChrome(html: string): string {
  return html.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
}

function jsonLdArticleBody(html: string): string | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1]) as unknown;
      const nodes: unknown[] = Array.isArray(data) ? data : [data];
      for (const n of nodes) {
        const obj = n as { articleBody?: unknown; "@graph"?: unknown[] };
        const cands = [obj, ...(Array.isArray(obj["@graph"]) ? obj["@graph"] : [])] as { articleBody?: unknown }[];
        for (const c of cands) if (typeof c?.articleBody === "string" && c.articleBody.length > 200) return c.articleBody;
      }
    } catch { /* malformed block — ignore */ }
  }
  return null;
}

function metaDescription(html: string): string | null {
  const m = /<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']{40,})["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']{40,})["'][^>]+(?:property=["']og:description["']|name=["']description["'])/i.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

export interface ArticleText {
  text: string;
  finalUrl: string;
  /** Which extraction path produced the text — recorded for provenance. */
  method: "json_ld" | "article" | "main" | "body" | "meta";
}

/**
 * Fetch a publisher page and return its readable text, capped at maxChars.
 * Null when the page cannot be fetched or yields nothing article-like.
 */
export async function fetchArticleText(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<ArticleText | null> {
  const page = await fetchText(url);
  if (!page || page.status >= 400 || !page.body) return null;
  const html = page.body;

  const ld = jsonLdArticleBody(html);
  if (ld) return { text: decodeEntities(ld).replace(/\s+/g, " ").trim().slice(0, maxChars), finalUrl: page.finalUrl, method: "json_ld" };

  const clean = dropChrome(html);
  const pick = (tag: string): string | null => {
    const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(clean);
    if (!m) return null;
    const t = stripToText(m[1]);
    return t.length >= 300 ? t : null;
  };
  const fromArticle = pick("article");
  if (fromArticle) return { text: fromArticle.slice(0, maxChars), finalUrl: page.finalUrl, method: "article" };
  const fromMain = pick("main");
  if (fromMain) return { text: fromMain.slice(0, maxChars), finalUrl: page.finalUrl, method: "main" };
  const body = stripToText(clean);
  if (body.length >= 600) return { text: body.slice(0, maxChars), finalUrl: page.finalUrl, method: "body" };
  const meta = metaDescription(html);
  if (meta) return { text: meta.slice(0, maxChars), finalUrl: page.finalUrl, method: "meta" };
  return null;
}

/**
 * Feed item URL → { publisherUrl, text }. Google News links are decoded first;
 * anything else is fetched directly. Every step is best-effort.
 */

/**
 * Is this string usable as an article, or only feed scaffolding?
 *
 * Google News RSS items carry an `<a href="…">headline</a>` blob as their
 * description. Stored as a snippet it looks like text but contains no article.
 * Reading it produces a confident "no commercial event" — a false negative
 * dressed as a verdict, which §7 forbids. Anything that survives tag-stripping
 * with less than `minChars` of prose is not an article.
 */
export function readableArticleText(raw: string | null | undefined, minChars = 400): string | null {
  if (!raw) return null;
  const stripped = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length < minChars) return null;
  return raw.includes("<") ? stripped : raw.trim();
}

export async function retrieveArticle(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<{ publisherUrl: string | null; article: ArticleText | null }> {
  const publisherUrl = isGoogleNewsUrl(url) ? await resolveGoogleNewsUrl(url) : url;
  if (!publisherUrl) return { publisherUrl: null, article: null };
  const article = await fetchArticleText(publisherUrl, maxChars);
  return { publisherUrl, article };
}
