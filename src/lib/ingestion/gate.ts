/**
 * Publication gate — decides on what the model read, not on regexes.
 *
 * The model reports what kind of article it saw (articleType) and the status
 * of the event it describes (eventStatus). The gate publishes an event the
 * text supports and routes to review the cases a person should look at, with
 * the reasons recorded. Confidence only matters when it is very low.
 */
import type { ExtractionResult } from "./classifier";

/** Below this the model itself is unsure what the article is; a person decides. */
export const MIN_CONFIDENCE = 0.4;

/** Families whose event is meaningless without a named counterparty. */
export const COUNTERPARTY_FAMILIES = new Set(["CONTRACT", "M_AND_A", "PARTNERSHIP"]);

/** Event statuses the store may publish. */
const PUBLISHABLE_STATUS = new Set(["announced", "completed"]);

export interface GateDecision {
  status: "published" | "needs_review";
  /** Comma-separated machine-readable reasons; null when published. */
  reason: string | null;
}

export function decidePublication(result: ExtractionResult, vendorId: string | null): GateDecision {
  const reasons: string[] = [];

  if (!result.eventTypeValid) reasons.push(`event_type_invalid:${result.eventType.slice(0, 40)}`);
  if (result.extractionMethod === "rules" || result.extractionMethod === "rule_fallback") reasons.push("rule_based_extraction");
  if (!vendorId) reasons.push("vendor_unresolved");
  // A counterparty the text describes but does not name ("a leading European automotive OEM") is a
  // known pattern in award announcements; the store records it as anonymised, not missing.
  if (COUNTERPARTY_FAMILIES.has(result.family) && !result.clientRaw?.trim() && !result.clientDescriptor?.trim()) reasons.push("no_counterparty");

  const status = result.eventStatus ?? "none";
  if (status === "opportunity") {
    reasons.push(result.family === "CONTRACT" ? "opportunity_not_award" : "opportunity_not_event");
  } else if (status === "terminated" || status === "disputed") {
    // A loss to a named competitor is an event (incumbent_displacement); other endings and disputes are for a person.
    if (!(result.family === "CONTRACT" && result.eventType === "incumbent_displacement")) reasons.push(`contract_${status}`);
  } else if (!PUBLISHABLE_STATUS.has(status)) {
    reasons.push("no_event_status");
  }

  // Confidence is only evidence when something measured it. A hard-coded 1.0
  // told this gate "certain" while meaning "nobody looked" — 6,464 events took
  // the free pass that way. An unstamped basis is treated as ASSERTED on
  // purpose: an integrity gate must fail safe, not fail open.
  const basis = result.confidenceBasis ?? "asserted";
  if (basis === "measured") {
    if (result.confidenceScore < MIN_CONFIDENCE) reasons.push(`low_confidence:${result.confidenceScore.toFixed(2)}`);
  } else {
    // Asserted rows are vouched by grounding, not by a number. One with no
    // supported passage has nothing vouching for it at all.
    if (!result.groundedClaims) reasons.push("confidence_asserted_ungrounded");
  }

  return reasons.length ? { status: "needs_review", reason: reasons.join(",") } : { status: "published", reason: null };
}
