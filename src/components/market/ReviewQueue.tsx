"use client";

import { useState, useCallback, useEffect, useMemo, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { displayTitle, EventSummary, formatDate, formatTcvDisplay, tcvEstimateTitle } from "@/lib/types";
import { reviewGroup, reviewDetail, GROUP_ORDER } from "@/lib/review-reasons";
import { FamilyBadge } from "./FamilyBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckCircle2, XCircle, MapPin, Building2, ExternalLink, AlertCircle, RefreshCw, Undo2, Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReviewQueueProps {
  initialEvents: EventSummary[];
  totalCount: number;
}

type Action = "approve" | "reject";
interface Done { ids: string[]; action: Action }

/** One request for any number of events (POST /api/events/review). */
async function review(ids: string[], action: Action | "undo"): Promise<string[]> {
  const res = await fetch("/api/events/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids, action }),
  });
  // fetch() does not throw on 4xx/5xx — an unchecked failure would silently
  // drop the card from the UI and bring it back on reload.
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { success?: boolean; changed?: string[] };
  if (!data.success) throw new Error("not saved");
  return data.changed ?? [];
}

export function ReviewQueue({ initialEvents, totalCount }: ReviewQueueProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [group, setGroup] = useState<string>("all");
  const [focus, setFocus] = useState(0);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Done | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  const remaining = useMemo(() => initialEvents.filter(e => !dismissed.has(e.id)), [initialEvents, dismissed]);
  const groups = useMemo(() => {
    const counts = new Map<string, { label: string; hint: string; n: number }>();
    for (const e of remaining) {
      const g = reviewGroup(e.reviewReason);
      const c = counts.get(g.key) ?? { label: g.label, hint: g.hint, n: 0 };
      c.n++; counts.set(g.key, c);
    }
    return GROUP_ORDER.filter(k => counts.has(k)).map(k => ({ key: k, ...counts.get(k)! }));
  }, [remaining]);
  const visible = useMemo(() => group === "all" ? remaining : remaining.filter(e => reviewGroup(e.reviewReason).key === group), [remaining, group]);
  const activeGroup = groups.find(g => g.key === group);

  // A group emptied by approvals falls back to the whole queue.
  useEffect(() => { if (group !== "all" && !activeGroup) setGroup("all"); }, [group, activeGroup]);
  useEffect(() => { setFocus(f => Math.min(f, Math.max(0, visible.length - 1))); }, [visible.length]);
  useEffect(() => {
    const id = visible[focus]?.id;
    if (id) cardRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, [focus, visible]);

  /** Optimistic: cards leave at once and come back if the save fails. */
  const run = useCallback(async (ids: string[], action: Action) => {
    if (ids.length === 0) return;
    setError(null); setConfirm(null); setBusy(true);
    setDismissed(prev => new Set([...prev, ...ids]));
    setSelected(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
    try {
      const changed = await review(ids, action);
      setLast({ ids: changed, action });
      const missed = ids.filter(id => !changed.includes(id));
      if (missed.length) setError(`${missed.length} were no longer in the queue (already reviewed elsewhere).`);
      startTransition(() => router.refresh());
    } catch {
      setDismissed(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s; });
      setError(`Could not ${action} ${ids.length === 1 ? "that event" : `${ids.length} events`} — nothing was changed.`);
    } finally {
      setBusy(false);
    }
  }, [router]);

  const undo = useCallback(async () => {
    if (!last) return;
    setError(null); setBusy(true);
    try {
      await review(last.ids, "undo");
      setDismissed(prev => { const s = new Set(prev); last.ids.forEach(id => s.delete(id)); return s; });
      setLast(null);
      startTransition(() => router.refresh());
    } catch {
      setError("Undo failed — the events kept their new status.");
    } finally {
      setBusy(false);
    }
  }, [last, router]);

  const toggleOne = useCallback((id: string) =>
    setSelected(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; }), []);

  // Keyboard: j/k or arrows move, a approve, r reject, x select, o open, u undo.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (ev.metaKey || ev.ctrlKey || ev.altKey || t?.closest("input, textarea, select, [contenteditable=true]")) return;
      const cur = visible[focus];
      switch (ev.key) {
        case "j": case "ArrowDown": setFocus(f => Math.min(f + 1, visible.length - 1)); break;
        case "k": case "ArrowUp": setFocus(f => Math.max(f - 1, 0)); break;
        case "a": if (cur && !busy) run(selected.size ? [...selected] : [cur.id], "approve"); break;
        case "r": if (cur && !busy) run(selected.size ? [...selected] : [cur.id], "reject"); break;
        case "x": if (cur) toggleOne(cur.id); break;
        case "o": if (cur?.originalArticleUrl) window.open(cur.originalArticleUrl, "_blank", "noopener"); break;
        case "u": if (!busy) undo(); break;
        case "Escape": setConfirm(null); setSelected(new Set()); break;
        default: return;
      }
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, focus, busy, selected, run, undo, toggleOne]);

  const allSelected = visible.length > 0 && visible.every(e => selected.has(e.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map(e => e.id)));

  if (remaining.length === 0) {
    const left = Math.max(0, totalCount - dismissed.size);
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <CheckCircle2 className="h-8 w-8 text-emerald-400 mb-3" />
        <p className="text-sm font-medium">{left > 0 ? "This batch is cleared" : "Review queue is clear"}</p>
        {last && <Button size="sm" variant="outline" className="mt-3 gap-1.5 text-xs" onClick={undo} disabled={busy}><Undo2 className="h-3 w-3" />Undo last ({last.ids.length})</Button>}
        {left > 0 && (
          <Button size="sm" variant="outline" className="mt-3 gap-1.5 text-xs" onClick={() => router.refresh()}>
            <RefreshCw className="h-3 w-3" />Load next batch
          </Button>
        )}
      </div>
    );
  }

  const groupIds = visible.map(e => e.id);

  return (
    <div className="space-y-2">
      {/* Groups — why each item is held */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4 md:mx-0 md:px-0 md:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <GroupChip active={group === "all"} onClick={() => { setGroup("all"); setFocus(0); setConfirm(null); }} label="All" n={remaining.length} />
        {groups.map(g => (
          <GroupChip key={g.key} active={group === g.key} onClick={() => { setGroup(g.key); setFocus(0); setConfirm(null); setSelected(new Set()); }} label={g.label} n={g.n} />
        ))}
      </div>

      {/* Group hint + one-click group actions */}
      {activeGroup && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 rounded-lg border border-border bg-card/60">
          <p className="text-xs text-muted-foreground flex-1">{activeGroup.hint}</p>
          {confirm ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-xs">{confirm === "approve" ? "Approve" : "Reject"} all {groupIds.length}?</span>
              <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => run(groupIds, confirm)}>Confirm</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirm(null)}>Cancel</Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 shrink-0">
              <Button size="sm" variant="outline" disabled={busy} className="h-7 gap-1.5 text-xs border-emerald-500/30 hover:bg-emerald-500/10" onClick={() => setConfirm("approve")}>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />Approve all {groupIds.length}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} className="h-7 gap-1.5 text-xs border-red-500/30 hover:bg-red-500/10" onClick={() => setConfirm("reject")}>
                <XCircle className="h-3.5 w-3.5 text-red-400" />Reject all {groupIds.length}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Selection bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-2 rounded-lg border border-border bg-card sticky top-12 md:top-14 z-10">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all shown" />
          <span className="text-xs text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : `${visible.length} shown · ${remaining.length} in queue`}
          </span>
        </label>
        {selected.size > 0 && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} className="h-7 gap-1.5 text-xs border-emerald-500/30 hover:bg-emerald-500/10" onClick={() => run([...selected], "approve")}>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />Approve {selected.size}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} className="h-7 gap-1.5 text-xs border-red-500/30 hover:bg-red-500/10" onClick={() => run([...selected], "reject")}>
              <XCircle className="h-3.5 w-3.5 text-red-400" />Reject {selected.size}
            </Button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {(busy || isPending) && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
          {last && (
            <Button size="sm" variant="ghost" disabled={busy} className="h-7 gap-1.5 text-xs" onClick={undo} title="Undo (u)">
              <Undo2 className="h-3.5 w-3.5" />Undo {last.action} ({last.ids.length})
            </Button>
          )}
          <span className="hidden lg:flex items-center gap-1 text-[10px] text-zinc-500">
            <Keyboard className="h-3 w-3" />
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject · <Kbd>x</Kbd> select · <Kbd>o</Kbd> source · <Kbd>u</Kbd> undo
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {visible.map((event, i) => (
        <ReviewCard
          key={event.id}
          cardRef={el => { if (el) cardRefs.current.set(event.id, el); else cardRefs.current.delete(event.id); }}
          event={event}
          focused={i === focus}
          isSelected={selected.has(event.id)}
          onFocus={() => setFocus(i)}
          onToggleSelect={() => toggleOne(event.id)}
          onApprove={() => run([event.id], "approve")}
          onReject={() => run([event.id], "reject")}
        />
      ))}
    </div>
  );
}

