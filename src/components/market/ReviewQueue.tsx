"use client";

import { useState, useCallback, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EventSummary, formatDate } from "@/lib/types";
import { FamilyBadge } from "./FamilyBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, XCircle, MapPin, Building2, ExternalLink, AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewQueueProps {
  initialEvents: EventSummary[];
  totalCount: number;
}

type Action = "approve" | "reject";

export function ReviewQueue({ initialEvents, totalCount }: ReviewQueueProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);

  const visible = initialEvents.filter(e => !dismissed.has(e.id));

  /** Send one review action. Returns true only on a real success. */
  const send = useCallback(async (id: string, action: Action): Promise<boolean> => {
    // fetch() does NOT throw on 4xx/5xx — it must be checked explicitly, or a
    // failed approval silently disappears from the UI and reappears on reload.
    const res = await fetch(`/api/events/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    return data?.success === true;
  }, []);

  const act = useCallback(async (id: string, action: Action) => {
    setError(null);
    setProcessing(prev => new Set(prev).add(id));
    try {
      const ok = await send(id, action);
      if (ok) {
        setDismissed(prev => new Set(prev).add(id));
        setSelected(prev => { const s = new Set(prev); s.delete(id); return s; });
        // Re-fetch the server component so counts and the queue stay truthful.
        startTransition(() => router.refresh());
      } else {
        setError(`Could not ${action} that event — it was left in the queue.`);
      }
    } catch {
      setError("Network error — no changes were saved.");
    } finally {
      setProcessing(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }, [send, router]);

  const actOnSelected = useCallback(async (action: Action) => {
    const ids = visible.filter(e => selected.has(e.id)).map(e => e.id);
    if (ids.length === 0) return;
    setError(null);
    setProcessing(new Set(ids));

    const succeeded: string[] = [];
    const failed: string[] = [];
    // Sequential: keeps DB write load sane and lets us report partial results
    // honestly rather than assuming the whole batch worked.
    for (let i = 0; i < ids.length; i++) {
      setBulkProgress(`${action === "approve" ? "Approving" : "Rejecting"} ${i + 1} of ${ids.length}…`);
      try {
        (await send(ids[i], action)) ? succeeded.push(ids[i]) : failed.push(ids[i]);
      } catch {
        failed.push(ids[i]);
      }
    }

    setDismissed(prev => new Set([...prev, ...succeeded]));
    setSelected(new Set());
    setProcessing(new Set());
    setBulkProgress(null);
    if (failed.length > 0) {
      setError(`${succeeded.length} ${action}d, ${failed.length} failed and remain in the queue.`);
    }
    startTransition(() => router.refresh());
  }, [visible, selected, send, router]);

  const allSelected = visible.length > 0 && selected.size === visible.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map(e => e.id)));
  const toggleOne = (id: string) =>
    setSelected(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const busy = processing.size > 0;

  if (visible.length === 0) {
    const remaining = Math.max(0, totalCount - dismissed.size);
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="h-8 w-8 text-emerald-400 mb-3" />
        <p className="text-sm font-medium">
          {remaining > 0 ? "This batch is cleared" : "Review queue is clear"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {remaining > 0
            ? `${remaining} more awaiting review — reload to load the next batch.`
            : "All events have been reviewed"}
        </p>
        {remaining > 0 && (
          <Button size="sm" variant="outline" className="mt-3 gap-1.5 text-xs" onClick={() => router.refresh()}>
            <RefreshCw className="h-3 w-3" />Load next batch
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Bulk action bar */}
      <div className="flex items-center gap-3 p-2 rounded-lg border border-border bg-card sticky top-0 z-10">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
          <span className="text-xs text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : `${visible.length} of ${totalCount} pending`}
          </span>
        </label>

        {selected.size > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-7 gap-1.5 text-xs border-emerald-500/30 hover:bg-emerald-500/10"
              onClick={() => actOnSelected("approve")}
            >
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              Approve {selected.size}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              className="h-7 gap-1.5 text-xs border-red-500/30 hover:bg-red-500/10"
              onClick={() => actOnSelected("reject")}
            >
              <XCircle className="h-3.5 w-3.5 text-red-400" />
              Reject {selected.size}
            </Button>
          </div>
        )}

        {(bulkProgress || isPending) && (
          <span className="text-[10px] text-muted-foreground ml-auto flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3 animate-spin" />
            {bulkProgress ?? "Refreshing…"}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {visible.map(event => (
        <ReviewCard
          key={event.id}
          event={event}
          isProcessing={processing.has(event.id)}
          isSelected={selected.has(event.id)}
          onToggleSelect={() => toggleOne(event.id)}
          onApprove={() => act(event.id, "approve")}
          onReject={() => act(event.id, "reject")}
        />
      ))}
    </div>
  );
}

function ReviewCard({ event, isProcessing, isSelected, onToggleSelect, onApprove, onReject }: {
  event: EventSummary;
  isProcessing: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const tcv = event.tcvCommittedUsd ?? event.tcvEstimateMidUsd;
  const confidence = event.confidenceScore;
  const confColor = confidence >= 0.75 ? "text-emerald-400" : confidence >= 0.55 ? "text-yellow-400" : "text-red-400";

  return (
    <div className={cn(
      "p-3 rounded-lg border bg-card transition-all",
      isSelected ? "border-emerald-500/40 bg-emerald-500/[0.03]" : "border-border",
      isProcessing && "opacity-50 pointer-events-none",
    )}>
      <div className="flex items-start gap-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
          aria-label="Select event"
          className="mt-0.5 shrink-0"
        />
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
