/**
 * Plain-language grouping of the publication gate's review reasons (gate.ts),
 * so the review queue can be worked a group at a time.
 *
 * reviewReason is a comma-separated list of machine codes, except rows the
 * estimator once demoted, whose reason carries the estimator's free text
 * (commas included) after "restored_from_estimator_demotion".
 */
export interface ReviewGroup {
  key: string;
  label: string;
  /** What a reviewer is deciding, in one line. */
  hint: string;
}

const GROUPS: Record<string, ReviewGroup> = {
  terminated:   { key: "terminated",   label: "Terminated or withdrawn", hint: "A contract ended or was pulled. Approve to publish it as a termination event." },
  disputed:     { key: "disputed",     label: "Disputed",                hint: "A contract in dispute (penalties, litigation, missed obligations). Approve to publish as a dispute." },
  estimator:    { key: "estimator",    label: "Flagged as not a client contract", hint: "The value estimator judged this not to be a client deal. Usually reject." },
  counterparty: { key: "counterparty", label: "No client or partner named", hint: "The article names no counterparty. Approve only if the deal is still identifiable." },
  opportunity:  { key: "opportunity",  label: "Tender, not an award",     hint: "An RFP or bid, not a signed deal. Usually reject." },
  noStatus:     { key: "noStatus",     label: "Unclear if it happened",   hint: "The text doesn't say the event was announced or completed." },
  noAward:      { key: "noAward",      label: "No award language",        hint: "No words saying a contract was won or signed." },
  lowConf:      { key: "lowConf",      label: "Low confidence",           hint: "The model was unsure what the article is." },
  vendor:       { key: "vendor",       label: "Vendor not matched",       hint: "The provider isn't one of the tracked vendors." },
  other:        { key: "other",        label: "Other",                    hint: "Held for another reason — check the detail." },
};

/** Order groups are checked in: the first match is the item's group. */
const MATCHERS: [RegExp, keyof typeof GROUPS][] = [
  [/^restored_from_estimator_demotion/, "estimator"],
  [/contract_terminated|contract_dispute_or_termination/, "terminated"],
  [/contract_disputed/, "disputed"],
  [/opportunity_not_(award|event)/, "opportunity"],
  [/vendor_unresolved/, "vendor"],
  [/no_counterparty/, "counterparty"],
  [/no_award_language/, "noAward"],
  [/no_event_status/, "noStatus"],
  [/low_confidence/, "lowConf"],
];

export function reviewGroup(reason: string | null | undefined): ReviewGroup {
  const r = reason ?? "";
  for (const [re, key] of MATCHERS) if (re.test(r)) return GROUPS[key];
  return GROUPS.other;
}

/** Display order for the group chips. */
export const GROUP_ORDER = ["terminated", "disputed", "counterparty", "estimator", "opportunity", "noStatus", "noAward", "lowConf", "vendor", "other"];

/** The human-readable detail behind the code, when there is any. */
export function reviewDetail(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const m = /^restored_from_estimator_demotion;\s*estimator said:?\s*([\s\S]*)$/.exec(reason);
  if (m) return m[1].trim() || null;
  const low = /low_confidence:([\d.]+)/.exec(reason);
  if (low) return `confidence ${Math.round(Number(low[1]) * 100)}%`;
  return null;
}
