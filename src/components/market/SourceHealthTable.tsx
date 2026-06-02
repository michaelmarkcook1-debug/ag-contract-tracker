"use client";

import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/types";
import { cn } from "@/lib/utils";

interface SourceItem {
  id: string;
  name: string;
  provider: string;
  sourceType: string;
  tier: string;
  isActive: boolean;
  lastCrawledAt: string | null;
  lastItemCount: number;
  consecutiveErrors: number;
  lastError: string | null;
}

export function SourceHealthTable({ sources }: { sources: SourceItem[] }) {
  const tierColor = (tier: string) =>
    tier === "tier_1_primary"
      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
      : "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";

  const healthIndicator = (item: SourceItem) => {
    if (!item.isActive) return { color: "bg-zinc-500", label: "Inactive" };
    if (item.consecutiveErrors >= 3) return { color: "bg-red-500", label: `${item.consecutiveErrors} errors` };
    if (item.consecutiveErrors > 0) return { color: "bg-yellow-500", label: "1 error" };
    if (!item.lastCrawledAt) return { color: "bg-zinc-600", label: "Not yet crawled" };
    return { color: "bg-emerald-500", label: "OK" };
  };

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-zinc-900/50">
            <th className="text-left px-3 py-2 text-muted-foreground font-medium w-2"></th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Source</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Tier</th>
            <th className="text-left px-3 py-2 text-muted-foreground font-medium">Last crawled</th>
            <th className="text-right px-3 py-2 text-muted-foreground font-medium">Items</th>
          </tr>
        </thead>
        <tbody>
          {sources.map(src => {
            const health = healthIndicator(src);
            return (
              <tr key={src.id} className="border-b border-border/50 hover:bg-zinc-900/30 transition-colors">
                <td className="px-3 py-2">
                  <div className={cn("h-2 w-2 rounded-full", health.color)} title={health.label} />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground/80">{src.provider}</div>
                  <div className="text-zinc-600">{src.name}</div>
                </td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className={cn("text-[10px] py-0 h-4", tierColor(src.tier))}>
                    {src.tier === "tier_1_primary" ? "T1" : "T2"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {src.lastCrawledAt ? formatDate(src.lastCrawledAt) : "—"}
                  {src.lastError && (
                    <div className="text-red-400 text-[10px] truncate max-w-32" title={src.lastError}>
                      {src.lastError.slice(0, 40)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                  {src.lastItemCount > 0 ? src.lastItemCount : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
