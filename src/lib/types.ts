// ─── Event families & types ───────────────────────────────────────────────────

export type MarketEventFamily =
  | "CONTRACT"
  | "FINANCIAL_RESULTS"
  | "M_AND_A"
  | "PARTNERSHIP"
  | "NEW_OFFERING"
  | "ORG_CHANGE";

export const FAMILY_LABELS: Record<MarketEventFamily, string> = {
  CONTRACT: "Contract",
  FINANCIAL_RESULTS: "Financial Results",
  M_AND_A: "M&A",
  PARTNERSHIP: "Partnership",
  NEW_OFFERING: "New Offering",
  ORG_CHANGE: "Org Change",
};

export const FAMILY_COLORS: Record<MarketEventFamily, string> = {
  CONTRACT: "emerald",
  FINANCIAL_RESULTS: "cyan",
  M_AND_A: "violet",
  PARTNERSHIP: "blue",
  NEW_OFFERING: "amber",
  ORG_CHANGE: "rose",
};

export type PublicationStatus =
  | "published"
  | "needs_review"
  | "quarantined"
  | "excluded_financial_results"
  | "excluded_noise";

// ─── API response shapes ──────────────────────────────────────────────────────

export interface EventSummary {
  id: string;
  family: string;
  eventType: string;
  canonicalTitle: string;
  announcementDate: string | null;
  geography: string[];
  industry: string | null;
  confidenceScore: number;
  commercialRelevanceScore: number;
  publicationStatus: string;
  /** Why the event sits in needs_review (machine-readable); null once published. */
  reviewReason?: string | null;
  primaryEntityName: string | null;
  primaryEntitySlug: string | null;
  analystInsight: string | null;
  // Contract-specific
  vendorName: string | null;
  clientName: string | null;
  clientAnonymised: boolean;
  clientDescriptor: string | null;
  tcvCommittedUsd: number | null;
  /** §16 — inferred value is a RANGE. Midpoint is never exposed as a fact. */
  tcvEstimateLowUsd: number | null;
  tcvEstimateHighUsd: number | null;
  tcvEstimateMidUsd: number | null;
  /** How a labelled estimate was produced, and one line a reader can check. */
  tcvEstimateMethod: string | null;
  tcvEstimateExplanation: string | null;
  tcvIsEstimate: boolean;
  tcvBasis: string | null;
  /** known | estimated | not_reliably_estimable */
  tcvConfidence: string | null;
  contractEventType: string | null;
  primaryMacroServiceLine: string | null;
  primaryMicroServiceLine: string | null;
  contractLengthMonths: number | null;
  scopeSummary: string | null;
  // M&A specific
  acquirerName: string | null;
  targetName: string | null;
  dealValueUsd: number | null;
  maEventType: string | null;
  maStatus: string | null;
  // Partnership specific
  partnerAName: string | null;
  partnerBName: string | null;
  partnershipType: string | null;
  // Org change specific
  personName: string | null;
  orgEventType: string | null;
  // Source
  originalArticleUrl: string | null;
}

