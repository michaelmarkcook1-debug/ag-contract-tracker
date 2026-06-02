"use client";

import { useState, useCallback, useEffect } from "react";
import { EventSummary, EventFilters, EventsResponse, MarketEventFamily, FAMILY_LABELS, formatTcv, formatDate, CONTRACT_EVENT_TYPE_LABELS } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EventCard } from "./EventCard";
import { Search, ChevronLeft, ChevronRight, MapPin } from "lucide-react";

const FAMILIES: (MarketEventFamily | "all")[] = ["all", "CONTRACT", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE"];
const PAGE_SIZE = 25;

function EventValueCell({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;
    if (!tcv) return <span className="text-muted-foreground text-xs">—</span>;
    return (
      <span className="font-mono text-xs font-semibold text-emerald-400">
        {formatTcv(tcv, event.tcvIsEstimate)}
      </span>
    );
  }
  if (event.family === "M_AND_A" && event.dealValueUsd) {
    return <span className="font-mono text-xs font-semibold text-violet-400">{formatTcv(event.dealValueUsd, false)}</span>;
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}

function EntityCell({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    return (
      <div className="text-xs">
        <div className="font-medium">{event.vendorName ?? "—"}</div>
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
      <div className="text-xs">
        <div className="font-medium">{event.acquirerName ?? "—"}</div>
        {event.targetName && <div className="text-muted-foreground">→ {event.targetName}</div>}
      </div>
    );
  }
  if (event.family === "PARTNERSHIP") {
    return (
      <div className="text-xs">
        <div className="font-medium">{event.partnerAName ?? event.primaryEntityName ?? "—"}</div>
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

  const setFilter = (key: keyof EventFilters, value: string | number) => {
    setFilters((f) => ({ ...f, [key]: value, page: key !== "page" ? 1 : (value as number) }));
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFilter("search", search);
  };

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <form onSubmit={handleSearchSubmit} className="relative flex-1 min-w-52">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search events, vendors, clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9"
          />
        </form>
        <Select value={String(filters.family ?? "all")} onValueChange={(v) => v && setFilter("family", v)}>
          <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FAMILIES.map((f) => (
              <SelectItem key={f} value={f}>
                {f === "all" ? "All Families" : FAMILY_LABELS[f]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(filters.status ?? "all")} onValueChange={(v) => v && setFilter("status", v)}>
          <SelectTrigger className="w-36 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="needs_review">Needs Review</SelectItem>
          </SelectContent>
        </Select>
        {(filters.search || (filters.family && filters.family !== "all")) && (
          <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" onClick={() => { setFilters({ family: "all", status: "all", page: 1, pageSize: PAGE_SIZE }); setSearch(""); }}>
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-md border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="text-muted-foreground w-28">Family</TableHead>
              <TableHead className="text-muted-foreground">Event</TableHead>
              <TableHead className="text-muted-foreground">Entities</TableHead>
              <TableHead className="text-muted-foreground text-right w-28">Value</TableHead>
              <TableHead className="text-muted-foreground w-32">Geography</TableHead>
              <TableHead className="text-muted-foreground w-28">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i} className="border-border">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : !data || data.events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-16">No events found</TableCell>
              </TableRow>
            ) : (
              data.events.map((event) => (
                <TableRow
                  key={event.id}
                  className="cursor-pointer border-border hover:bg-card/80 group"
                  onClick={() => setSelected(event)}
                >
                  <TableCell><FamilyBadge family={event.family} /></TableCell>
                  <TableCell className="max-w-xs">
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium line-clamp-2 leading-snug">{event.canonicalTitle}</p>
                      {event.family === "CONTRACT" && event.contractEventType && (
                        <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-700 text-zinc-500">
                          {CONTRACT_EVENT_TYPE_LABELS[event.contractEventType] ?? event.contractEventType}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell><EntityCell event={event} /></TableCell>
                  <TableCell className="text-right"><EventValueCell event={event} /></TableCell>
                  <TableCell>
                    {event.geography.length > 0 ? (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" />
                        {event.geography.slice(0, 2).join(", ")}
                        {event.geography.length > 2 && ` +${event.geography.length - 2}`}
                      </span>
                    ) : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(event.announcementDate)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total} event{data.total !== 1 ? "s" : ""}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={data.page <= 1} onClick={() => setFilter("page", data.page - 1)}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span>Page {data.page} of {data.totalPages}</span>
            <Button variant="outline" size="icon" className="h-7 w-7" disabled={data.page >= data.totalPages} onClick={() => setFilter("page", data.page + 1)}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Event detail sheet */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }}>
        <SheetContent className="w-[480px] sm:w-[540px] overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle className="text-base leading-snug pr-4">{selected?.canonicalTitle}</SheetTitle>
          </SheetHeader>
          {selected && <EventCard event={selected} className="border-0 p-0" />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
