/**
 * The review queue, read again in full by a stronger model and settled.
 *
 * Every event held for review is sent with its whole article (not the headline,
 * not the extractor's quote alone) and one question: what is this, really?
 *
 *   PUBLISH       the article reports the event as news and it is confirmed
 *                 (announced, completed, terminated or disputed). An unnamed
 *                 client is fine: it is published as undisclosed, coded by
 *                 region and industry.
 *   RUMOUR        reported but not confirmed by the parties (talks, exploring,
 *                 sources say, planned layoffs) — the Rumours view.
 *   OPPORTUNITY   a public tender, RFP, bid or shortlist.
 *   MENTION       a real event the article only mentions in passing — parked.
 *   NOT_EVENT     the article does not report this event, or it is not a
 *                 commercial event with the provider as a party — dismissed.
 *   NEEDS_PERSON  genuinely unclear; stays in review.
 *
 * The answer must quote the article; a quote that is not in the text sends the
 * item back to a person. Answers are cached per model in _scratch, so a pilot,
 * a comparison and the final run never pay twice for the same read.
 *
 * Pilot (synchronous calls, nothing written):
 *   npx tsx scripts/review-reread.ts --sample 30 --models opus,sonnet
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readableArticleText } from "@/lib/ingestion/article-text";
import { TRACKED_VENDORS } from "@/lib/ingestion/sources";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const SAMPLE = Number(arg("--sample", "30"));
const MODELS = arg("--models", "opus").split(",");
export const REREAD_VERSION = "review-reread/1.0.0-2026-11-27";

/** USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (read 2026-11-27). Batch halves both. */
const PRICES: Record<string, { id: string; input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  opus: { id: "claude-opus-5-5", input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  sonnet: { id: "claude-sonnet-5-5", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};

export const DECISIONS = ["PUBLISH", "RUMOUR", "OPPORTUNITY", "MENTION", "NOT_EVENT", "NEEDS_PERSON"] as const;
export const REGIONS = ["North America", "Latin America", "UK & Ireland", "Continental Europe", "Middle East & Africa", "India & South Asia", "Asia Pacific", "Australia & New Zealand", "Global"] as const;
/** The client-industry vocabulary the catalogue's contracts already use. */
export const INDUSTRIES = ["Public Sector", "BFSI", "Insurance", "Manufacturing & Automotive", "Aerospace & Defence", "Retail", "Consumer Goods", "Telecommunications", "Technology", "Media & Entertainment", "Energy & Resources", "Utilities", "Travel & transport", "Logistics/wholesale", "Healthcare - Public", "Healthcare - Private", "Pharmaceuticals", "Education - Public", "Education - Private", "Construction", "Professional Services", "Sports", "Associations and Non-Profit Organizations"] as const;
const FAMILIES = ["CONTRACT", "PARTNERSHIP", "M_AND_A", "NEW_OFFERING", "ORG_CHANGE", "FINANCIAL_RESULTS"];
const STATUSES = ["ANNOUNCED", "COMPLETED", "RUMOURED", "OPPORTUNITY", "TERMINATED", "DISPUTED"];

const SYSTEM = `You are a senior analyst settling items an automated pipeline held for human review in an IT-services market-intelligence catalogue. Each item is one event the pipeline extracted, with the full article it came from. Read the WHOLE article and decide what the item really is. Answer only from the article.

TRACKED PROVIDERS: ${TRACKED_VENDORS.join(", ")}

DECISION — exactly one:
- PUBLISH: the article reports this event as news (its subject, or one of the deals it announces), a tracked provider is a party, and the event is confirmed: announced, signed, completed, terminated or disputed. A client the article describes but does not name ("a leading European bank") is fine — publish it as undisclosed.
- RUMOUR: the event is reported but not confirmed or agreed by the parties: talks, "in discussions", "exploring a sale", "considering", unnamed sources, a report the company declined to confirm, planned layoffs or job cuts not yet announced. Families: M_AND_A, PARTNERSHIP, CONTRACT, ORG_CHANGE (layoffs).
- OPPORTUNITY: a public tender, RFP, bid or shortlist not yet awarded.
- MENTION: the event is real but this article only mentions it in passing (history, context, an example in an opinion piece, a share-price story).
- NOT_EVENT: the article does not report this event, the parties are wrong, or it is not a commercial event with a tracked provider as a party (marketing, award, ranking, research, a provider buying from its own supplier).
- NEEDS_PERSON: genuinely unclear from the article. Use sparingly.

Then correct the event as the article states it: family (${FAMILIES.join(" | ")}; layoffs and job cuts are ORG_CHANGE), eventStatus (${STATUSES.join(" | ")}), provider (exact spelling from the list), counterparty (the client, target or partner NAME, or null), counterpartyDescriptor (the article's description when unnamed), clientCountry, clientRegion (${REGIONS.join(" | ")}), clientIndustry (${INDUSTRIES.join(" | ")}, or null), and a title "Provider | Event type | Counterparty | Scope". Code region and industry for every client, named or not, when the article gives a basis; otherwise null.

quote: copy, verbatim, the passage (≤ 300 characters) that most directly supports your decision.

Reply with JSON only:
{"decision": "...", "family": "...", "eventStatus": "...", "provider": "...|null", "counterparty": "...|null", "counterpartyDescriptor": "...|null", "clientCountry": "...|null", "clientRegion": "...|null", "clientIndustry": "...|null", "title": "...", "quote": "...", "why": "≤25 words"}`;

/** Plain words for the pipeline's machine reasons, so the model knows what to check. */
function reasonWords(reason: string | null): string {
  const r = reason ?? "";
  const out: string[] = [];
  if (r.includes("event_source_mismatch")) out.push("the headline does not name the counterparty, so the article may only mention the event");
  if (r.includes("no_counterparty")) out.push("no client/counterparty was extracted");
  if (/opportunity_not_(award|event)/.test(r)) out.push("it looked like a tender or a deal not yet done");
  if (r.includes("no_event_status")) out.push("the event's status was unclear");
  if (r.includes("low_confidence")) out.push("the extraction was low-confidence");
  if (r.includes("possible_duplicate")) out.push("it may duplicate an existing event");
  if (r.includes("vendor_unresolved")) out.push("the provider could not be matched to the tracked list");
  if (r.includes("restored_from_estimator_demotion")) out.push("a value estimator said it may not be a client contract");
  if (/terminat|disput/.test(r)) out.push("it may be a termination or dispute");
  return out.length ? out.join("; ") : (r || "no reason recorded");
}

export interface Answer {
  decision: string; family: string | null; eventStatus: string | null; provider: string | null; counterparty: string | null;
  counterpartyDescriptor: string | null; clientCountry: string | null; clientRegion: string | null; clientIndustry: string | null;
  title: string | null; quote: string | null; why: string | null;
  grounded: boolean; costUsd: number; inputTokens: number; outputTokens: number; error?: string;
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim().toLowerCase();
const pick = <T extends string>(set: readonly T[], v: unknown): T | null => typeof v === "string" && (set as readonly string[]).includes(v) ? v as T : null;
const str = (v: unknown) => typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null;

export function userPrompt(e: Item): string {
  return `HELD EVENT
family: ${e.family} · status: ${e.eventStatus ?? "unknown"}
title: ${e.title}
provider: ${e.provider ?? "unmatched"} · counterparty: ${e.counterparty ?? e.descriptor ?? "none extracted"}
extractor's passage: ${e.quote ?? "(none)"}
held because: ${reasonWords(e.reason)}

ARTICLE HEADLINE: ${e.headline}
ARTICLE TEXT:
${e.text.slice(0, 60_000)}`;
}

export function requestParams(model: string, e: Item) {
  return { model: PRICES[model].id, max_tokens: 1500, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: userPrompt(e) }] };
}

export function parseAnswer(model: string, d: { content?: { type?: string; text?: string }[]; usage?: Record<string, number>; stop_reason?: string }, text: string, priceFactor = 1): Answer {
  const u = d.usage ?? {}, p = PRICES[model];
  const inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens = u.output_tokens ?? 0;
  const costUsd = priceFactor * ((u.input_tokens ?? 0) * p.input + (u.cache_read_input_tokens ?? 0) * p.cacheRead + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite + outputTokens * p.output) / 1e6;
  const base = { costUsd, inputTokens, outputTokens };
  const raw = (d.content ?? []).find(c => c.type === "text")?.text ?? "";
  const m = raw.match(/\{[\s\S]*\}/);
  let j: Record<string, unknown> = {};
  try { j = m ? JSON.parse(m[0]) : {}; } catch { /* unparsed */ }
  const decision = pick(DECISIONS, j.decision);
  if (!decision) return { decision: "NEEDS_PERSON", family: null, eventStatus: null, provider: null, counterparty: null, counterpartyDescriptor: null, clientCountry: null, clientRegion: null, clientIndustry: null, title: null, quote: null, why: null, grounded: false, ...base, error: d.stop_reason === "max_tokens" ? "truncated" : "unparsed" };
  const quote = str(j.quote);
  const grounded = !!quote && norm(text).includes(norm(quote).slice(0, 200));
  return {
    decision, family: pick(FAMILIES, j.family), eventStatus: pick(STATUSES, j.eventStatus), provider: str(j.provider),
    counterparty: str(j.counterparty), counterpartyDescriptor: str(j.counterpartyDescriptor), clientCountry: str(j.clientCountry),
    clientRegion: pick(REGIONS, j.clientRegion), clientIndustry: pick(INDUSTRIES, j.clientIndustry),
    title: str(j.title), quote, why: str(j.why), grounded, ...base,
  };
}

export interface Item { id: string; family: string; eventStatus: string | null; title: string; provider: string | null; counterparty: string | null; descriptor: string | null; quote: string | null; reason: string | null; headline: string; text: string }

/** Every review item with readable article text: the source with the longest readable text is the one read. */
export async function loadQueue(): Promise<{ items: Item[]; noText: number }> {
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "needs_review" },
    select: { id: true, family: true, eventStatus: true, canonicalTitle: true, counterpartyRaw: true, supportingText: true, reviewReason: true,
      primaryEntity: { select: { canonicalName: true } }, contractDetails: { select: { clientRaw: true, clientDescriptor: true } },
      sourceEvents: { select: { id: true }, take: 5 } },
  });
  const items: Item[] = [];
  let noText = 0;
  for (const r of rows) {
    const srcs = await prisma.sourceEvent.findMany({ where: { id: { in: r.sourceEvents.map(s => s.id) } }, select: { sourceTitle: true, rawText: true } });
    const best = srcs.map(s => ({ title: s.sourceTitle ?? "", text: readableArticleText(s.rawText) ?? "" })).sort((a, b) => b.text.length - a.text.length)[0];
    if (!best?.text) { noText++; continue; }
    let quote: string | null = null;
    try { quote = (JSON.parse(r.supportingText ?? "{}") as { event?: string }).event ?? null; } catch { /* none */ }
    items.push({ id: r.id, family: r.family, eventStatus: r.eventStatus, title: r.canonicalTitle, provider: r.primaryEntity?.canonicalName ?? null,
      counterparty: r.contractDetails?.clientRaw ?? r.counterpartyRaw, descriptor: r.contractDetails?.clientDescriptor ?? null, quote, reason: r.reviewReason, headline: best.title, text: best.text });
  }
  return { items, noText };
}

