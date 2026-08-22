"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RefreshCw, Coins, Layers, Calculator } from "lucide-react";

interface CostData {
  tiers: Record<string, { model: string; pricing: { inputPerM: number; outputPerM: number }; costPerCall: number }>;
  totals: { costUsd: number; inputTokens: number; outputTokens: number; extractions: number };
  perArticle: { measured: number | null; modelledMax: number; modelledMin: number };
  recentRuns: {
    id: string; runType: string; startedAt: string; status: string;
    eventsExtracted: number; articlesFound: number;
    inputTokens: number; outputTokens: number; costUsd: number; costPerArticle: number;
  }[];
}

const usd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const num = (n: number) => n.toLocaleString("en-GB");

export function CostPanel() {
  const [data, setData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [planned, setPlanned] = useState("500");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/costs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cost data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading && !data) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
      <RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading cost data…
    </div>;
  }
  if (error) {
    return <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>;
  }
  if (!data) return null;

  const n = Math.max(0, parseInt(planned) || 0);
  // Estimate from measured cost-per-article where we have history, otherwise
  // bracket it with the modelled best/worst case.
  const lo = n * data.perArticle.modelledMin;
  const hi = n * data.perArticle.modelledMax;
  const mid = data.perArticle.measured != null ? n * data.perArticle.measured : (lo + hi) / 2;

  return (
    <div className="space-y-4">
      {/* Model tiers */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Layers className="h-4 w-4 text-cyan-400" />Model tiers
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {Object.entries(data.tiers).map(([tier, t]) => (
            <div key={tier} className="flex items-center justify-between text-xs p-2 rounded-md bg-muted/30">
              <div>
                <span className="font-medium capitalize">{tier}</span>
                <code className="ml-2 text-[10px] text-muted-foreground">{t.model}</code>
              </div>
              <div className="text-right text-muted-foreground">
                <div className="font-mono">${t.pricing.inputPerM}/M in · ${t.pricing.outputPerM}/M out</div>
                <div className="text-[10px]">≈{usd(t.costPerCall)} per call</div>
              </div>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground pt-1">
            Every article gets triage. Only contracts and M&amp;A are promoted to the analysis tier —
            everything else stops after triage, which is where the saving comes from.
          </p>
        </CardContent>
      </Card>

      {/* Estimator */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Calculator className="h-4 w-4 text-emerald-400" />Estimate a run
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Articles to process</label>
            <Input value={planned} onChange={e => setPlanned(e.target.value.replace(/\D/g, ""))}
              className="h-8 w-28 text-xs font-mono" inputMode="numeric" />
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2 rounded-md bg-muted/30">
              <div className="font-mono text-sm text-emerald-400">{usd(lo)}</div>
              <div className="text-[10px] text-muted-foreground">min (all filtered at triage)</div>
            </div>
            <div className="p-2 rounded-md bg-emerald-500/10 border border-emerald-500/20">
              <div className="font-mono text-base font-bold text-emerald-400">{usd(mid)}</div>
              <div className="text-[10px] text-muted-foreground">
                {data.perArticle.measured != null ? "expected (measured)" : "expected (modelled)"}
              </div>
            </div>
            <div className="p-2 rounded-md bg-muted/30">
              <div className="font-mono text-sm text-amber-400">{usd(hi)}</div>
              <div className="text-[10px] text-muted-foreground">max (all deep-analysed)</div>
            </div>
          </div>
          {data.perArticle.measured != null && (
            <p className="text-[10px] text-muted-foreground">
              Based on {num(data.totals.extractions)} real extractions averaging {usd(data.perArticle.measured)} each.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Spend to date */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Coins className="h-4 w-4 text-amber-400" />Spend to date
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-2 text-center text-xs">
            <div><div className="font-mono text-base font-bold text-amber-400">{usd(data.totals.costUsd)}</div>total</div>
            <div><div className="font-mono text-base">{num(data.totals.extractions)}</div>extractions</div>
            <div><div className="font-mono text-base">{num(data.totals.inputTokens)}</div>input tokens</div>
            <div><div className="font-mono text-base">{num(data.totals.outputTokens)}</div>output tokens</div>
          </div>
          {data.totals.costUsd === 0 && (
            <p className="text-[10px] text-muted-foreground mt-2">
              No spend recorded yet — cost tracking starts with the next run.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Recent runs */}
      {data.recentRuns.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              Recent run costs
              <Button size="sm" variant="ghost" className="h-6 gap-1 text-[10px]" onClick={load}>
                <RefreshCw className="h-3 w-3" />Refresh
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {data.recentRuns.map(r => (
              <div key={r.id} className="flex items-center justify-between text-[11px] py-1 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" className="text-[9px] px-1 py-0">{r.runType}</Badge>
                  <span className="text-muted-foreground truncate">
                    {new Date(r.startedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0 font-mono">
                  <span className="text-muted-foreground">{r.eventsExtracted} ext</span>
                  <span className="text-muted-foreground">{num(r.inputTokens + r.outputTokens)} tok</span>
                  <span className="text-amber-400 w-16 text-right">{usd(r.costUsd)}</span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
