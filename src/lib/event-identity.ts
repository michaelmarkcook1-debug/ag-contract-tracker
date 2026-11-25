import { mentionsParty, sourceMatchesReference, type SourceAuthorityInput, type SourcePreferenceContext } from "./source-authority";
import { matchTrackedVendorPreferring } from "./ingestion/sources";

export interface EventSourceContext extends SourcePreferenceContext {
  family: string;
  articleType?: string | null;
  eventQuote?: string | null;
}

const tidy = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const background = /\b(?:previously|historically|at the time|back in|at that time|in the past|years? ago|last year|prior years?|former(?:ly)?|in (?:19|20)\d\d)\b/i;
const award = /\b(?:awarded|award(?:ed)? (?:us|to)|won|wins?|selected|chosen|picked|appointed|signed|signs|secured|renew(?:ed|s)|extend(?:ed|s)|expan(?:ded|ds)|new (?:engagement|contract|deal|mandate|award)|contract wins?)\b/i;
const notAward = /\b(?:previously|existing (?:deal|award|contract)|may win|could win|did not|has not|not been|lost|compet(?:ing|ed) for|hopes? to|bid for|shortlist|potential win)\b/i;
const resultsTitle = /\b(?:earnings|financial results|quarterly results|quarter(?:ly)? (?:report|results)|annual report|(?:Q[1-4]|FY\d+) results)\b/i;
const resultsSource = /^(?:annual_report|quarterly_results|earnings_(?:release|presentation|transcript))$/i;
const official = /^(?:company_press_release|vendor_press_release|official_provider_website|investor_relations_release|regulatory_filing|sec_filing)$/i;
const multipleAwards = /\b(?:two|three|four|multiple|several|\d+)(?:\s+[\w-]+){0,3}\s+(?:wins|deals|awards|contracts)\b/i;
const named = (values: SourcePreferenceContext["counterpartyNames"]) =>
  (values ?? []).filter((n): n is string => !!n?.trim() && !/^(?:an? |unknown\b|unnamed\b|undisclosed\b|not (?:specified|disclosed|named)\b)/i.test(n));