async function askNow(model: string, e: Item): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(requestParams(model, e)), signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return parseAnswer(model, await res.json(), e.text);
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    } catch (err) { if (attempt >= 3) throw err; }
    await new Promise(r => setTimeout(r, 5000 * attempt));
  }
}

async function pilot() {
  const { items, noText } = await loadQueue();
  console.log(`review queue: ${items.length + noText} items, ${items.length} with article text, ${noText} without (they stay for a person)`);
  // A spread sample: ordered by a hash of the id, so every reason group is represented without hand-picking.
  const sample = [...items].sort((a, b) => crypto.createHash("md5").update(a.id).digest("hex").localeCompare(crypto.createHash("md5").update(b.id).digest("hex"))).slice(0, SAMPLE);
  const answers: Record<string, Record<string, Answer>> = {};
  for (const model of MODELS) {
    const file = `_scratch/review-reread-${model}.json`;
    const cache: Record<string, Answer> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const todo = sample.filter(e => !cache[e.id]);
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (;;) {
        const e = todo[next++];
        if (!e) return;
        try { cache[e.id] = await askNow(model, e); }
        catch (err) { console.error(`  ${model} ${e.id}: ${String(err).slice(0, 160)}`); }
      }
    }));
    fs.writeFileSync(file, JSON.stringify(cache));
    answers[model] = cache;
    const got = sample.map(e => cache[e.id]).filter(Boolean);
    const cost = got.reduce((s, a) => s + a.costUsd, 0), inTok = got.reduce((s, a) => s + a.inputTokens, 0), outTok = got.reduce((s, a) => s + a.outputTokens, 0);
    const tally: Record<string, number> = {};
    for (const a of got) tally[a.decision] = (tally[a.decision] ?? 0) + 1;
    console.log(`\n${model} (${PRICES[model].id}): ${got.length} answered · $${cost.toFixed(2)} ($${(cost / Math.max(1, got.length)).toFixed(4)}/item, sync price) · avg ${Math.round(inTok / Math.max(1, got.length))} in / ${Math.round(outTok / Math.max(1, got.length))} out tokens`);
    console.log(`  decisions: ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")} · quote found in article: ${got.filter(a => a.grounded).length}/${got.length}`);
    console.log(`  whole queue (${items.length}) at batch price ≈ $${(cost / Math.max(1, got.length) * items.length * 0.5).toFixed(2)}`);
  }
  if (MODELS.length > 1) {
    const [a, b] = MODELS;
    const both = sample.filter(e => answers[a][e.id] && answers[b][e.id]);
    const agree = both.filter(e => answers[a][e.id].decision === answers[b][e.id].decision).length;
    console.log(`\n${a} and ${b} agree on ${agree} of ${both.length} decisions`);
  }
  console.log("");
  for (const e of sample) {
    console.log(`• [${e.family}] ${e.title.slice(0, 110)}\n    held: ${reasonWords(e.reason).slice(0, 120)}`);
    for (const model of MODELS) {
      const x = answers[model][e.id];
      if (!x) { console.log(`    ${model.padEnd(6)} (no answer)`); continue; }
      const client = x.counterparty ?? (x.counterpartyDescriptor ? `undisclosed: ${x.counterpartyDescriptor}` : "-");
      console.log(`    ${model.padEnd(6)} ${x.decision}${x.grounded ? "" : " (quote not found)"} · ${x.family ?? "?"}/${x.eventStatus ?? "?"} · ${client.slice(0, 50)} · ${x.clientRegion ?? "-"} · ${x.clientIndustry ?? "-"} — ${x.why ?? x.error ?? ""}`);
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}

// ── Whole queue: Batch API (half price), then apply ─────────────────────────

const BATCH_API = "https://api.anthropic.com/v1/messages/batches";
const headers = () => ({ "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const MODEL = MODELS[0];
const CACHE = `_scratch/review-reread-${MODEL}.json`;
const STATE = `_scratch/review-reread-batch-${MODEL}.json`;
const loadCache = (): Record<string, Answer> => fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};

/** Read every queue item that has no answer yet, through the Batch API, under a hard cap. */
async function runBatch(budget: number) {
  const { items, noText } = await loadQueue();
  const cache = loadCache();
  const done = Object.values(cache);
  const perItem = done.length ? done.reduce((s, a) => s + a.costUsd, 0) / done.length : 0.03;
  const todo = items.filter(e => !cache[e.id]);
  const projected = todo.length * perItem * 0.5;
  console.log(`queue ${items.length + noText}: ${items.length} with text (${items.length - todo.length} already read), ${noText} without · to read ${todo.length} · projected $${projected.toFixed(2)} at batch price (cap $${budget})`);
  if (projected > budget * 0.9) { console.log("projection exceeds the cap; nothing submitted"); return; }
  const state: { batches: { id: string; ids: string[]; collected?: boolean }[] } = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { batches: [] };
  const byId = new Map(items.map(e => [e.id, e]));
  const inFlight = new Set(state.batches.filter(b => !b.collected).flatMap(b => b.ids));
  const fresh = todo.filter(e => !inFlight.has(e.id));
  for (let i = 0; i < fresh.length; i += 200) {
    const chunk = fresh.slice(i, i + 200);
    const res = await fetch(BATCH_API, { method: "POST", headers: headers(), body: JSON.stringify({ requests: chunk.map(e => ({ custom_id: e.id, params: requestParams(MODEL, e) })) }) });
    const body = await res.text();
    if (!res.ok) throw new Error(`batch submit HTTP ${res.status}: ${body.slice(0, 200)}`);
    const id = (JSON.parse(body) as { id: string }).id;
    state.batches.push({ id, ids: chunk.map(e => e.id) });
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`submitted ${id}: ${chunk.length}`);
  }
  let spent = 0;
  for (const b of state.batches.filter(x => !x.collected)) {
    let url: string | null = null;
    for (;;) {
      const s = await (await fetch(`${BATCH_API}/${b.id}`, { headers: headers() })).json() as { processing_status: string; results_url: string | null; request_counts: Record<string, number> };
      if (s.processing_status === "ended" && s.results_url) { url = s.results_url; break; }
      console.log(`  ${b.id} ${s.processing_status} ${JSON.stringify(s.request_counts)}`);
      await sleep(30_000);
    }
    const lines = (await (await fetch(url, { headers: headers() })).text()).split("\n").filter(l => l.trim());
    for (const line of lines) {
      const r = JSON.parse(line) as { custom_id: string; result: { type: string; message?: Parameters<typeof parseAnswer>[1] } };
      const e = byId.get(r.custom_id);
      if (!e || r.result.type !== "succeeded" || !r.result.message) continue;
      cache[r.custom_id] = parseAnswer(MODEL, r.result.message, e.text, 0.5);
      spent += cache[r.custom_id].costUsd;
    }
    b.collected = true;
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    fs.writeFileSync(STATE, JSON.stringify(state));
    console.log(`collected ${b.id}: ${lines.length} answers · $${spent.toFixed(2)} so far`);
  }
  console.log(`read complete · this run $${spent.toFixed(2)}`);
}

/** Country names as an adjective a reader expects in "a US telecoms client". */
const PLACE: Record<string, string> = {
  "United States": "US", "USA": "US", "US": "US", "United Kingdom": "UK", "UK": "UK", "Great Britain": "UK", "United Arab Emirates": "UAE", "UAE": "UAE",
  Germany: "German", France: "French", Spain: "Spanish", Italy: "Italian", Netherlands: "Dutch", Belgium: "Belgian", Sweden: "Swedish", Norway: "Norwegian",
  Denmark: "Danish", Finland: "Finnish", Switzerland: "Swiss", Austria: "Austrian", Ireland: "Irish", Poland: "Polish", Portugal: "Portuguese",
  Canada: "Canadian", Mexico: "Mexican", Brazil: "Brazilian", Argentina: "Argentine", Chile: "Chilean", India: "Indian", Japan: "Japanese", China: "Chinese",
  Singapore: "Singaporean", Australia: "Australian", "New Zealand": "New Zealand", "Saudi Arabia": "Saudi", "South Africa": "South African", Israel: "Israeli",
  "South Korea": "South Korean", Malaysia: "Malaysian", Indonesia: "Indonesian", Philippines: "Philippine", Qatar: "Qatari", Turkey: "Turkish",
};
const REGION_WORD: Record<string, string> = {
  "North America": "North American", "Latin America": "Latin American", "UK & Ireland": "UK", "Continental Europe": "European", "Middle East & Africa": "Middle East and Africa",
  "India & South Asia": "South Asian", "Asia Pacific": "Asia-Pacific", "Australia & New Zealand": "Australian and New Zealand", "Global": "global",
};
const INDUSTRY_WORD: Record<string, string> = {
  "Public Sector": "public-sector", BFSI: "financial services", Insurance: "insurance", "Manufacturing & Automotive": "manufacturing", "Aerospace & Defence": "aerospace and defence",
  Retail: "retail", "Consumer Goods": "consumer goods", Telecommunications: "telecoms", Technology: "technology", "Media & Entertainment": "media", "Energy & Resources": "energy",
  Utilities: "utility", "Travel & transport": "travel and transport", "Logistics/wholesale": "logistics", "Healthcare - Public": "public healthcare", "Healthcare - Private": "healthcare",
  Pharmaceuticals: "pharmaceutical", "Education - Public": "education", "Education - Private": "education", Construction: "construction", "Professional Services": "professional services",
  Sports: "sports", "Associations and Non-Profit Organizations": "non-profit",
};
/** An unnamed client, named by where it is and what it does: "a US telecoms client". Null when neither is known. */
export function clientLabel(a: Pick<Answer, "clientCountry" | "clientRegion" | "clientIndustry">): string | null {
  const place = (a.clientCountry && PLACE[a.clientCountry]) ?? (a.clientRegion ? REGION_WORD[a.clientRegion] : null);
  const what = a.clientIndustry ? INDUSTRY_WORD[a.clientIndustry] : null;
  if (!place && !what) return null;
  const words = [place, what, "client"].filter(Boolean).join(" ");
  return `${/^[aeiou]/i.test(words) && !/^(US|UK|UAE|Eu|Uni)/.test(words) ? "an" : "a"} ${words}`;
}

const PARKED = "parked";
const ACTION = "review_reread";

/** What each answer does to its event. Family changes are left to a person: they move an event between detail tables. */
function plan(e: { family: string }, a: Answer | undefined): { to: "published" | "rumour" | "parked" | "excluded" | "keep"; why: string } {
  if (!a) return { to: "keep", why: "not read" };
  if (a.error) return { to: "keep", why: `answer ${a.error}` };
  if (!a.grounded) return { to: "keep", why: "quote not found in the article" };
  if (a.decision === "NOT_EVENT") return { to: "excluded", why: a.why ?? "" };
  if (a.decision === "MENTION") return { to: "parked", why: a.why ?? "" };
  if (a.decision === "NEEDS_PERSON" || a.decision === "OPPORTUNITY") return { to: "keep", why: `${a.decision.toLowerCase()}: ${a.why ?? ""}` };
  if (a.family && a.family !== e.family) return { to: "keep", why: `family should be ${a.family}: ${a.why ?? ""}` };
  if (a.decision === "RUMOUR") return { to: "rumour", why: a.why ?? "" };
  return { to: "published", why: a.why ?? "" };
}

async function apply(write: boolean) {
  const cache = loadCache();
  const ids = Object.keys(cache);
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { id: { in: ids }, publicationStatus: "needs_review" },
    select: { id: true, family: true, publicationStatus: true, reviewReason: true, humanReviewRequired: true, eventStatus: true, canonicalTitle: true, counterpartyRaw: true, industry: true, geography: true,
      contractDetails: { select: { clientRaw: true, clientDescriptor: true, clientAnonymised: true, clientIndustry: true } }, maDetails: { select: { targetRaw: true } }, partnershipDetails: { select: { entityBRaw: true } } },
  });
  const tally: Record<string, number> = {};
  const labels: string[] = [];
  for (const r of rows) {
    const a = cache[r.id];
    const p = plan(r, a);
    tally[p.to] = (tally[p.to] ?? 0) + 1;
    if (!write || p.to === "keep") {
      if (write) await prisma.reviewAction.create({ data: { eventId: r.id, action: ACTION, reviewerNote: `${REREAD_VERSION} ${MODEL} keep: ${p.why}`.slice(0, 500), previousValue: null, newValue: "needs_review" } });
      continue;
    }
    const before = { publicationStatus: r.publicationStatus, reviewReason: r.reviewReason, humanReviewRequired: r.humanReviewRequired, eventStatus: r.eventStatus, canonicalTitle: r.canonicalTitle,
      counterpartyRaw: r.counterpartyRaw, industry: r.industry, geography: r.geography, contractDetails: r.contractDetails, maDetails: r.maDetails, partnershipDetails: r.partnershipDetails };
    const note = `${REREAD_VERSION} ${MODEL} ${a.decision}: ${p.why}`.slice(0, 500);
    await prisma.$transaction(async tx => {
      if (p.to === "excluded" || p.to === "parked") {
        await tx.canonicalMarketEvent.update({ where: { id: r.id }, data: { publicationStatus: p.to === "parked" ? PARKED : "excluded_noise", humanReviewRequired: false,
          reviewReason: p.to === "parked" ? "mention_only" : `reread_not_event` } });
      } else {
        const named = a.counterparty;
        const label = named ? null : clientLabel(a) ?? a.counterpartyDescriptor;
        if (label && !named) labels.push(label);
        const geo: string[] = (() => { try { return JSON.parse(r.geography) as string[]; } catch { return []; } })();
        for (const g of [a.clientCountry, a.clientRegion]) if (g && !geo.includes(g)) geo.push(g);
        const title = a.title && !named && label ? a.title.replace(/\|\s*[^|]*(undisclosed|unnamed|not named|confidential)[^|]*\|/i, `| ${label[0].toUpperCase()}${label.slice(1)} |`) : a.title;
        await tx.canonicalMarketEvent.update({ where: { id: r.id }, data: {
          publicationStatus: "published", humanReviewRequired: false, reviewReason: null,
          eventStatus: p.to === "rumour" ? "RUMOURED" : (a.eventStatus ?? r.eventStatus),
          canonicalTitle: (title ?? r.canonicalTitle).slice(0, 500),
          counterpartyRaw: r.counterpartyRaw ?? named,
          industry: r.industry ?? a.clientIndustry, geography: JSON.stringify(geo),
        } });
        if (r.contractDetails) await tx.contractDetails.update({ where: { canonicalEventId: r.id }, data: {
          clientRaw: r.contractDetails.clientRaw ?? named,
          clientAnonymised: !(r.contractDetails.clientRaw ?? named),
          clientDescriptor: (r.contractDetails.clientRaw ?? named) ? r.contractDetails.clientDescriptor : (label ?? r.contractDetails.clientDescriptor),
          clientIndustry: a.clientIndustry ?? r.contractDetails.clientIndustry,
        } });
        if (r.maDetails && !r.maDetails.targetRaw && named) await tx.maDetails.update({ where: { canonicalEventId: r.id }, data: { targetRaw: named } });
        if (r.partnershipDetails && !r.partnershipDetails.entityBRaw && named) await tx.partnershipDetails.update({ where: { canonicalEventId: r.id }, data: { entityBRaw: named } });
      }
      await tx.reviewAction.create({ data: { eventId: r.id, action: ACTION, reviewerNote: note, previousValue: JSON.stringify(before).slice(0, 8000), newValue: p.to } });
    });
  }
  console.log(`${write ? "applied" : "plan"} (${rows.length} answered items still in review): ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (labels.length) console.log(`undisclosed clients labelled, e.g.: ${[...new Set(labels)].slice(0, 12).join("; ")}`);
}

/** Reverses every change this script made, from the logged previous values. */
async function undo() {
  const acts = await prisma.reviewAction.findMany({ where: { action: ACTION, previousValue: { not: null } }, orderBy: { createdAt: "desc" } });
  let n = 0;
  for (const act of acts) {
    const b = JSON.parse(act.previousValue!);
    await prisma.$transaction(async tx => {
      await tx.canonicalMarketEvent.update({ where: { id: act.eventId }, data: { publicationStatus: b.publicationStatus, reviewReason: b.reviewReason, humanReviewRequired: b.humanReviewRequired,
        eventStatus: b.eventStatus, canonicalTitle: b.canonicalTitle, counterpartyRaw: b.counterpartyRaw, industry: b.industry, geography: b.geography } });
      if (b.contractDetails) await tx.contractDetails.update({ where: { canonicalEventId: act.eventId }, data: b.contractDetails });
      if (b.maDetails) await tx.maDetails.update({ where: { canonicalEventId: act.eventId }, data: b.maDetails });
      if (b.partnershipDetails) await tx.partnershipDetails.update({ where: { canonicalEventId: act.eventId }, data: b.partnershipDetails });
      await tx.reviewAction.update({ where: { id: act.id }, data: { previousValue: null, newValue: `undone:${act.newValue}` } });
    });
    n++;
  }
  console.log(`undone: ${n}`);
}

async function main() {
  if (process.argv.includes("--undo")) await undo();
  else if (process.argv.includes("--run")) { await runBatch(Number(arg("--budget", "0"))); await apply(process.argv.includes("--apply")); }
  else if (process.argv.includes("--plan")) await apply(false);
  else return pilot();
  await prisma.$disconnect();
  process.exit(0);
}

if (process.argv[1]?.endsWith("review-reread.ts")) main();