export interface EventFilters {
  family?: MarketEventFamily | "all";
  vendor?: string;
  industry?: string;
  geography?: string;
  serviceLine?: string;
  status?: PublicationStatus | "all";
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface EventsResponse {
  events: EventSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface VendorProfile {
  id: string;
  canonicalName: string;
  displayName: string;
  slug: string;
  regions: string[];
  websiteUrl: string | null;
  eventCounts: Record<string, number>;
  totalEvents: number;
  disclosedTcvUsd: number;       // sum of stated TCV across all published contracts
  disclosedContracts: number;
  recentEvents: EventSummary[];
}

export interface DashboardStats {
  totalEvents: number;
  contractsCount: number;
  financialResultsCount: number;
  maCount: number;
  partnershipCount: number;
  newOfferingCount: number;
  orgChangeCount: number;
  needsReviewCount: number;
  last30DaysCount: number;
  latestEventDate: string | null;
  topVendors: { name: string; slug: string; count: number }[];
  topIndustries: { industry: string; count: number }[];
  recentEvents: EventSummary[];
  familyTrend: { month: string; CONTRACT: number; FINANCIAL_RESULTS: number; M_AND_A: number; PARTNERSHIP: number; NEW_OFFERING: number; ORG_CHANGE: number }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatTcv(usd: number | null, isEstimate: boolean): string {
  if (usd == null) return "Undisclosed";
  const prefix = isEstimate ? "~" : "";
  if (usd >= 1_000_000_000) return `${prefix}$${(usd / 1_000_000_000).toFixed(1)}bn`;
  if (usd >= 1_000_000) return `${prefix}$${(usd / 1_000_000).toFixed(0)}m`;
  return `${prefix}$${(usd / 1_000).toFixed(0)}k`;
}

/**
 * §16 — external TCV presentation.
 *   disclosed  -> "$120m"
 *   inferred   -> "Est. $18m-$27m"   (a range, never a midpoint stated as fact)
 *   withheld   -> "Not reliably estimable"
 * Never exposes confidence scores, comparable counts or methodology.
 */
export function formatTcvDisplay(e: {
  tcvCommittedUsd: number | null;
  tcvEstimateLowUsd: number | null;
  tcvEstimateHighUsd: number | null;
  tcvEstimateMethod?: string | null;
}): string {
  if (e.tcvCommittedUsd != null) return formatTcv(e.tcvCommittedUsd, false);
  if (e.tcvEstimateLowUsd != null && e.tcvEstimateHighUsd != null) {
    // A third party's point estimate has no range of its own; say whose it is.
    if (e.tcvEstimateMethod === "third_party" && e.tcvEstimateLowUsd === e.tcvEstimateHighUsd) return `Est. ${formatTcv(e.tcvEstimateLowUsd, false)} (GlobalData)`;
    return `Est. ${formatTcv(e.tcvEstimateLowUsd, false)}–${formatTcv(e.tcvEstimateHighUsd, false)}`;
  }
  return "Not reliably estimable";
}

/** Hover text for an estimate: the method and the one-line explanation, when known. */
export function tcvEstimateTitle(e: { tcvCommittedUsd: number | null; tcvEstimateMethod?: string | null; tcvEstimateExplanation?: string | null }): string | undefined {
  if (e.tcvCommittedUsd != null) return "Stated in the source";
  if (!e.tcvEstimateExplanation) return undefined;
  const method = e.tcvEstimateMethod === "bpo_rate_card" ? "BPO rate card" : e.tcvEstimateMethod === "value_model" ? "Fitted value model" : e.tcvEstimateMethod === "comparables" ? "Comparable contracts" : e.tcvEstimateMethod === "third_party" ? "Third-party estimate" : "Estimate";
  return `${method}: ${e.tcvEstimateExplanation}`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export const CONTRACT_EVENT_TYPE_LABELS: Record<string, string> = {
  new_win: "New Win",
  renewal: "Renewal",
  extension: "Extension",
  expansion: "Expansion",
  rebid_win: "Rebid Win",
  incumbent_displacement: "Displacement",
  framework_award: "Framework",
  scope_reduction: "Scope Reduction",
  termination: "Termination",
  contract_change: "Contract Change",
  call_off: "Call-Off",
  unknown: "Unclassified",
};

export const FINANCIAL_EVENT_TYPE_LABELS: Record<string, string> = {
  financial_announcement: "Financial Announcement",
  quarterly_results: "Quarterly Results",
  annual_results: "Annual Results",
  guidance_update: "Guidance Update",
  bookings_update: "Bookings / TCV Update",
  segment_performance: "Segment Performance",
};

export const MA_EVENT_TYPE_LABELS: Record<string, string> = {
  acquisition: "Acquisition",
  merger: "Merger",
  divestiture: "Divestiture",
  stake_acquisition: "Stake Acquisition",
  jv_formation: "JV Formation",
  jv_dissolution: "JV Dissolution",
};

export const ORG_EVENT_TYPE_LABELS: Record<string, string> = {
  leadership_appointment: "Leadership Appointment",
  leadership_departure: "Leadership Departure",
  restructuring: "Restructuring",
  strategic_transformation: "Strategic Transformation",
  delivery_centre_opening: "Delivery Centre",
  spin_off: "Spin-Off",
};

/**
 * A title as a reader should see it. The reader writes titles as
 * "Provider | EventType | Buyer | Scope", and sometimes emits the event type as
 * its enum ("NEW_WIN", "OTHER_COMMERCIAL_EVENT") rather than words. Display
 * only — stored titles are left alone because deduplication compares them.
 */
export function displayTitle(title: string | null | undefined): string {
  if (!title) return "";
  return title.replace(/\b[A-Z]{2,}(?:_[A-Z]{2,})+\b/g, m =>
    m.toLowerCase().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").replace(/^Other Commercial Event$/, "Commercial Event"));
}
