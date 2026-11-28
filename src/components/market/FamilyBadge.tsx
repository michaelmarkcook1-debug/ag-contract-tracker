"use client";

import { Badge } from "@/components/ui/badge";
import { FAMILY_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FAMILY_SERIES } from "@/lib/chart-theme";


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
  // The type's chart colour marks identity on a dot; the label stays in text ink (text never wears a series colour).
  return (
    <Badge variant="outline" className={cn("text-xs font-medium shrink-0 gap-1.5 border-border bg-card text-foreground/80", className)}>
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: FAMILY_SERIES[family] ?? "var(--series-other)" }} />
      {FAMILY_LABELS[family as keyof typeof FAMILY_LABELS] ?? family}
    </Badge>
  );
}
