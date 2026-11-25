/**
 * Second opinion on "does this article really report this event?".
 *
 * sourceSupportsEvent (event-identity.ts) is a deterministic first pass: for a
 * contract or M&A event it wants the counterparty named in the HEADLINE. That
 * stops background mentions, but it also stops real events whenever the names
 * differ in form ("Amazon" for AWS, "Takeda" for Takeda Pharmaceuticals,
 * "Defense" for Ministry of Defense (Spain)) or the headline names only the
 * vendor. Measured on the 154 events it held between 21 and 25 November 2026,
 * 74 (48%) were properly supported by their article.
 *
 * So an event the first pass flags gets one independent model read of the
 * article, asked only whether the article reports the event as news or merely
 * mentions it. SUPPORTED lifts the flag; anything else, including any failure
 * of the check itself, leaves the event in review exactly as before. The check
 * can only ever relax a flag, never publish something the first pass passed.
 *
 * Sonnet, not Haiku: on the same 154, Haiku called 6 of 66 background mentions
 * supported and failed to answer 19 times.
 */
import { sourceSupportsEvent } from "../event-identity";
import { READER_MODEL, type GroundedEvent, type Reading } from "./reader";
import type { RawArticle } from "./crawler";

export const SOURCE_CHECK_VERSION = "source-check/1.0.0-2026-11-25";

const SYSTEM = [
  "You check whether a news article is a legitimate source for one extracted commercial event.",
  "Answer SUPPORTED when the article reports the event as news: it is the article's subject, or one of the deals or transactions the article itself announces or reports.",
  "Answer BACKGROUND when the event is only mentioned in passing, as history or context, as an example in an opinion or explainer, or when the article is about something else (a share-price move, scrutiny of an old contract, a general trend).",
  "Answer WRONG when the article does not actually say the event happened, or the parties are wrong.",
  "Reply with JSON only: {\"verdict\": \"SUPPORTED\"|\"BACKGROUND\"|\"WRONG\", \"why\": \"<12 words>\"}",
].join("\n");

/** The first-pass verdict, with the arguments store.ts has always used. */
export function firstPassSupports(article: RawArticle, text: string, reading: Reading, ev: GroundedEvent): boolean {
  return sourceSupportsEvent(
    { sourceTitle: article.title, sourceUrl: article.url, publisherUrl: article.publisherUrl, sourceType: article.sourceType, rawText: text },
    { family: ev.family, referenceTitle: ev.title ?? article.title, providerName: ev.provider, counterpartyNames: [ev.buyer], articleType: reading.articleType, eventQuote: ev.supporting.event },
  );
}

export interface SourceCheck { verdict: "SUPPORTED" | "BACKGROUND" | "WRONG" | "UNAVAILABLE"; why: string; costUsd: number }

export async function checkSource(ev: { title: string; quote: string | null }, article: { title: string; text: string }): Promise<SourceCheck> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { verdict: "UNAVAILABLE", why: "no API key", costUsd: 0 };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: READER_MODEL, max_tokens: 400,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: `Extracted event: ${ev.title}\nPassage the extractor relied on: ${ev.quote ?? "(none)"}\n\nArticle headline: ${article.title}\n\nArticle text:\n${article.text.slice(0, 14_000)}` }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return { verdict: "UNAVAILABLE", why: `HTTP ${res.status}`, costUsd: 0 };
    const d = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
    const u = d.usage ?? {};
    const costUsd = ((u.input_tokens ?? 0) * 2 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.cache_creation_input_tokens ?? 0) * 2.5 + (u.output_tokens ?? 0) * 10) / 1e6;
    const raw = (d.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
    const v = /"verdict"\s*:\s*"(SUPPORTED|BACKGROUND|WRONG)"/.exec(raw);
    const w = /"why"\s*:\s*"([^"]*)/.exec(raw);
    return { verdict: v ? v[1] as SourceCheck["verdict"] : "UNAVAILABLE", why: (w?.[1] ?? "unparsed answer").slice(0, 200), costUsd };
  } catch (err) {
    return { verdict: "UNAVAILABLE", why: err instanceof Error ? err.message.slice(0, 80) : "check failed", costUsd: 0 };
  }
}

/**
 * Check every event of a reading that the first pass would flag, and mark the
 * ones the article does support (ev.sourceConfirmed). Runs before the store
 * transaction, so no database lock is held across a model call. Returns the spend.
 */
export async function confirmFlaggedSources(article: RawArticle, text: string, reading: Reading): Promise<number> {
  const flagged = reading.events.filter(ev => !!ev.provider && !firstPassSupports(article, text, reading, ev));
  const checks = await Promise.all(flagged.map(ev => checkSource({ title: ev.title ?? article.title, quote: ev.supporting.event ?? null }, { title: article.title, text })));
  flagged.forEach((ev, i) => {
    ev.sourceCheck = { verdict: checks[i].verdict, why: checks[i].why };
    if (checks[i].verdict === "SUPPORTED") ev.sourceConfirmed = true;
  });
  return checks.reduce((s, c) => s + c.costUsd, 0);
}