/** Older imported rows carry raw feed HTML as their summary; show text only. */
function readable(s: string | null): string | null {
  if (!s) return null;
  const t = s.replace(/<[^>]*(>|$)/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return t && !/^(https?:\/\/|href=)/i.test(t) ? t : null;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded bg-foreground/[0.08] px-1 font-mono text-[10px] text-zinc-400">{children}</kbd>;
}

function GroupChip({ active, onClick, label, n }: { active: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 md:py-1 rounded-full text-xs font-medium transition-colors border",
        active ? "bg-foreground text-background border-foreground" : "border-border text-muted-foreground hover:text-foreground hover:border-zinc-500",
      )}
    >
      {label}
      <span className={cn("tabular-nums text-[10px]", active ? "text-background/70" : "text-zinc-500")}>{n}</span>
    </button>
  );
}

function ReviewCard({ cardRef, event, focused, isSelected, onFocus, onToggleSelect, onApprove, onReject }: {
  cardRef: (el: HTMLDivElement | null) => void;
  event: EventSummary;
  focused: boolean;
  isSelected: boolean;
  onFocus: () => void;
  onToggleSelect: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const tcvLabel = formatTcvDisplay(event);   // §16 disclosed | Est. range | withheld
  const g = reviewGroup(event.reviewReason);
  const detail = reviewDetail(event.reviewReason);
  // A score is shown only when something measured it; an asserted 1.0 means
  // "nobody computed this", not "certain" (gate.ts).
  const measured = event.confidenceBasis === "measured";
  const confColor = event.confidenceScore >= 0.75 ? "text-emerald-400" : event.confidenceScore >= 0.55 ? "text-yellow-400" : "text-red-400";
  const context = readable(event.scopeSummary) ?? readable(event.analystInsight);

  return (
    <div
      ref={cardRef}
      onClick={onFocus}
      className={cn(
        "p-3 rounded-lg border bg-card transition-colors scroll-mt-32 scroll-mb-4",
        isSelected ? "border-emerald-500/40 bg-emerald-500/[0.03]" : "border-border",
        focused && "ring-1 ring-foreground/40",
      )}
    >
      <div className="flex items-start gap-3">
        <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} aria-label="Select event" className="mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <FamilyBadge family={event.family} />
            <span className="text-[10px] font-medium text-amber-400/90 bg-amber-500/10 rounded px-1.5 py-0.5" title={event.reviewReason ?? undefined}>{g.label}</span>
            {event.industry && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5"><Building2 className="h-2.5 w-2.5" />{event.industry}</span>
            )}
            {event.geography.length > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{event.geography.slice(0, 2).join(", ")}</span>
            )}
            {measured && <span className={cn("text-[10px] font-mono ml-auto", confColor)}>{(event.confidenceScore * 100).toFixed(0)}% conf</span>}
          </div>

          <p className="text-sm font-medium leading-snug line-clamp-2">{displayTitle(event.canonicalTitle)}</p>
          {context && <p className="text-xs text-muted-foreground line-clamp-2">{context}</p>}
          {detail && <p className="text-[11px] text-zinc-500 italic line-clamp-2">{detail}</p>}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            {event.vendorName && <span className="font-medium text-foreground/70">{event.vendorName}</span>}
            {event.clientName && !event.clientAnonymised && <span>→ {event.clientName}</span>}
            {tcvLabel !== "Not reliably estimable" && <span className="font-mono text-emerald-400/80" title={tcvEstimateTitle(event)}>{tcvLabel}</span>}
            {event.primaryMacroServiceLine && <span>{event.primaryMacroServiceLine}</span>}
            <span className="text-zinc-600">{formatDate(event.announcementDate)}</span>
            {event.originalArticleUrl && (
              <a href={event.originalArticleUrl} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-foreground flex items-center gap-0.5 transition-colors" onClick={e => e.stopPropagation()}>
                source <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size="icon" variant="outline" className="h-8 w-8 md:h-7 md:w-7 border-emerald-500/30 hover:bg-emerald-500/10 hover:border-emerald-500/50" onClick={e => { e.stopPropagation(); onApprove(); }} title="Approve (a)">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          </Button>
          <Button size="icon" variant="outline" className="h-8 w-8 md:h-7 md:w-7 border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50" onClick={e => { e.stopPropagation(); onReject(); }} title="Reject (r)">
            <XCircle className="h-3.5 w-3.5 text-red-400" />
          </Button>
        </div>
      </div>
    </div>
  );
}
