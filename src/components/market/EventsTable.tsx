"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { EventSummary, EventFilters, EventsResponse, MarketEventFamily, FAMILY_LABELS, formatTcv, formatDate, CONTRACT_EVENT_TYPE_LABELS, MA_EVENT_TYPE_LABELS, ORG_EVENT_TYPE_LABELS, FINANCIAL_EVENT_TYPE_LABELS } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Search, ChevronLeft, ChevronRight, MapPin, X, SlidersHorizontal,
  ExternalLink, Calendar, Building2, Briefcase, Globe, Tag, FileText,
  DollarSign, Clock, User, ArrowRight
} from "lucide-react";
import Link from "next/link";

const FAMILIES: { value: MarketEventFamily | "all"; label: string; color?: string }[] = [
  { value: "all", label: "All Types" },
  { value: "CONTRACT", label: "Contracts", color: "bg-blue-500" },
  { value: "FINANCIAL_RESULTS", label: "Financial Results", color: "bg-cyan-600" },
  { value: "M_AND_A", label: "M&A", color: "bg-orange-500" },
  { value: "PARTNERSHIP", label: "Partnerships", color: "bg-emerald-500" },
  { value: "NEW_OFFERING", label: "New Offerings", color: "bg-violet-500" },
  { value: "ORG_CHANGE", label: "Org Changes", color: "bg-pink-500" },
];

const PAGE_SIZE = 30;

interface FilterOptions {
  vendors: { name: string; slug: string }[];
  industries: { name: string; count: number }[];
  serviceLines: { name: string; count: number }[];
}

function ConfidenceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 85 ? "text-emerald-400" : pct >= 70 ? "text-amber-400" : "text-zinc-500";
  return <span className={`text-[10px] font-mono font-medium ${color}`}>{pct}%</span>;
}

