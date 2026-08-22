"use client";

import { Badge } from "@/components/ui/badge";
import { FAMILY_LABELS } from "@/lib/types";
import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  CONTRACT: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  FINANCIAL_RESULTS: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  M_AND_A: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  PARTNERSHIP: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  NEW_OFFERING: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  ORG_CHANGE: "bg-rose-500/15 text-rose-400 border-rose-500/30",
};

export function FamilyBadge({ family, className }: { family: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("text-xs font-medium shrink-0", STYLES[family] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", className)}>
      {FAMILY_LABELS[family as keyof typeof FAMILY_LABELS] ?? family}
    </Badge>
  );
}
