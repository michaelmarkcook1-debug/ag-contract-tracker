"use client";

import { EventSummary, formatTcv, formatTcvDisplay, formatDate, CONTRACT_EVENT_TYPE_LABELS, MA_EVENT_TYPE_LABELS, ORG_EVENT_TYPE_LABELS } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Badge } from "@/components/ui/badge";
import { MapPin, Building2, Calendar, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

interface EventCardProps {
  event: EventSummary;
  className?: string;
}

function EventMeta({ event }: { event: EventSummary }) {
  if (event.family === "CONTRACT") {
    const tcvLabel = formatTcvDisplay(event);   // §16 disclosed | Est. range | withheld
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
        {event.vendorName && <span className="font-medium text-foreground/80">{event.vendorName}</span>}
        {event.clientName && !event.clientAnonymised && (
          <span>→ {event.clientName}</span>
        )}
        {event.clientAnonymised && event.clientDescriptor && (
          <span>→ {event.clientDescriptor}</span>
        )}
        {tcvLabel !== "Not reliably estimable" && (
          <span className="font-mono font-semibold text-emerald-400">{tcvLabel}</span>
        )}
        {event.contractEventType && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-600 text-zinc-400">
            {CONTRACT_EVENT_TYPE_LABELS[event.contractEventType] ?? event.contractEventType}
          </Badge>
        )}
        {event.primaryMacroServiceLine && (
          <span className="text-zinc-500">{event.primaryMacroServiceLine}</span>
        )}
      </div>
    );
  }

  if (event.family === "M_AND_A") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
        {event.acquirerName && <span className="font-medium text-foreground/80">{event.acquirerName}</span>}
        {event.targetName && <span>acquires {event.targetName}</span>}
        {event.dealValueUsd && (
          <span className="font-mono font-semibold text-violet-400">{formatTcv(event.dealValueUsd, false)}</span>
        )}
        {event.maEventType && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-600 text-zinc-400">
            {MA_EVENT_TYPE_LABELS[event.maEventType] ?? event.maEventType}
          </Badge>
        )}
        {event.maStatus && event.maStatus !== "announced" && (
          <span className={cn("capitalize", event.maStatus === "completed" ? "text-emerald-400" : "text-red-400")}>
            {event.maStatus}
          </span>
        )}
      </div>
    );
  }

  if (event.family === "PARTNERSHIP") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
        {event.partnerAName && <span className="font-medium text-foreground/80">{event.partnerAName}</span>}
        {event.partnerBName && <span>× {event.partnerBName}</span>}
        {event.partnershipType && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-600 text-zinc-400 capitalize">
            {event.partnershipType.replace(/_/g, " ")}
          </Badge>
        )}
      </div>
    );
  }

  if (event.family === "ORG_CHANGE") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
        {event.primaryEntityName && <span className="font-medium text-foreground/80">{event.primaryEntityName}</span>}
        {event.personName && <span>{event.personName}</span>}
        {event.orgEventType && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-600 text-zinc-400">
            {ORG_EVENT_TYPE_LABELS[event.orgEventType] ?? event.orgEventType}
          </Badge>
        )}
      </div>
    );
  }

  if (event.family === "NEW_OFFERING") {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-2">
        {event.primaryEntityName && <span className="font-medium text-foreground/80">{event.primaryEntityName}</span>}
        {event.eventType && (
          <Badge variant="outline" className="text-[10px] py-0 h-4 border-zinc-600 text-zinc-400 capitalize">
            {event.eventType.replace(/_/g, " ")}
          </Badge>
        )}
      </div>
    );
  }

  return null;
}

export function EventCard({ event, className }: EventCardProps) {
  return (
    <div className={cn("group p-4 rounded-xl border border-border/40 bg-card/50 hover:border-border/80 hover:bg-card/80 transition-all", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <FamilyBadge family={event.family} />
            {event.industry && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {event.industry}
              </span>
            )}
            {event.geography.length > 0 && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {event.geography.slice(0, 2).join(", ")}
                {event.geography.length > 2 && ` +${event.geography.length - 2}`}
              </span>
            )}
          </div>

          <p className="text-sm font-medium leading-snug line-clamp-2 group-hover:text-foreground transition-colors">
            {event.canonicalTitle}
          </p>

          <EventMeta event={event} />

          {event.analystInsight && (
            <p className="text-xs text-muted-foreground mt-2 line-clamp-2 italic border-l-2 border-zinc-700 pl-2">
              {event.analystInsight}
            </p>
          )}
        </div>

        <div className="text-right shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {formatDate(event.announcementDate)}
          </span>
          {event.primaryEntitySlug && (
            <Link
              href={`/vendors/${event.primaryEntitySlug}`}
              className="text-xs text-zinc-500 hover:text-foreground flex items-center gap-0.5 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              {event.primaryEntityName}
              <ExternalLink className="h-2.5 w-2.5" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
