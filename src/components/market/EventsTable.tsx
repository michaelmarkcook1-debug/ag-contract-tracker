"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { EventSummary, EventFilters, EventsResponse, MarketEventFamily, FAMILY_LABELS, formatTcv, formatDate, CONTRACT_EVENT_TYPE_LABELS } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EventCard } from "./EventCard";
import {
  Search, ChevronLeft, ChevronRight, MapPin, X, SlidersHorizontal,
  ExternalLink, Calendar, Building2, TrendingUp, ArrowUpDown
} from "lucide-react";

const FAMILIES: { value: MarketEventFamily | "all"; label: string; color?: string }[] = [
  { value: "all", label: "All Types" },
  { value: "CONTRACT", label: "Contracts", color: "bg-blue-500" },
  { value: "M_AND_A", label: "M&A", color: "bg-orange-500" },
  { value: "PARTNERSHIP", label: "Partnerships", color: "bg-emerald-500" },
  { value: "NEW_OFFERING", label: "New Offerings", color: "bg-violet-500" },
  { value: "ORG_CHANGE", label: "Org Changes", color: "bg-pink-500" },
];

const PAGE_SIZE = 30;

function ConfidenceDot({ score }: { score: number }) {
  const color = score >= 0.85 ? "bg-emerald-400" : score >= 0.7 ? "bg-amber-400" : "bg-zinc-500";
  return <div className={`h-1.5 w-1.5 rounded-full ${color}`} title={`${Math.round(score * 100)}% confidence`} />;
}

function EventValueCell({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;
    if (!tcv) return <span className="text-muted-foreground/40">—</span>;
    return (
      <span className="font-mono text-xs font-semibold text-emerald-400">
        {formatTcv(tcv, event.tcvIsEstimate)}
      </span>
    );
  }
  if (event.family === "M_AND_A" && event.dealValueUsd) {
    return <span className="font-mono text-xs font-semibold text-violet-400">{formatTcv(event.dealValueUsd, false)}</span>;
  }
  return <span className="text-muted-foreground/40">—</span>;
}