/** Source identity is separate from authority and model confidence. A feed label is not evidence. */
export function sourceSupportsEvent(source: SourceAuthorityInput, ctx: EventSourceContext): boolean {
  const provider = ctx.providerName?.trim();
  const title = source.sourceTitle ?? "";
  const body = source.rawText ?? "";
  const quote = ctx.eventQuote?.trim();
  const supportsProvider = (s: string) => !!provider &&
    (mentionsParty(s, provider) || matchTrackedVendorPreferring(s, [provider]) === provider);
  if (!supportsProvider(title) && !supportsProvider(quote || body)) return false;
  if (ctx.family !== "CONTRACT" && ctx.family !== "M_AND_A") return true;
  const parties = named(ctx.counterpartyNames);
  if (!parties.length) return true; // No named buyer to compare; the normal grounding/publication gate still applies.
  if (!ctx.referenceTitle?.trim()) return false;
  const direct = sourceMatchesReference(source, ctx);
  const titleIsResults = resultsTitle.test(title) || ctx.articleType?.toUpperCase() === "EARNINGS";
  if (direct && !(ctx.family === "CONTRACT" && titleIsResults)) {
    if (ctx.family === "CONTRACT" && quote && background.test(quote) && !award.test(title)) return false;
    return true;
  }
  if (ctx.family !== "CONTRACT") return false;

  const type = source.sourceType ?? "";
  const results = resultsSource.test(type) || (official.test(type) && titleIsResults);
  if (!results && !multipleAwards.test(title)) return false;
  // Check individual passages, not "buyer anywhere + win anywhere". A legacy
  // extraction may have no quote; inspect the actual sentences in that case.
  const normalized = tidy(body);
  if (quote && !normalized.includes(tidy(quote))) return false;
  return body.split(/(?<=[.!?])\s+(?=[A-Z"'])|[;\n]+/).some(sentence => {
    if (sentence.length > 1200 || (quote && !tidy(quote).includes(tidy(sentence)) && !tidy(sentence).includes(tidy(quote)))) return false;
    return parties.some(p => mentionsParty(sentence, p)) && award.test(sentence) &&
      !background.test(sentence) && !notAward.test(sentence) &&
      (supportsProvider(sentence) || (supportsProvider(title) && (/\b(?:we|our|us|it has been selected|it was selected)\b/i.test(sentence))));
  });
}

export interface TransactionRecord {
  family: string;
  canonicalTitle: string;
  provider: string | null;
  target?: string | null;
  announcementDate: Date | string | null;
  /** An event-specific passage, not concatenated article bodies. */
  evidenceText?: string | null;
  eventStatus?: string | null;
  eventType?: string | null;
  stakePercent?: number | null;
}

export const TRANSACTION_WINDOW_DAYS = 180;
export function normalizeEntityName(s: string) {
  return tidy(s).normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function targetKey(value: string, passage: string): string | null {
  const name = normalizeEntityName(value).replace(/\s+(?:ltd|limited|plc|llc|corp|inc|gmbh)$/u, "");
  if (!name || /^(?:unknown|unnamed|undisclosed|target|company|business|subsidiary|it unit|an? |the company\b)/.test(name)) return null;
  if (/^(?:porsche mhp|mhp(?: porsche subsidiary| from porsche| management und it beratung)?)$/.test(name)) return "mhp";
  if (/^porsche(?: s)? (?:it|consulting|it consulting) (?:unit|business)$/.test(name) && /\bmhp\b/i.test(passage)) return "mhp";
  return name;
}
type Stage = "reported" | "announced" | "completed" | "regulatory" | "withdrawn";
export function transactionStage(text: string): Stage | null {
  if (/\b(?:abandon(?:ed|s)?|withdraw(?:n|s)?|called off|terminat(?:ed|es))\b/i.test(text)) return "withdrawn";
  if (/\b(?:talks|rumou?rs?|rumou?red|considering|explor(?:es?|atory|ing)|reportedly|mulls?|eyes?|weighs?|may (?:buy|acquire)|could (?:buy|acquire))\b/i.test(text)) return "reported";
  if (/\b(?:regulat\w+|commission|antitrust|cci|court)\b.{0,50}\b(?:approv\w+|clear\w+|sanction\w+|block\w+)\b/i.test(text)) return "regulatory";
  // A future closing date in a signed agreement is not a second, completed stage.
  const current = text.replace(/\b(?:expected|scheduled|plans?|set|agrees?|intends?) to (?:be )?(?:close[d]?|complete[d]?)\b|\bto (?:close|complete)\b/gi, "");
  if (/\b(?:completes?|completed|completion|closes|closed|closing of|finali[sz](?:es|ed)|acquired)\b/i.test(current)) return "completed";
  if (/\b(?:announc\w*|pending|proposed|agrees?|agreement|acquires?|acquisition|buys?|purchase|divest\w*|sell[s]?|merg\w+)\b/i.test(text)) return "announced";
  return null;
}
const hasAcquisition = /\b(?:acqui(?:res?|red|ring|sition)|buys?|bought|buyout|purchas(?:e|es|ed))\b/i;
const hasSale = /\b(?:divest\w*|sells?|sold|sale of|spin[- ]?off|disposal)\b/i;
const hasMerger = /\bmerg(?:e|es|ed|er|ing)\b/i;
const stagesFromStatus: Record<string, Stage> = { COMPLETED: "completed", OPPORTUNITY: "reported", TERMINATED: "withdrawn" };

function priceAnchors(text: string): Set<string> {
  const result = new Set<string>();
  const re = /(?:\b(USD|GBP|EUR|CAD|AUD|INR)|([$£€]))\s*([\d,]+(?:\.\d+)?)\s*(billion|million|crore|bn|mn|m|b|k)?\b/gi;
  for (const m of text.matchAll(re)) {
    // Earnings, headcount costs, turnover and a target's market cap are not
    // consideration, even if every article about that target repeats them.
    const before = text.slice(0, m.index).split(/[|;\n]/).pop() ?? "";
    const after = text.slice(m.index + m[0].length);
    const consideration = /\b(?:deal (?:worth|valued at)|(?:purchase|acquisition) price (?:of|is)|consideration (?:of|is))\s*$/i.test(before)
      || (/\bfor\s+(?:(?:about|approximately|up to|around)\s+)?$/i.test(before) && (hasAcquisition.test(before) || hasSale.test(before) || hasMerger.test(before)))
      || /^\s+(?:cash )?(?:acquisition|purchase|buyout|merger|deal)\b/i.test(after);
    if (!consideration || /^\s+(?:in (?:annual )?(?:revenue|sales|turnover|earnings)|(?:annual )?(?:revenue|sales|turnover|earnings))\b/i.test(after)) continue;
    const currency = m[1]?.toUpperCase() ?? ({ "$": "$", "£": "GBP", "€": "EUR" }[m[2]]);
    const unit = (m[4] ?? "").toLowerCase();
    const value = Number(m[3].replace(/,/g, "")) * (/^(billion|bn|b)$/.test(unit) ? 1e9 : /^(million|mn|m)$/.test(unit) ? 1e6 : unit === "crore" ? 1e7 : unit === "k" ? 1e3 : 1);
    if (value > 0) result.add(currency + ":" + value);
  }
  return result;
}

export function transactionIdentity(row: TransactionRecord) {
  if (row.family !== "M_AND_A" || !row.provider?.trim()) return null;
  const provider = normalizeEntityName(row.provider).replace(/^tata consultancy services(?: limited)?$/, "tcs");
  const parts = row.canonicalTitle.split("|");
  const target = row.target?.trim() || parts[2]?.trim() ||
    /\b(?:to acquire|acquires?|acquisition of|buys?|purchase of)\s+(.+?)(?=\s+(?:from|for|to)\b|[;|]|$)/i.exec(row.canonicalTitle)?.[1];
  if (!target) return null;
  const quote = row.evidenceText?.trim() ?? "";
  const targetName = targetKey(target, quote);
  if (!targetName) return null;
  // Only use a short passage naming the specific target; unrelated numbers or
  // stages elsewhere in an earnings release are not transaction attributes.
  const passage = quote.length <= 600 && (mentionsParty(quote, target) || mentionsParty(quote, targetName)) ? quote : "";
  const text = [row.canonicalTitle, passage].join(" | ").replace(/_/g, " ");
  const components = text.split("|");
  const stages = new Set(components.map(transactionStage).filter(s => s && s !== "announced"));
  if (stages.size > 1) return null;
  const kindText = text + " " + (row.eventType ?? "");
  const kinds = [hasSale.test(kindText) && "sale", hasMerger.test(kindText) && "merger", hasAcquisition.test(kindText) && "purchase"].filter(Boolean);
  if (kinds.length !== 1) return null;
  const stage = transactionStage(text);
  const status = stagesFromStatus[(row.eventStatus ?? "").toUpperCase()];
  if (!stage || (status && stage !== status)) return null;
  const stakes = new Set([...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|per\s*cent\b)/gi)].map(m => Number(m[1])));
  if (row.stakePercent != null) stakes.add(row.stakePercent);
  const tranche = new Set([...text.matchAll(/\b(minority|majority|remaining|additional|initial|controlling|non-controlling|first tranche|second tranche|full ownership|wholly owned)\b/gi)].map(m => m[0].toLowerCase()));
  const prices = priceAnchors(text);
  const codes = new Set([...text.matchAll(/\b(?:transaction|deal|filing)\s+(?:ref(?:erence)?|id|no\.)\s*[:#]?\s*([a-z\d][a-z\d-]*\d[a-z\d-]*)\b/gi)].map(m => m[1].toLowerCase()));
  // A named seller is a third party specific to the deal, not the seller's
  // generic role ("from its parent company"). Do not infer it from a group name.
  const sellers = new Set(components.flatMap(part => [...part.matchAll(/\bfrom ([A-Z][\w&.-]*(?: [A-Z][\w&.-]*){0,3})/g)]
    .filter(m => hasAcquisition.test(part.slice(0, m.index)) && !/\b(?:revenue|sales|turnover|earnings|clients?)\b/i.test(part.slice(0, m.index)))
    .map(m => normalizeEntityName(m[1])))
    .filter(n => !/^(?:the|its|a|an|group|company|parent|shareholders)\b/i.test(n)));
  if ([prices, stakes, codes, sellers].some(s => s.size > 1)) return null;
  return { provider, target: targetName, kind: kinds[0], stage, stake: [...stakes][0] ?? null, tranche: [...tranche].sort().join("|"), partial: /\b(?:stake|interest|shares)\b/i.test(text), price: [...prices][0] ?? null, code: [...codes][0] ?? null, seller: [...sellers][0] ?? null };
}

/** The time window is a search bound, never affirmative identity evidence. */
export function sameTransaction(a: TransactionRecord, b: TransactionRecord): boolean {
  const x = transactionIdentity(a), y = transactionIdentity(b);
  if (!x || !y || x.provider !== y.provider || x.target !== y.target || x.kind !== y.kind || x.stage !== y.stage) return false;
  if (!a.announcementDate || !b.announcementDate) return false;
  const days = Math.abs(new Date(a.announcementDate).getTime() - new Date(b.announcementDate).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days > TRANSACTION_WINDOW_DAYS) return false;
  if (x.stake !== y.stake || x.tranche !== y.tranche || x.partial !== y.partial) return false;
  for (const k of ["code", "price", "seller"] as const) if (x[k] && y[k] && x[k] !== y[k]) return false;
  return (x.code !== null && x.code === y.code) || (x.price !== null && x.price === y.price) ||
    (x.seller !== null && x.seller === y.seller && x.seller !== x.provider && x.seller !== x.target);
}

export interface ContractObservation {
  type: string;
  status?: string | null;
  provider: string | null;
  buyer: string | null;
  descriptor?: string | null;
  scope?: string | null;
  passage?: string | null;
  title?: string | null;
  amountUsd?: number | null;
  duration?: number | null;
}
const scopeNoise = new Set(("the and for from with into under over this that their will was were has been have which " +
  "year years five three four multi new contract awarded award awards win wins won agreement deal announces announced signs signed " +
  "selected service services provider client company companies business managed managing management platform digital technology " +
  "technologies transformation solutions global operations support delivery delivering deliver provide providing million billion " +
  "modernise modernize modernisation modernization infrastructure outsourcing systems applications cloud application data strategic").split(" "));
function scopeWords(row: ContractObservation) {
  const parties = new Set(normalizeEntityName([row.provider, row.buyer, row.descriptor].filter(Boolean).join(" ")).split(" "));
  return new Set(normalizeEntityName([row.scope, row.passage, row.title].filter(Boolean).join(" ")).split(" ")
    .filter(w => w.length >= 4 && !/\d/.test(w) && !scopeNoise.has(w) && !parties.has(w)));
}
function awardRefs(row: ContractObservation) {
  return new Set([...([row.passage, row.title, row.scope].join(" ")).matchAll(/\b(?:award|contract|procurement|tender)\s+(?:ref(?:erence)?|id|no\.?)\s*[:#]?\s*([a-z\d][a-z\d/-]*\d[a-z\d/-]*)\b/gi)].map(m => m[1].toLowerCase()));
}
function orgKey(name: string) {
  return normalizeEntityName(name).replace(/\b(?:inc|incorporated|ltd|limited|plc|llc|corp|corporation|gmbh|ag)\b/g, "").replace(/\s+/g, " ").trim();
}
/** Compare only inside a provider/date candidate set. A monthly key, buyer or boilerplate passage is not a deal ID. */
export function sameContract(a: ContractObservation, b: ContractObservation): boolean {
  if (!a.type || ["unknown", "other_commercial_event"].includes(a.type.toLowerCase()) || a.type.toLowerCase() !== b.type.toLowerCase()) return false;
  if (a.status && b.status && a.status.toLowerCase() !== b.status.toLowerCase()) return false;
  if (!a.provider || !b.provider || orgKey(a.provider) !== orgKey(b.provider)) return false;
  if (a.buyer || b.buyer) {
    if (!a.buyer || !b.buyer || !orgKey(a.buyer) || orgKey(a.buyer) !== orgKey(b.buyer)) return false;
  } else if (!a.descriptor || !b.descriptor || orgKey(a.descriptor) !== orgKey(b.descriptor)) return false;
  if (a.amountUsd != null && b.amountUsd != null && a.amountUsd !== b.amountUsd) return false;
  if (a.duration != null && b.duration != null && a.duration !== b.duration) return false;
  const refs = awardRefs(a), priorRefs = awardRefs(b);
  if (refs.size || priorRefs.size) return refs.size === 1 && priorRefs.size === 1 && priorRefs.has([...refs][0]);
  const x = scopeWords(a), y = scopeWords(b);
  const overlap = [...x].filter(w => y.has(w)).length;
  if (overlap < 2) return false;
  const exactPassage = !!a.passage && !!b.passage && tidy(a.passage) === tidy(b.passage) && tidy(a.passage).split(" ").length >= 10;
  return exactPassage || (a.amountUsd != null && a.amountUsd > 0 && a.amountUsd === b.amountUsd && overlap / Math.min(x.size, y.size) >= 0.5);
}