// ── Detail Panel ─────────────────────────────────────────────────────────────
function EventDetailPanel({ event }: { event: EventSummary }) {
  const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;

  return (
    <div className="space-y-6 pb-8">
      {/* Meta badges */}
      <div className="flex flex-wrap gap-2">
        <FamilyBadge family={event.family} />
        {event.industry && (
          <Badge variant="outline" className="text-xs border-border/60 gap-1">
            <Briefcase className="h-3 w-3" /> {event.industry}
          </Badge>
        )}
        {event.geography.length > 0 && (
          <Badge variant="outline" className="text-xs border-border/60 gap-1">
            <Globe className="h-3 w-3" /> {event.geography.join(", ")}
          </Badge>
        )}
        {event.primaryMacroServiceLine && (
          <Badge variant="outline" className="text-xs border-border/60 gap-1">
            <Tag className="h-3 w-3" /> {event.primaryMacroServiceLine}
          </Badge>
        )}
        <Badge variant="outline" className="text-xs border-border/60">
          <ConfidenceBadge score={event.confidenceScore} /> conf
        </Badge>
      </div>

      {/* Key Facts — 2-column paired table matching predecessor layout */}
      <div className="rounded-xl border border-border/40 overflow-hidden">
        <table className="w-full text-xs">
          <tbody className="divide-y divide-border/20">
            {event.family === "CONTRACT" && (
              <>
                <PairedRow l1="Provider" v1={event.vendorName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Macro Service" v1={event.primaryMacroServiceLine} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Micro Service" v1={event.primaryMicroServiceLine} l2="Country" v2={null} />
                <PairedRow l1="Client" v1={event.clientAnonymised ? event.clientDescriptor : event.clientName} l2="TCV" v2={tcv ? formatTcv(tcv, event.tcvIsEstimate) : null} v2Class="text-emerald-400 font-mono font-semibold" />
                <PairedRow l1="Contract Type" v1={event.contractEventType ? (CONTRACT_EVENT_TYPE_LABELS[event.contractEventType] ?? event.contractEventType) : null} l2="Length" v2={event.contractLengthMonths ? `${event.contractLengthMonths} months` : null} />
                <PairedRow l1="Start Date" v1={formatDate(event.announcementDate)} l2="TCV Basis" v2={event.tcvBasis} />
                <PairedRow l1="Confidence" v1={`${Math.round(event.confidenceScore * 100)}%`} l2="Source" v2={event.originalArticleUrl ? "See link below" : null} />
              </>
            )}
            {event.family === "M_AND_A" && (
              <>
                <PairedRow l1="Acquirer" v1={event.acquirerName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Target" v1={event.targetName} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Deal Value" v1={event.dealValueUsd ? formatTcv(event.dealValueUsd, false) : null} v1Class="text-violet-400 font-mono font-semibold" l2="Deal Type" v2={event.maEventType ? (MA_EVENT_TYPE_LABELS[event.maEventType] ?? event.maEventType) : null} />
                <PairedRow l1="Status" v1={event.maStatus} l2="Date" v2={formatDate(event.announcementDate)} />
              </>
            )}
            {event.family === "PARTNERSHIP" && (
              <>
                <PairedRow l1="Partner A" v1={event.partnerAName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Partner B" v1={event.partnerBName} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Partnership Type" v1={event.partnershipType?.replace(/_/g, " ")} l2="Date" v2={formatDate(event.announcementDate)} />
              </>
            )}
            {event.family === "ORG_CHANGE" && (
              <>
                <PairedRow l1="Organisation" v1={event.primaryEntityName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Person" v1={event.personName} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Change Type" v1={event.orgEventType ? (ORG_EVENT_TYPE_LABELS[event.orgEventType] ?? event.orgEventType) : null} l2="Date" v2={formatDate(event.announcementDate)} />
              </>
            )}
            {event.family === "NEW_OFFERING" && (
              <>
                <PairedRow l1="Provider" v1={event.primaryEntityName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Offering Type" v1={event.eventType?.replace(/_/g, " ")} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Service Line" v1={event.primaryMacroServiceLine} l2="Date" v2={formatDate(event.announcementDate)} />
              </>
            )}
            {event.family === "FINANCIAL_RESULTS" && (
              <>
                <PairedRow l1="Company" v1={event.primaryEntityName ?? event.vendorName} l2="Industry" v2={event.industry} />
                <PairedRow l1="Announcement" v1={event.eventType ? (FINANCIAL_EVENT_TYPE_LABELS[event.eventType] ?? event.eventType.replace(/_/g, " ")) : null} l2="Geography" v2={event.geography.length > 0 ? event.geography.join(", ") : null} />
                <PairedRow l1="Reported Value" v1={event.tcvCommittedUsd || event.tcvEstimateMidUsd ? formatTcv(event.tcvCommittedUsd ?? event.tcvEstimateMidUsd, event.tcvIsEstimate) : null} l2="Date" v2={formatDate(event.announcementDate)} />
                <PairedRow l1="Confidence" v1={`${(event.confidenceScore * 100).toFixed(0)}%`} l2="Source" v2={event.originalArticleUrl ? new URL(event.originalArticleUrl).hostname.replace(/^www\./, "") : null} />
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* Summary */}
      {event.scopeSummary && (
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Summary</h3>
          <p className="text-sm text-foreground/80 leading-relaxed">{event.scopeSummary}</p>
        </div>
      )}

      {/* Analyst Insight */}
      {event.analystInsight && (
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
          <h3 className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <FileText className="h-3 w-3" />
            Analyst Insight
          </h3>
          <p className="text-sm text-foreground/80 leading-relaxed italic">{event.analystInsight}</p>
        </div>
      )}

      {/* Source link */}
      {event.originalArticleUrl && (
        <a
          href={event.originalArticleUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          View original source
        </a>
      )}

      {/* Vendor link */}
      {event.primaryEntitySlug && (
        <Link
          href={`/vendors/${event.primaryEntitySlug}`}
          className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
        >
          <Building2 className="h-3.5 w-3.5" />
          View all {event.primaryEntityName} events
          <ArrowRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

function PairedRow({ l1, v1, v1Class, l2, v2, v2Class }: {
  l1: string; v1: string | null | undefined; v1Class?: string;
  l2: string; v2: string | null | undefined; v2Class?: string;
}) {
  return (
    <tr>
      <td className="px-3 py-2.5 text-muted-foreground/50 font-semibold w-[22%] border-r border-border/10">{l1}</td>
      <td className={`px-3 py-2.5 w-[28%] border-r border-border/10 ${v1Class ?? "text-foreground"}`}>{v1 ?? "—"}</td>
      <td className="px-3 py-2.5 text-muted-foreground/50 font-semibold w-[22%] border-r border-border/10">{l2}</td>
      <td className={`px-3 py-2.5 w-[28%] ${v2Class ?? "text-foreground"}`}>{v2 ?? "—"}</td>
    </tr>
  );
}

// ── Entity display in list ───────────────────────────────────────────────────
function EntityNames({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    return (
      <div className="text-xs space-y-0.5">
        <div className="font-medium text-foreground">{event.vendorName ?? "—"}</div>
        {(event.clientName ?? event.clientDescriptor) && (
          <div className="text-muted-foreground">→ {event.clientAnonymised ? event.clientDescriptor : event.clientName}</div>
        )}
      </div>
    );
  }
  if (event.family === "M_AND_A") {
    return (
      <div className="text-xs space-y-0.5">
        <div className="font-medium text-foreground">{event.acquirerName ?? "—"}</div>
        {event.targetName && <div className="text-muted-foreground">→ {event.targetName}</div>}
      </div>
    );
  }
  if (event.family === "PARTNERSHIP") {
    return (
      <div className="text-xs space-y-0.5">
        <div className="font-medium text-foreground">{event.partnerAName ?? event.primaryEntityName ?? "—"}</div>
        {event.partnerBName && <div className="text-muted-foreground">× {event.partnerBName}</div>}
      </div>
    );
  }
  return <span className="text-xs font-medium">{event.primaryEntityName ?? "—"}</span>;
}

function EventValueCell({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;
    if (!tcv) return null;
    return <span className="font-mono text-xs font-semibold text-emerald-400">{formatTcv(tcv, event.tcvIsEstimate)}</span>;
  }
  if (event.family === "M_AND_A" && event.dealValueUsd) {
    return <span className="font-mono text-xs font-semibold text-violet-400">{formatTcv(event.dealValueUsd, false)}</span>;
  }
  return null;
}

// ── Main Component ───────────────────────────────────────────────────────────
export function EventsTable() {
  const [filters, setFilters] = useState<EventFilters>({ family: "all", status: "all", page: 1, pageSize: PAGE_SIZE });
  const [data, setData] = useState<EventsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<EventSummary | null>(null);
  const [search, setSearch] = useState("");
  const [hasSearched, setHasSearched] = useState(false);
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Load filter options
  useEffect(() => {
    fetch("/api/events/filters").then(r => r.json()).then(setFilterOptions).catch(() => {});
  }, []);

  const fetchEvents = useCallback(async (f: EventFilters) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (f.family && f.family !== "all") params.set("family", f.family);
    if (f.status && f.status !== "all") params.set("status", f.status);
    if (f.search) params.set("search", f.search);
    if (f.vendor) params.set("vendor", f.vendor);
    if (f.industry) params.set("industry", f.industry);
    if (f.geography) params.set("geography", f.geography);
    if (f.serviceLine) params.set("serviceLine", f.serviceLine);
    if (f.dateFrom) params.set("dateFrom", f.dateFrom);
    if (f.dateTo) params.set("dateTo", f.dateTo);
    params.set("page", String(f.page ?? 1));
    params.set("pageSize", String(f.pageSize ?? PAGE_SIZE));
    const res = await fetch(`/api/events?${params}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, []);

  // Only fetch when user has actively searched or filtered
  useEffect(() => {
    if (hasSearched) fetchEvents(filters);
  }, [fetchEvents, filters, hasSearched]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const setFilter = (key: keyof EventFilters, value: string | number) => {
    setHasSearched(true);
    setFilters((f) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const next: any = { ...f, [key]: value || undefined, page: key !== "page" ? 1 : (value as number) };
      return next as EventFilters;
    });
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setHasSearched(true);
    setFilter("search", search);
  };

  const activeFilterCount = [
    filters.family && filters.family !== "all",
    filters.vendor,
    filters.industry,
    filters.geography,
    filters.serviceLine,
    filters.status && filters.status !== "all",
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    setFilters({ family: "all", status: "all", page: 1, pageSize: PAGE_SIZE });
    setSearch("");
    setHasSearched(false);
    setData(null);
  };

  return (
    <div className="space-y-0">
      {/* Search + filter bar — always visible */}
      <div className="sticky top-14 z-30 bg-background/80 backdrop-blur-xl border-b border-border/40">
        <div className="px-6 pt-4 pb-3">
          <form onSubmit={handleSearchSubmit} className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground/50" />
            <Input
              ref={searchRef}
              placeholder="Search events, vendors, clients, industries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-12 h-12 bg-foreground/[0.05] border-border/50 text-base font-medium placeholder:text-muted-foreground/40 focus-visible:ring-emerald-500/30 rounded-xl"
            />
            <kbd className="absolute right-4 top-1/2 -translate-y-1/2 hidden sm:inline text-[10px] text-muted-foreground/30 bg-foreground/[0.06] px-1.5 py-0.5 rounded font-mono">⌘K</kbd>
          </form>
        </div>

        {/* Filters — always shown */}
        <div className="px-6 pb-4 space-y-3">
            {/* Type chips */}
            <div className="flex items-center gap-1 flex-wrap">
              {FAMILIES.map(({ value, label, color }) => (
                <button
                  key={value}
                  onClick={() => setFilter("family", value === "all" ? "all" : value)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                    filters.family === value
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-foreground/[0.04]"
                  }`}
                >
                  {color && <span className={`h-2 w-2 rounded-full ${color}`} />}
                  {label}
                </button>
              ))}
            </div>

            {/* Dropdown filters */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {/* Vendor */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Provider</label>
                <Select value={filters.vendor ?? "__all__"} onValueChange={(v: string | null) => v && setFilter("vendor", v === "__all__" ? "" : v)}>
                  <SelectTrigger className="h-8 text-xs border-border/40"><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="__all__">Any provider</SelectItem>
                    {filterOptions?.vendors.map(v => (
                      <SelectItem key={v.slug} value={v.slug}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Industry */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Industry</label>
                <Select value={filters.industry ?? "__all__"} onValueChange={(v: string | null) => v && setFilter("industry", v === "__all__" ? "" : v)}>
                  <SelectTrigger className="h-8 text-xs border-border/40"><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="__all__">Any industry</SelectItem>
                    {filterOptions?.industries.map(i => (
                      <SelectItem key={i.name} value={i.name}>{i.name} ({i.count})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Service Line */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Service Line</label>
                <Select value={filters.serviceLine ?? "__all__"} onValueChange={(v: string | null) => v && setFilter("serviceLine", v === "__all__" ? "" : v)}>
                  <SelectTrigger className="h-8 text-xs border-border/40"><SelectValue placeholder="Any" /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value="__all__">Any service line</SelectItem>
                    {filterOptions?.serviceLines.map(s => (
                      <SelectItem key={s.name} value={s.name}>{s.name} ({s.count})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Status */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Status</label>
                <Select value={String(filters.status ?? "all")} onValueChange={(v: string | null) => v && setFilter("status", v)}>
                  <SelectTrigger className="h-8 text-xs border-border/40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="needs_review">Needs Review</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Date From */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Date From</label>
                <Input
                  type="date"
                  value={filters.dateFrom ?? ""}
                  onChange={(e) => setFilter("dateFrom", e.target.value)}
                  className="h-8 text-xs border-border/40"
                />
              </div>

              {/* Date To */}
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Date To</label>
                <Input
                  type="date"
                  value={filters.dateTo ?? ""}
                  onChange={(e) => setFilter("dateTo", e.target.value)}
                  className="h-8 text-xs border-border/40"
                />
              </div>
            </div>

            {/* Active filter pills + clear */}
            {activeFilterCount > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {filters.vendor && filterOptions && (
                  <FilterPill label={`Provider: ${filterOptions.vendors.find(v => v.slug === filters.vendor)?.name ?? filters.vendor}`} onRemove={() => setFilter("vendor", "")} />
                )}
                {filters.industry && <FilterPill label={`Industry: ${filters.industry}`} onRemove={() => setFilter("industry", "")} />}
                {filters.serviceLine && <FilterPill label={`Service: ${filters.serviceLine}`} onRemove={() => setFilter("serviceLine", "")} />}
                {filters.dateFrom && <FilterPill label={`From: ${filters.dateFrom}`} onRemove={() => setFilter("dateFrom", "")} />}
                {filters.dateTo && <FilterPill label={`To: ${filters.dateTo}`} onRemove={() => setFilter("dateTo", "")} />}
                <button onClick={clearAllFilters} className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors flex items-center gap-1">
                  <X className="h-3 w-3" /> Clear all
                </button>
              </div>
            )}
          </div>
      </div>

      {/* Results */}
      <div className="px-6 pt-4 pb-8">
        {!hasSearched ? (
          <div className="text-center py-28">
            <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-emerald-500/10 mb-4">
              <Search className="h-8 w-8 text-emerald-500/50" />
            </div>
            <h2 className="text-lg font-semibold mb-1">Search IT Services Market Events</h2>
            <p className="text-sm text-muted-foreground/60 max-w-md mx-auto">
              Search across {data?.total ? data.total.toLocaleString() : "7,000+"} events — contracts, M&A, partnerships, and org changes — or use the filters above to narrow results.
            </p>
            <div className="flex items-center justify-center gap-4 mt-6 text-xs text-muted-foreground/40">
              <span>63 tracked vendors</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/20" />
              <span>Public sources only</span>
              <span className="h-1 w-1 rounded-full bg-muted-foreground/20" />
              <span>AI-extracted insights</span>
            </div>
          </div>
        ) : (
        <>
        {data && (
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs text-muted-foreground">
              {data.total.toLocaleString()} result{data.total !== 1 ? "s" : ""}
              {filters.search && <span> for &ldquo;{filters.search}&rdquo;</span>}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-[72px] bg-foreground/[0.03] rounded-xl animate-pulse" />
            ))
          ) : !data || data.events.length === 0 ? (
            <div className="text-center py-24">
              <Search className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No events found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting your search or filters</p>
            </div>
          ) : (
            data.events.map((event) => (
              <button key={event.id} className="w-full text-left group" onClick={() => setSelected(event)}>
                <div className="flex items-start gap-4 px-4 py-3 rounded-xl border border-transparent hover:border-border/60 hover:bg-foreground/[0.02] transition-all">
                  <div className="pt-0.5 shrink-0">
                    <FamilyBadge family={event.family} className="text-[10px]" />
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <h3 className="text-sm font-medium leading-snug line-clamp-1 group-hover:text-foreground transition-colors">
                      {event.canonicalTitle}
                    </h3>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground/50 flex-wrap">
                      {event.primaryEntityName && (
                        <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{event.primaryEntityName}</span>
                      )}
                      {event.announcementDate && (
                        <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatDate(event.announcementDate)}</span>
                      )}
                      {event.geography.length > 0 && (
                        <span className="flex items-center gap-1"><Globe className="h-3 w-3" />{event.geography.slice(0, 2).join(", ")}{event.geography.length > 2 && ` +${event.geography.length - 2}`}</span>
                      )}
                      {event.industry && (
                        <span className="flex items-center gap-1"><Briefcase className="h-3 w-3" />{event.industry}</span>
                      )}
                      {event.primaryMacroServiceLine && (
                        <span className="flex items-center gap-1"><Tag className="h-3 w-3" />{event.primaryMacroServiceLine}</span>
                      )}
                    </div>
                    {event.analystInsight && (
                      <p className="text-[11px] text-muted-foreground/40 line-clamp-1 italic">{event.analystInsight}</p>
                    )}
                  </div>

                  <div className="shrink-0 text-right space-y-1 min-w-[130px] hidden md:block">
                    <EntityNames event={event} />
                    <EventValueCell event={event} />
                  </div>

                  <div className="shrink-0 flex items-center gap-2 pt-1">
                    <ConfidenceBadge score={event.confidenceScore} />
                    {event.originalArticleUrl && (
                      <a
                        href={event.originalArticleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1 rounded text-muted-foreground/20 hover:text-muted-foreground transition-colors"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-border/30">
            <span className="text-xs text-muted-foreground/60">
              {((data.page - 1) * PAGE_SIZE) + 1}–{Math.min(data.page * PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon" className="h-8 w-8 border-border/40" disabled={data.page <= 1} onClick={() => setFilter("page", data.page - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground px-2 tabular-nums">{data.page} / {data.totalPages}</span>
              <Button variant="outline" size="icon" className="h-8 w-8 border-border/40" disabled={data.page >= data.totalPages} onClick={() => setFilter("page", data.page + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {/* Detail sheet */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent className="w-[520px] sm:w-[580px] overflow-y-auto border-border/40">
          <SheetHeader className="pb-4">
            <SheetTitle className="text-base leading-snug pr-4">{selected?.canonicalTitle}</SheetTitle>
          </SheetHeader>
          {selected && <EventDetailPanel event={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 bg-foreground/[0.06] text-foreground/80 text-[11px] px-2 py-0.5 rounded-full">
      {label}
      <button onClick={onRemove} className="hover:text-foreground transition-colors"><X className="h-3 w-3" /></button>
    </span>
  );
}
