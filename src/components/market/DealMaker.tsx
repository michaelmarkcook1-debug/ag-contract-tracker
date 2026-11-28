"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ExternalLink, RefreshCw, Search, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RenewalRow } from "@/lib/dealmaker/data";
import { WINDOWS, ACTION_LABELS, AUTOMATION_TIERS, AUTOMATION_LABELS, TCV_BUCKETS, type WindowKey, type AutomationTier } from "@/lib/dealmaker/grades";
import { CATEGORIES } from "@/lib/dealmaker/news-categories";
import { DealMakerPortfolio } from "./DealMakerPortfolio";

interface Response {
  model: { version: string; contracts: number; families: number; judged: number; globalRenewalRate: number; globalRetention: number; computedAt: string };
  kpis: { upForRenewal: number; renewalTcvUsd: number; windows: { key: WindowKey; count: number; tcvUsd: number }[]; recentlyEnded: number; pitch: number; defend: number };
  charts: { byServiceLine: { name: string; tcv: number }[]; byIndustry: { name: string; tcv: number }[] };
  facets: { vendors: string[]; serviceLines: string[]; regions: string[]; countries: string[]; industries: string[] };
  newsFetchedAt: string | null;
  total: number;
  rows: RenewalRow[];
}

const money = (v: number | null | undefined) => v == null || v <= 0 ? "—" : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}m` : `$${(v / 1e3).toFixed(0)}k`;
const WINDOW_LABEL: Record<string, string> = Object.fromEntries(WINDOWS.map(w => [w.key, w.label]));

/** Tones for grade keys: text tokens stay neutral; the dot carries the colour. */
const TONE: Record<string, string> = {
  critical: "bg-red-500", urgent: "bg-orange-500", expired: "bg-zinc-400", near: "bg-amber-500", mid: "bg-sky-500", early: "bg-zinc-500", unknown: "bg-zinc-600",
  concern: "bg-amber-500", standard: "bg-zinc-500", positive: "bg-brand", elevated: "bg-orange-500", moderate: "bg-sky-500", low: "bg-zinc-500",
  active: "bg-brand", high: "bg-violet-500", limited: "bg-zinc-600",
  "high-potential": "bg-violet-500", "low-potential": "bg-zinc-600",
};
const RISK_LABELS: Record<string, string> = { critical: "Critical", urgent: "Urgent", concern: "Some concerns", standard: "Standard", positive: "Positive" };
const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));
function Pill({ k, label, tip }: { k: string; label: string; tip?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-foreground/85" title={tip}>
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", TONE[k] ?? "bg-zinc-500")} />{label}
    </span>
  );
}
function Score({ v, invert }: { v: number; invert?: boolean }) {
  const hot = invert ? v < 40 : v >= 65;
  return <span className={cn("font-mono text-xs tabular-nums", hot ? "text-foreground font-semibold" : "text-muted-foreground")}>{v}</span>;
}
function ActionTag({ a }: { a: RenewalRow["action"] }) {
  if (!a) return <span className="text-muted-foreground/50 text-xs">—</span>;
  const cls = a === "pitch" ? "border-brand/40 text-brand" : a === "defend" ? "border-sky-500/40 text-sky-600 dark:text-sky-400" : "border-zinc-500/40 text-muted-foreground";
  return <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap", cls)}>{ACTION_LABELS[a]}</span>;
}

/** A ranked list with a single-hue bar per row (magnitude only). */
function Bars({ title, data }: { title: string; data: { name: string; tcv: number }[] }) {
  const max = Math.max(1, ...data.map(d => d.tcv));
  return (
    <div className="rounded-xl border border-border/50 bg-card/50 p-4 min-w-0">
      <h3 className="text-xs font-medium text-muted-foreground mb-3">{title}</h3>
      <ul className="space-y-2">
        {data.map(d => (
          <li key={d.name} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs" title={`${d.name}: ${money(d.tcv)}`}>
            <span className="truncate text-foreground/85">{d.name}</span>
            <span className="h-2 rounded-full bg-foreground/[0.06] overflow-hidden"><span className="block h-full rounded-full bg-brand/70" style={{ width: `${(d.tcv / max) * 100}%` }} /></span>
            <span className="font-mono tabular-nums text-muted-foreground">{money(d.tcv)}</span>
          </li>
        ))}
        {!data.length && <li className="text-xs text-muted-foreground">No values stated</li>}
      </ul>
    </div>
  );
}

function Select({ label, value, options, onChange, render }: { label: string; value: string; options: string[]; onChange: (v: string) => void; render?: (o: string) => string }) {
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)}
      className="h-8 max-w-[12rem] rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-brand/40">
      <option value="">{label}</option>
      {options.map(o => <option key={o} value={o}>{render ? render(o) : o}</option>)}
    </select>
  );
}

export function DealMaker() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowKey[]>(["0-3", "3-6", "6-12"]);
  const [vendor, setVendor] = useState(""), [serviceLine, setServiceLine] = useState(""), [region, setRegion] = useState(""), [industry, setIndustry] = useState("");
  const [action, setAction] = useState(""), [sort, setSort] = useState("risk"), [q, setQ] = useState(""), [query, setQuery] = useState("");
  const [country, setCountry] = useState(""), [risk, setRisk] = useState(""), [automation, setAutomation] = useState(""), [bucket, setBucket] = useState("");
  const [tab, setTab] = useState<"renewals" | "portfolio">("renewals");
  const [selected, setSelected] = useState<RenewalRow | null>(null);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (windows.length) p.set("window", windows.join(","));
    for (const [k, v] of Object.entries({ vendor, serviceLine, region, country, industry, action, risk, automation, tcvBucket: bucket, sort, q: query })) if (v) p.set(k, v);
    return p.toString();
  }, [windows, vendor, serviceLine, region, country, industry, action, risk, automation, bucket, sort, query]);

  // State is only set in the request's callbacks; the previous request is aborted when the filters change.
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/dealmaker/renewals?${params}`, { signal: ac.signal })
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() as Promise<Response>; })
      .then(json => { setData(json); setError(null); setLoading(false); })
      .catch(e => { if ((e as Error).name !== "AbortError") { setError("Could not load renewals. Try again in a moment."); setLoading(false); } });
    return () => ac.abort();
  }, [params]);

  const toggleWindow = (k: WindowKey) => { setLoading(true); setWindows(w => w.includes(k) ? w.filter(x => x !== k) : [...w, k]); };
  const set = (f: (v: string) => void) => (v: string) => { setLoading(true); f(v); };
  const k = data?.kpis;

  return (
    <div className="px-4 py-5 md:px-6 md:py-8 space-y-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2"><Target className="h-5 w-5 text-brand" />Deal Maker</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          What&apos;s winnable: contracts coming up for renewal, scored for how likely the scope is to come back to market and how exposed the incumbent is.
        </p>
      </div>

      <div className="flex gap-1 border-b border-border/50" role="tablist">
        {([["renewals", "Upcoming renewals"], ["portfolio", "Portfolio assessment"]] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cn("px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors", tab === k ? "border-brand text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>

      {tab === "portfolio" ? <DealMakerPortfolio onSelect={setSelected} /> : <>
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-border/50 bg-card/50 p-4">
          <p className="text-xs text-muted-foreground">Up for renewal · 18 months</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{k ? k.upForRenewal.toLocaleString() : "—"}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{k ? `${money(k.renewalTcvUsd)} stated or estimated value` : " "}</p>
        </div>
        {(k?.windows ?? []).slice(0, 2).map(w => (
          <div key={w.key} className="rounded-xl border border-border/50 bg-card/50 p-4">
            <p className="text-xs text-muted-foreground">Ending in {WINDOW_LABEL[w.key]}</p>
            <p className="text-2xl font-bold tabular-nums mt-1">{w.count.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{money(w.tcvUsd)}</p>
          </div>
        ))}
        <div className="rounded-xl border border-border/50 bg-card/50 p-4">
          <p className="text-xs text-muted-foreground">Suggested plays · 18 months</p>
          <p className="text-2xl font-bold tabular-nums mt-1">{k ? `${k.pitch} · ${k.defend}` : "—"}</p>
          <p className="text-xs text-muted-foreground mt-0.5">pitch · defend</p>
        </div>
      </div>

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Bars title="Renewal value by service line · next 18 months" data={data.charts.byServiceLine} />
          <Bars title="Renewal value by client industry · next 18 months" data={data.charts.byIndustry} />
        </div>
      )}

      {/* Filters */}
      <div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Expiry window">
          {WINDOWS.map(w => (
            <button key={w.key} onClick={() => toggleWindow(w.key)} aria-pressed={windows.includes(w.key)}
              className={cn("rounded-full px-2.5 py-1 text-xs font-medium transition-colors", windows.includes(w.key) ? "bg-foreground/10 text-foreground" : "text-muted-foreground/70 hover:bg-foreground/[0.04]")}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={e => { e.preventDefault(); setLoading(true); setQuery(q.trim()); }} className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/60" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search client, vendor, scope…" className="h-8 w-56 pl-8 text-xs" />
          </form>
          <Select label="Vendor" value={vendor} options={data?.facets.vendors ?? []} onChange={set(setVendor)} />
          <Select label="Service line" value={serviceLine} options={data?.facets.serviceLines ?? []} onChange={set(setServiceLine)} />
          <Select label="Region" value={region} options={data?.facets.regions ?? []} onChange={set(setRegion)} />
          <Select label="Country" value={country} options={data?.facets.countries ?? []} onChange={set(setCountry)} />
          <Select label="Industry" value={industry} options={data?.facets.industries ?? []} onChange={set(setIndustry)} />
          <Select label="Risk" value={risk} options={Object.keys(RISK_LABELS)} onChange={set(setRisk)} render={o => RISK_LABELS[o]} />
          <Select label="Automation" value={automation} options={[...AUTOMATION_TIERS]} onChange={set(setAutomation)} render={o => AUTOMATION_LABELS[o as AutomationTier]} />
          <Select label="Value" value={bucket} options={[...TCV_BUCKETS]} onChange={set(setBucket)} />
          <Select label="Suggested play" value={action} options={["pitch", "defend", "monitor"]} onChange={set(setAction)} render={o => ACTION_LABELS[o as "pitch"]} />
          <Select label="Sort" value={sort} options={["risk", "end", "tcv", "displacement", "renewal"]} onChange={set(setSort)}
            render={o => ({ risk: "Sort: risk", end: "Sort: end date", tcv: "Sort: value", displacement: "Sort: displacement risk", renewal: "Sort: renewal propensity" } as Record<string, string>)[o]} />
          {loading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Table */}
      <div className="rounded-xl border border-border/50 overflow-x-auto">
        <table className="w-full text-xs min-w-[960px]">
          <thead className="bg-foreground/[0.03] text-muted-foreground">
            <tr className="text-left">
              {["Vendor", "Client", "Service line", "Value", "Ends", ...(windows.includes("expired30") ? ["New vendor selected"] : []), "Urgency", "Risk", "Renewal", "Displacement", "AI", "Automation", "Play"].map(h => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {data?.rows.map(r => (
              <tr key={r.id} onClick={() => setSelected(r)} className="cursor-pointer hover:bg-foreground/[0.03]">
                <td className="px-3 py-2 font-medium text-foreground whitespace-nowrap">{r.vendor}</td>
                <td className="px-3 py-2 max-w-[14rem] truncate" title={r.client ?? ""}>{r.client ?? "—"}{r.clientAnonymised && r.client ? <span className="text-muted-foreground"> (undisclosed)</span> : null}</td>
                <td className="px-3 py-2 whitespace-nowrap text-foreground/85">{r.serviceLine ?? "—"}</td>
                <td className="px-3 py-2 font-mono tabular-nums whitespace-nowrap">{money(r.tcvUsd)}{r.tcvUsd && r.tcvIsEstimate ? <span className="text-muted-foreground"> est.</span> : null}</td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.end ?? "—"}{r.endBasis === "estimated" ? <span className="text-muted-foreground"> est.</span> : null}</td>
                {windows.includes("expired30") && <td className="px-3 py-2 whitespace-nowrap">{r.successor ? <Successor s={r.successor} /> : <span className="text-muted-foreground/50">—</span>}</td>}
                <td className="px-3 py-2"><Pill k={r.urgency.key} label={r.urgency.label} tip={r.urgency.tip} /></td>
                <td className="px-3 py-2"><Pill k={r.risk.key} label={r.risk.label} tip={r.risk.tip} /></td>
                <td className="px-3 py-2"><Score v={r.renewalProb} /></td>
                <td className="px-3 py-2"><Score v={r.displacementRisk} /></td>
                <td className="px-3 py-2"><Pill k={r.ai.key} label={r.ai.label} tip={r.ai.tip} /></td>
                <td className="px-3 py-2"><Pill k={r.automation} label={AUTOMATION_LABELS[r.automation].replace(/ \(.*\)$/, "")} /></td>
                <td className="px-3 py-2"><ActionTag a={r.action} /></td>
              </tr>
            ))}
            {data && !data.rows.length && <tr><td colSpan={13} className="px-3 py-8 text-center text-muted-foreground">No contracts match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && (
        <p className="text-[11px] text-muted-foreground">
          {data.total > data.rows.length ? `Showing ${data.rows.length} of ${data.total.toLocaleString()}. ` : `${data.total.toLocaleString()} contracts. `}
          {data.newsFetchedAt ? `Vendor news signals from GDELT, collected ${data.newsFetchedAt.slice(0, 10)}. ` : ""}
          Scores are modelled from {data.model.contracts.toLocaleString()} contracts across {data.model.families.toLocaleString()} client and service-line families
          (incumbents kept {Math.round(data.model.globalRetention * 100)}% of scopes that came back). 50 is a typical contract; treat scores as a prioritisation signal, not a forecast.
        </p>
      )}
      </>}

      <Sheet open={!!selected} onOpenChange={o => { if (!o) setSelected(null); }}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-base leading-snug pr-6">{selected.title}</SheetTitle>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-8 text-sm">
                <div className="flex flex-wrap gap-2"><ActionTag a={selected.action} /><Pill k={selected.urgency.key} label={selected.urgency.label} /><Pill k={selected.risk.key} label={`Risk: ${selected.risk.label}`} tip={selected.risk.tip} /></div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  {([
                    ["Incumbent", selected.vendorSlug ? <Link key="v" href={`/vendors/${selected.vendorSlug}`} className="underline underline-offset-2">{selected.vendor}</Link> : selected.vendor],
                    ["Client", selected.client ?? "—"], ["Industry", selected.industry ?? "—"], ["Region", selected.region ?? "—"],
                    ["Service line", [selected.serviceLine, selected.microServiceLine].filter(Boolean).join(" · ") || "—"],
                    ["Value", `${money(selected.tcvUsd)}${selected.tcvUsd && selected.tcvIsEstimate ? " (estimate)" : ""}`],
                    ["Ends", `${selected.end ?? "—"}${selected.endBasis === "estimated" ? " (estimated)" : ""}`],
                    ["Renewal · displacement", `${selected.renewalProb} · ${selected.displacementRisk}`],
                  ] as [string, React.ReactNode][]).map(([dt, dd]) => (
                    <div key={dt} className="min-w-0"><dt className="text-muted-foreground">{dt}</dt><dd className="text-foreground break-words">{dd}</dd></div>
                  ))}
                </dl>
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-1">Analysis</h3>
                  <p className="leading-relaxed text-foreground/90">{selected.analysis}</p>
                </section>
                {selected.factors.length > 0 && (
                  <section>
                    <h3 className="text-xs font-medium text-muted-foreground mb-1">What moved the scores</h3>
                    <ul className="list-disc pl-4 space-y-0.5 text-foreground/85">{selected.factors.map(f => <li key={f}>{f}</li>)}</ul>
                  </section>
                )}
                {selected.successor && (
                  <section>
                    <h3 className="text-xs font-medium text-muted-foreground mb-1">New vendor selected</h3>
                    <p className="text-foreground/85"><Successor s={selected.successor} />{selected.successor.title ? <span className="text-muted-foreground"> — {selected.successor.title}</span> : null}</p>
                  </section>
                )}
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">AI and renewal insights</h3>
                  <dl className="grid grid-cols-1 gap-1.5 text-xs">
                    <div><dt className="text-muted-foreground">Current AI usage</dt><dd className="text-foreground/90">{selected.ai.key === "active" && <><Pill k="active" label="AI active" />{" "}</>}{selected.aiUsage.current}</dd></div>
                    <div><dt className="text-muted-foreground">AI enhancement potential</dt><dd className="text-foreground/90">{selected.aiUsage.potential}</dd></div>
                    <div><dt className="text-muted-foreground">Automation potential</dt><dd className="text-foreground/90">{AUTOMATION_LABELS[selected.automation]}</dd></div>
                  </dl>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">AI deployment opportunities for a new vendor</p>
                    <ul className="space-y-1">{selected.aiDeployment.map(a => <li key={a} className="flex items-start gap-2 text-foreground/85"><span className="mt-0.5 rounded border border-sky-500/40 px-1 text-[9px] font-semibold text-sky-600 dark:text-sky-400">AI</span>{a}</li>)}</ul>
                  </div>
                </section>
                <section>
                  <h3 className="text-xs font-medium text-muted-foreground mb-1">Incumbent churn intelligence</h3>
                  <p className="text-foreground/85 leading-relaxed">{selected.churnIntel}</p>
                </section>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">Risk and legal signals</h3>
                  <p className="text-foreground/85"><Pill k={selected.risk.key} label={selected.risk.label} /> {selected.risk.tip}</p>
                  {selected.news ? (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", selected.news.score >= 60 ? "border-red-500/40 text-red-600 dark:text-red-400" : selected.news.score >= 35 ? "border-amber-500/40 text-amber-600 dark:text-amber-400" : "border-brand/40 text-brand")}>news risk · {selected.news.score}</span>
                        {CATEGORIES.filter(c => (selected.news!.counts[c.key] ?? 0) > 0).map(c => (
                          <span key={c.key} className="rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground/80">{c.label} · {selected.news!.counts[c.key]}</span>
                        ))}
                      </div>
                      {selected.news.examples.length > 0 && (
                        <ul className="space-y-1.5">
                          {selected.news.examples.slice(0, 4).map(h => (
                            <li key={h.url} className="text-xs">
                              <a href={h.url} target="_blank" rel="noopener noreferrer" className="text-foreground/90 underline decoration-dotted underline-offset-2 hover:text-foreground">{h.title}</a>
                              <div className="text-muted-foreground">{CATEGORY_LABEL[h.category]} · {h.date} · {h.domain}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="text-[11px] text-muted-foreground">{selected.news.scanned} headlines scanned · GDELT global news · {selected.news.fetchedAt.slice(0, 10)}</p>
                    </div>
                  ) : <p className="text-xs text-muted-foreground">No news signals collected for this vendor yet.</p>}
                  <p className="text-xs text-muted-foreground">Catalogue: {selected.vendorSignal ? `${selected.vendorSignal.summary} · signal score ${selected.vendorSignal.score}/100` : "no events recorded for this vendor in the last 12 months."}</p>
                </section>
                {(selected.writeUp || selected.scope) && (
                  <section>
                    <h3 className="text-xs font-medium text-muted-foreground mb-1">The contract</h3>
                    <p className="text-foreground/85 leading-relaxed">{selected.writeUp ?? selected.scope}</p>
                  </section>
                )}
                {selected.url && (
                  <Button variant="outline" size="sm" className="gap-1.5" onClick={() => window.open(selected.url!, "_blank", "noopener")}>
                    <ExternalLink className="h-3.5 w-3.5" />Source article
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Successor({ s }: { s: NonNullable<RenewalRow["successor"]> }) {
  if (s.status === "retained") return <span className="text-brand text-xs font-medium">Retained</span>;
  if (s.status === "new_vendor") return <span className="text-amber-600 dark:text-amber-400 text-xs font-medium">New vendor: {s.vendor}</span>;
  return <span className="text-muted-foreground text-xs">No successor detected</span>;
}