function EntityNames({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    return (
      <div className="text-xs space-y-0.5">
        <div className="font-medium text-foreground">{event.vendorName ?? "—"}</div>
        {(event.clientName ?? event.clientDescriptor) && (
          <div className="text-muted-foreground">
            → {event.clientAnonymised ? event.clientDescriptor : event.clientName}
          </div>
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

export function EventsTable() {
  const [filters, setFilters] = useState<EventFilters>({ family: "all", status: "all", page: 1, pageSize: PAGE_SIZE });
  const [data, setData] = useState<EventsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EventSummary | null>(null);
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchEvents = useCallback(async (f: EventFilters) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (f.family && f.family !== "all") params.set("family", f.family);
    if (f.status && f.status !== "all") params.set("status", f.status);
    if (f.search) params.set("search", f.search);
    if (f.vendor) params.set("vendor", f.vendor);
    params.set("page", String(f.page ?? 1));
    params.set("pageSize", String(f.pageSize ?? PAGE_SIZE));
    const res = await fetch(`/api/events?${params}`);
    const json = await res.json();
    setData(json);
    setLoading(false);
  }, []);

  useEffect(() => { fetchEvents(filters); }, [fetchEvents, filters]);

  // Keyboard shortcut: Cmd+K to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const setFilter = (key: keyof EventFilters, value: string | number) => {
    setFilters((f) => ({ ...f, [key]: value, page: key !== "page" ? 1 : (value as number) }));
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFilter("search", search);
  };

  const hasActiveFilters = (filters.family && filters.family !== "all") || filters.search || (filters.status && filters.status !== "all");

  return (
    <div className="space-y-0">
      {/* Search bar — prominent, full width */}
      <div className="sticky top-14 z-30 bg-background/80 backdrop-blur-xl border-b border-border/40 px-6 py-3">
        <form onSubmit={handleSearchSubmit} className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
            <Input
              ref={searchRef}
              placeholder="Search events, vendors, clients, industries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 h-10 bg-foreground/[0.04] border-border/40 text-sm placeholder:text-muted-foreground/40 focus-visible:ring-emerald-500/30"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 hidden sm:inline text-[10px] text-muted-foreground/40 bg-foreground/[0.06] px-1.5 py-0.5 rounded font-mono">⌘K</kbd>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`gap-1.5 h-10 px-3 ${showFilters ? "bg-foreground/[0.08]" : ""}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
          </Button>
        </form>

        {/* Filter chips row */}
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 mt-3 pb-1">
            {/* Family type chips */}
            <div className="flex items-center gap-1">
              {FAMILIES.map(({ value, label, color }) => (
                <button
                  key={value}
                  onClick={() => setFilter("family", value)}
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

            <div className="h-4 w-px bg-border/60 mx-1" />

            {/* Status filter */}
            <Select value={String(filters.status ?? "all")} onValueChange={(v) => v && setFilter("status", v)}>
              <SelectTrigger className="w-32 h-7 text-xs border-border/40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="needs_review">Needs Review</SelectItem>
              </SelectContent>
            </Select>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground/60 hover:text-foreground gap-1"
                onClick={() => { setFilters({ family: "all", status: "all", page: 1, pageSize: PAGE_SIZE }); setSearch(""); }}
              >
                <X className="h-3 w-3" />
                Clear all
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="px-6 pt-4 pb-8">
        {/* Results header */}
        {data && (
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs text-muted-foreground">
              {data.total.toLocaleString()} result{data.total !== 1 ? "s" : ""}
              {filters.search && <span> for &ldquo;{filters.search}&rdquo;</span>}
            </p>
          </div>
        )}

        {/* Event cards */}
        <div className="space-y-2">
          {loading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-20 bg-foreground/[0.03] rounded-xl animate-pulse" />
            ))
          ) : !data || data.events.length === 0 ? (
            <div className="text-center py-24">
              <Search className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No events found</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting your search or filters</p>
            </div>
          ) : (
            data.events.map((event) => (
              <button
                key={event.id}
                className="w-full text-left group"
                onClick={() => setSelected(event)}
              >
                <div className="flex items-start gap-4 p-4 rounded-xl border border-transparent hover:border-border/60 hover:bg-foreground/[0.02] transition-all">
                  {/* Left: type indicator */}
                  <div className="pt-0.5 shrink-0">
                    <FamilyBadge family={event.family} className="text-[10px]" />
                  </div>

                  {/* Center: main content */}
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-start gap-2">
                      <h3 className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-foreground transition-colors">
                        {event.canonicalTitle}
                      </h3>
                      <ConfidenceDot score={event.confidenceScore} />
                    </div>

                    {/* Meta row */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
                      {event.primaryEntityName && (
                        <span className="flex items-center gap-1">
                          <Building2 className="h-3 w-3" />
                          {event.primaryEntityName}
                        </span>
                      )}
                      {event.announcementDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatDate(event.announcementDate)}
                        </span>
                      )}
                      {event.geography.length > 0 && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {event.geography.slice(0, 2).join(", ")}
                          {event.geography.length > 2 && ` +${event.geography.length - 2}`}
                        </span>
                      )}
                      {event.family === "CONTRACT" && event.contractEventType && (
                        <Badge variant="outline" className="text-[10px] py-0 h-4 border-border/40 text-muted-foreground/50">
                          {CONTRACT_EVENT_TYPE_LABELS[event.contractEventType] ?? event.contractEventType}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Right: entities + value */}
                  <div className="shrink-0 text-right space-y-1 min-w-[140px] hidden md:block">
                    <EntityNames event={event} />
                    <div className="mt-1"><EventValueCell event={event} /></div>
                  </div>

                  {/* Source link */}
                  {event.originalArticleUrl && (
                    <a
                      href={event.originalArticleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 p-1.5 rounded-md text-muted-foreground/30 hover:text-muted-foreground hover:bg-foreground/[0.05] transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-border/30">
            <span className="text-xs text-muted-foreground/60">
              Showing {((data.page - 1) * PAGE_SIZE) + 1}–{Math.min(data.page * PAGE_SIZE, data.total)} of {data.total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-border/40"
                disabled={data.page <= 1}
                onClick={() => setFilter("page", data.page - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="text-xs text-muted-foreground px-2 tabular-nums">
                {data.page} / {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-border/40"
                disabled={data.page >= data.totalPages}
                onClick={() => setFilter("page", data.page + 1)}
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Event detail sheet */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent className="w-[520px] sm:w-[580px] overflow-y-auto border-border/40">
          <SheetHeader className="pb-4">
            <div className="flex items-center gap-2 mb-2">
              <FamilyBadge family={selected?.family ?? "CONTRACT"} className="text-[10px]" />
              <ConfidenceDot score={selected?.confidenceScore ?? 0} />
            </div>
            <SheetTitle className="text-base leading-snug pr-4">{selected?.canonicalTitle}</SheetTitle>
          </SheetHeader>
          {selected && <EventCard event={selected} className="border-0 p-0" />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
