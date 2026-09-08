/**
 * Publication gate — evidence rules, not a confidence threshold.
 *
 * The previous gate published on `confidenceScore >= 0.72`. That score is the
 * model's estimate of extraction completeness: a well-attested award with an
 * undisclosed value scored ~0.55 and went to review, while nothing checked
 * whether the vendor resolved to an entity or the event type belonged to the
 * family. This gate asks the questions a reviewer asks; confidence only
 * matters when it is very low. Every routing to review carries the reasons.
 */
import { AWARD_EVIDENCE, OPPORTUNITY_ONLY } from "./sources";
import type { ExtractionResult } from "./classifier";
import type { RawArticle } from "./crawler";

/** Below this the model itself is unsure what the article is; a person decides. */
export const MIN_CONFIDENCE = 0.4;

import { COUNTERPARTY_FAMILIES } from "./dedup";
export { COUNTERPARTY_FAMILIES };

// A CONTRACT needs award language somewhere in the evidence (title, body,
// model summary). Wider than the title-only AWARD_EVIDENCE used in selection,
// because full text is available here and announcements say "agreement",
// "deal" or "selects" as often as "awarded".
// Retested 2026-09-08: the first version missed "delivers … to", "modernise",
// "orders", "migrates … to", "upgrades to", "moves … to", "to pay … for" —
// seven of fourteen gated contracts were real awards phrased that way.
const CONTRACT_EVIDENCE = /\b(agreement|deal|selects?|selected|chosen|choos(?:es|ing)|engag(?:es|ed|ement)|mandate|expan(?:sion|ds|ded)|renew(?:s|ed|al)|extend(?:s|ed)|extension|to (?:provide|deliver|support|manage|operate|build|run|modernis[ez]|implement|pay)|deliver(?:s|ed|ing|y of)|modernis(?:e|es|ed|ing|ation)|moderniz(?:e|es|ed|ing|ation)|orders?|migrat(?:es|ed|ion|ing)|upgrades? to|moves? .{0,40} to|implement(?:s|ed|ation)|deploy(?:s|ed|ment)|rolls? out|goes? live|taps|tapped|picks|hires|appoints|names? .{0,30} as|contract(?:s|ed)? (?:with|to|for|by|from)|partners? with|worth [$£€]|[$£€]\s?\d)\b/i;

// Stories ABOUT an existing contract — never an award.
const CONTRACT_NEGATIVE = /\b(axed|scrapped|terminat(?:ed|es|ion)|cancel(?:led|ed|s)|dispute|scrutiny|controversy|criticis(?:m|ed)|under fire|backlash|complaints?|watchdog|inquiry|report finds|fail(?:ed|ure|ing)|penalt(?:y|ies)|fined|lawsuit|sued|probe|investigat(?:ed|ion)|breach|delays?)\b/i;

export interface GateDecision {
  status: "published" | "needs_review";
  /** Comma-separated machine-readable reasons; null when published. */
  reason: string | null;
}

export function decidePublication(result: ExtractionResult, article: RawArticle, vendorId: string | null): GateDecision {
  const reasons: string[] = [];

  if (!result.eventTypeValid) reasons.push(`event_type_invalid:${result.eventType.slice(0, 40)}`);
  if (result.extractionMethod === "rules" || result.extractionMethod === "rule_fallback") reasons.push("rule_based_extraction");
  if (!vendorId) reasons.push("vendor_unresolved");
  if (COUNTERPARTY_FAMILIES.has(result.family) && !result.clientRaw?.trim()) reasons.push("no_counterparty");

  if (result.family === "CONTRACT") {
    // The model's own canonical title ("Vendor | New Win | Client | …") is evidence too — it was
    // omitted at first, so "Georgian Air Navigation awards €3.5M … to Indra" sat in review.
    const evidence = `${article.title}\n${result.canonicalTitle}\n${article.bodyText ?? article.snippet ?? ""}\n${result.summary ?? ""}`;
    if (!AWARD_EVIDENCE.test(evidence) && !CONTRACT_EVIDENCE.test(evidence)) reasons.push("no_award_language");
    if (OPPORTUNITY_ONLY.test(article.title) && !AWARD_EVIDENCE.test(article.title)) reasons.push("opportunity_not_award");
    // The model's own canonical label ("Vendor | Contract Scrutiny | …") is as telling as the headline.
    if (CONTRACT_NEGATIVE.test(article.title) || CONTRACT_NEGATIVE.test(result.canonicalTitle)) reasons.push("contract_dispute_or_termination");
  }

  if (result.confidenceScore < MIN_CONFIDENCE) reasons.push(`low_confidence:${result.confidenceScore.toFixed(2)}`);

  return reasons.length ? { status: "needs_review", reason: reasons.join(",") } : { status: "published", reason: null };
}
