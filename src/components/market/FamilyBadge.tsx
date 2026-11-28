"use client";

import { Badge } from "@/components/ui/badge";
import { FAMILY_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  CONTRACT: "bg-brand/15 text-brand border-brand/30",
  FINANCIAL_RESULTS: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  M_AND_A: "bg-violet-500/15 text-violet-600 dark:text-violet-400 border-violet-500/30",
  PARTNERSHIP: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  NEW_OFFERING: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  ORG_CHANGE: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

/** Shown on events that are not a win: a contract that ended or is in dispute, or a rumour nobody has confirmed. */
export function EventStatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const s = status?.toUpperCase();
  if (s === "RUMOURED") return (
    <Badge variant="outline" className={cn("text-[10px] font-medium shrink-0 bg-amber-500/10 text-amber-500 border-amber-500/30", className)} title="Reported but not confirmed by the parties — not counted in totals or contract value">
      Rumour
    </Badge>
  );
  if (s !== "TERMINATED" && s !== "DISPUTED") return null;
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium shrink-0 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30", className)} title="Not won business — excluded from deal counts and contract value">
      {s === "TERMINATED" ? "Terminated" : "Disputed"}
    </Badge>
  );
}

export function FamilyBadge({ family, className }: { family: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs font-medium shrink-0", STYLES[family] ?? "bg-zinc-500/15 text-muted-foreground border-zinc-500/30", className)}>
      {FAMILY_LABELS[family as keyof typeof FAMILY_LABELS] ?? family}
    </Badge>
  );
}
