"use client";

import { useState, useCallback } from "react";
import { EventSummary, formatDate, FAMILY_LABELS } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CheckCircle2, XCircle, ChevronRight, MapPin, Building2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewQueueProps {
  initialEvents: EventSummary[];
  totalCount: number;
}

export function ReviewQueue({ initialEvents, totalCount }: ReviewQueueProps) {
  const [events, setEvents] = useState(initialEvents);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const act = useCallback(async (id: string, action: "approve" | "reject") => {
    setProcessing(prev => new Set(prev).add(id));
    try {
      await fetch(`/api/events/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setDismissed(prev => new Set(prev).add(id));
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, []);

  const visible = events.filter(e => !dismissed.has(e.id));

  if (visible.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="h-8 w-8 text-emerald-400 mb-3" />
        <p className="text-sm font-medium">Review queue is clear</p>
        <p className="text-xs text-muted-foreground mt-1">All {totalCount} events have been reviewed</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{visible.length} of {totalCount} pending</p>
      {visible.map(event => (
        <ReviewCard
          key={event.id}
          event={event}
          isProcessing={processing.has(event.id)}
          onApprove={() => act(event.id, "approve")}
          onReject={() => act(event.id, "reject")}
        />
      ))}
    </div>
  );
}

function ReviewCard({ event, isProcessing, onApprove, onReject }: {
  event: EventSummary;
  isProcessing: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;
  const confidence = event.confidenceScore;
  const confColor = confidence >= 0.75 ? "text-emerald-400" : confidence >= 0.55 ? "text-yellow-400" : "text-red-400";

  return (
    <div className={cn("p-3 rounded-lg border border-border bg-card transition-opacity", isProcessing && "opacity-50 pointer-events-none")}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Badges row */}
          <div className="flex flex-wrap items-center gap-1.5">
            <FamilyBadge family={event.family} />
            {event.industry && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <Building2 className="h-2.5 w-2.5" />{event.industry}
              </span>
            )}
            {event.geography.length > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <MapPin className="h-2.5 w-2.5" />{event.geography.slice(0, 2).join(", ")}
              </span>
            )}
            <span className={cn("text-[10px] font-mono ml-auto", confColor)}>
              {(confidence * 100).toFixed(0)}% conf
            </span>
          </div>

          {/* Title */}
          <p className="text-xs font-medium leading-snug line-clamp-2">{event.canonicalTitle}</p>

          {/* Extracted fields */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
            {event.vendorName && <span className="font-medium text-foreground/70">{event.vendorName}</span>}
            {event.clientName && !event.clientAnonymised && <span>→ {event.clientName}</span>}
            {tcv && <span className="font-mono text-emerald-400/80">${tcv >= 1e9 ? `${(tcv/1e9).toFixed(1)}bn` : `${(tcv/1e6).toFixed(0)}m`}</span>}
            {event.primaryMacroServiceLine && <span>{event.primaryMacroServiceLine}</span>}
          </div>

          {/* Source link */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-600">{formatDate(event.announcementDate)}</span>
            {event.originalArticleUrl && (
              <a
                href={event.originalArticleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-zinc-600 hover:text-foreground flex items-center gap-0.5 transition-colors"
                onClick={e => e.stopPropagation()}
              >
                source <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size="icon" variant="outline" className="h-7 w-7 border-emerald-500/30 hover:bg-emerald-500/10 hover:border-emerald-500/50" onClick={onApprove} title="Approve">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          </Button>
          <Button size="icon" variant="outline" className="h-7 w-7 border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50" onClick={onReject} title="Reject">
            <XCircle className="h-3.5 w-3.5 text-red-400" />
          </Button>
        </div>
      </div>
    </div>
  );
}
