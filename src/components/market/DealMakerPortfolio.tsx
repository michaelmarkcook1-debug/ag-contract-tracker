"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RenewalRow } from "@/lib/dealmaker/data";
import { AUTOMATION_TIERS, AUTOMATION_LABELS, type AutomationTier } from "@/lib/dealmaker/grades";

interface Portfolio {
  kpis: { contracts: number; tcvUsd: number; megaDeals: { count: number; tcvUsd: number; names: string[] }; criticalOrUrgent: number; highAutomation: number; usingAI: number; highChurn: number };
  riskMix: { key: string; count: number }[];
  riskByServiceLine: ({ name: string; hot: number } & Record<string, number | string>)[];
  automationByTcv: { key: AutomationTier; tcvUsd: number; count: number }[];
  aiByAutomation: ({ ai: string } & Record<string, number | string>)[];
  critical: (RenewalRow & { priority: number })[];
}

const money = (v: number | null | undefined) => v == null || v <= 0 ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}m` : `$${(v / 1e3).toFixed(0)}k`;
const RISK: { key: string; label: string; cls: string }[] = [
  { key: "critical", label: "Critical", cls: "bg-red-500" }, { key: "urgent", label: "Urgent", cls: "bg-orange-500" },
  { key: "concern", label: "Some concerns", cls: "bg-amber-500" }, { key: "standard", label: "Standard", cls: "bg-zinc-500" }, { key: "positive", label: "Positive", cls: "bg-brand" },
];
const AI_LABEL: Record<string, string> = { active: "AI active", high: "High potential", moderate: "Moderate", low: "Low potential", limited: "Limited" };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-border/50 bg-card/50 p-4 min-w-0"><h3 className="text-xs font-medium text-muted-foreground mb-3">{title}</h3>{children}</div>;
}
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
/** Single-series ranked bars: one hue, magnitude only; the value is printed in text ink beside each bar. */
function Bars({ data }: { data: { label: string; value: number; display: string }[] }) {
  const max = Math.max(1, ...data.map(d => d.value));
  return (
    <ul className="space-y-2">
      {data.map(d => (
        <li key={d.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs" title={`${d.label}: ${d.display}`}>
          <span className="truncate text-foreground/85">{d.label}</span>
          <span className="h-2 rounded-full bg-foreground/[0.06] overflow-hidden"><span className="block h-full rounded-full bg-brand/70" style={{ width: `${(d.value / max) * 100}%` }} /></span>
          <span className="font-mono tabular-nums text-muted-foreground">{d.display}</span>
        </li>
      ))}
    </ul>
  );
}

export function DealMakerPortfolio({ onSelect }: { onSelect: (r: RenewalRow) => void }) {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/dealmaker/portfolio", { signal: ac.signal })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<Portfolio>; })
      .then(setData)
      .catch(e => { if ((e as Error).name !== "AbortError") setError("Could not load the portfolio assessment."); });
    return () => ac.abort();
  }, []);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading the portfolio…</p>;
  const k = data.kpis;
  const total = Math.max(1, data.riskMix.reduce((s, r) => s + r.count, 0));

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every live contract that has not yet ended: {k.contracts.toLocaleString()} contracts, {money(k.tcvUsd)} stated or estimated value
        {k.megaDeals.count > 0 && <> excluding {k.megaDeals.count} contracts over $10bn ({money(k.megaDeals.tcvUsd)}), which would outweigh everything else: <span title={k.megaDeals.names.join("; ")} className="underline decoration-dotted underline-offset-2">{k.megaDeals.names.slice(0, 2).join("; ")}{k.megaDeals.count > 2 ? "…" : ""}</span></>}.
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Critical or urgent risk" value={k.criticalOrUrgent.toLocaleString()} sub="large contracts near expiry, or a stressed incumbent" />
        <Kpi label="High automation potential" value={k.highAutomation.toLocaleString()} sub="AI-suited scope, over $100m" />
        <Kpi label="Already using AI" value={k.usingAI.toLocaleString()} sub="AI in the contract's scope" />
        <Kpi label="High churn risk" value={k.highChurn.toLocaleString()} sub="critical or elevated" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card title="Risk mix">
          {/* One stacked bar with a legend: each segment is labelled, so colour is never the only key. */}
          <div className="flex h-3 w-full overflow-hidden rounded-full gap-[2px]">
            {RISK.map(r => { const c = data.riskMix.find(x => x.key === r.key)?.count ?? 0; return c ? <span key={r.key} className={r.cls} style={{ width: `${(c / total) * 100}%` }} title={`${r.label}: ${c}`} /> : null; })}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {RISK.map(r => <li key={r.key} className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", r.cls)} /><span className="text-foreground/85">{r.label}</span><span className="ml-auto font-mono tabular-nums text-muted-foreground">{(data.riskMix.find(x => x.key === r.key)?.count ?? 0).toLocaleString()}</span></li>)}
          </ul>
        </Card>
        <Card title="Critical and urgent contracts by service line">
          <Bars data={data.riskByServiceLine.filter(r => r.hot > 0).map(r => ({ label: r.name, value: r.hot, display: String(r.hot) }))} />
        </Card>
        <Card title="Contract value by automation potential">
          <Bars data={data.automationByTcv.map(a => ({ label: AUTOMATION_LABELS[a.key].replace(/ \(.*\)$/, ""), value: a.tcvUsd, display: `${money(a.tcvUsd)} · ${a.count}` }))} />
        </Card>
        <Card title="AI readiness × automation potential (contracts)">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-muted-foreground"><th className="text-left font-medium py-1 pr-2">AI readiness</th>{AUTOMATION_TIERS.map(t => <th key={t} className="text-right font-medium py-1 px-1 whitespace-nowrap">{AUTOMATION_LABELS[t].replace(/ \(.*\)$/, "")}</th>)}</tr></thead>
              <tbody className="divide-y divide-border/30">
                {data.aiByAutomation.map(row => (
                  <tr key={row.ai}><td className="py-1 pr-2 text-foreground/85">{AI_LABEL[row.ai] ?? row.ai}</td>
                    {AUTOMATION_TIERS.map(t => <td key={t} className="py-1 px-1 text-right font-mono tabular-nums">{Number(row[t] ?? 0) ? Number(row[t]).toLocaleString() : <span className="text-muted-foreground/40">·</span>}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Most critical contracts · risk × urgency × value">
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full text-xs min-w-[760px]">
            <thead className="text-muted-foreground"><tr className="text-left">{["#", "Vendor", "Client", "Service line", "Value", "Ends", "Risk", "Urgency", "Priority"].map(h => <th key={h} className="py-1.5 pr-3 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-border/30">
              {data.critical.map((r, i) => (
                <tr key={r.id} onClick={() => onSelect(r)} className="cursor-pointer hover:bg-foreground/[0.03]">
                  <td className="py-1.5 pr-3 text-muted-foreground tabular-nums">{i + 1}</td>
                  <td className="py-1.5 pr-3 font-medium whitespace-nowrap">{r.vendor}</td>
                  <td className="py-1.5 pr-3 max-w-[14rem] truncate">{r.client ?? "—"}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-foreground/85">{r.serviceLine ?? "—"}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums whitespace-nowrap">{money(r.tcvUsd)}</td>
                  <td className="py-1.5 pr-3 tabular-nums whitespace-nowrap">{r.end}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.risk.label}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.urgency.label}</td>
                  <td className="py-1.5 pr-3 font-mono tabular-nums">{r.priority}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
