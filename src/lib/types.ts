// ─── Event families & types ───────────────────────────────────────────────────

export type MarketEventFamily =
  | "CONTRACT"
  | "M_AND_A"
  | "PARTNERSHIP"
  | "NEW_OFFERING"
  | "ORG_CHANGE";

export const FAMILY_LABELS: Record<MarketEventFamily, string> = {
  CONTRACT: "Contract",
  M_AND_A: "M&A",
  PARTNERSHIP: "Partnership",
  NEW_OFFERING: "New Offering",
  ORG_CHANGE: "Org Change",
};

export const FAMILY_COLORS: Record<MarketEventFamily, string> = {
  CONTRACT: "emerald",
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
  primaryEntityName: string | null;
  primaryEntitySlug: string | null;
  analystInsight: string | null;
  // Contract-specific
  vendorName: string | null;
  clientName: string | null;
  clientAnonymised: boolean;
  clientDescriptor: string | null;
  tcvCommittedUsd: number | null;
  tcvEstimateMidUsd: number | null;
  tcvIsEstimate: boolean;
  tcvBasis: string | null;
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
  recentEvents: EventSummary[];
}

export interface DashboardStats {
  totalEvents: number;
  contractsCount: number;
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
  familyTrend: { month: string; CONTRACT: number; M_AND_A: number; PARTNERSHIP: number; NEW_OFFERING: number; ORG_CHANGE: number }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function formatTcv(usd: number | null, isEstimate: boolean): string {
  if (usd == null) return "Undisclosed";
  const prefix = isEstimate ? "~" : "";
  if (usd >= 1_000_000_000) return `${prefix}$${(usd / 1_000_000_000).toFixed(1)}bn`;
  if (usd >= 1_000_000) return `${prefix}$${(usd / 1_000_000).toFixed(0)}m`;
  return `${prefix}$${(usd / 1_000).toFixed(0)}k`;
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
  call_off: "Call-Off",
  unknown: "Unknown",
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
