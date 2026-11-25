"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Play, Pause, Square, RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";

interface IngestionStatus {
  /** Operating phase: "historical" while the backfill runner reinforces the store (the cron stands down), else "current". */
  mode?: { mode: "historical" | "current"; note: string | null; since: string | null };
  hasApiKey: boolean;
  sourcesTotal: number;
  needsReview: number;
  lastRun: {
    id: string; status: string; runType: string;
    startedAt: string; completedAt: string | null;
    articlesFound: number; articlesDuped: number;
    eventsExtracted: number; eventsPublished: number; eventsQueued: number;
    articlesRelevant?: number; articlesStale?: number; articlesTriaged?: number;
    articlesExcluded?: number; articlesDeferred?: number; articlesMerged?: number;
  } | null;
}

/** A run owned by the server (src/lib/ingestion/manual-run.ts). The page only watches it. */
interface ServerRun {
  id: string;
  state: "running" | "paused" | "ended" | "completed" | "failed";
  dryRun: boolean;
  sourcesTotal: number; offset: number; batch: number; stepping: number | null;
  totals: { articlesFound: number; articlesDuped: number; articlesRelevant: number; articlesTriaged: number; articlesExcluded: number; articlesMerged: number; eventsPublished: number; eventsQueued: number; eventsDeferred: number; costUsd: number };
  live: { phase: string; found: number; toRead: number; read: number } | null;
  errors: string[];
  message: string | null;
}
type RunCommand = "run" | "pause" | "end";

export function AdminRunPanel({ initialStatus }: { initialStatus: IngestionStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [run, setRun] = useState<ServerRun | null>(null);
  const [command, setCommand] = useState<RunCommand>("run");
  const [sending, setSending] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [maxSources, setMaxSources] = useState<string>("all");
  const lastState = useRef<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/ingestion");
    setStatus(await res.json());
  }, []);

  const apply = useCallback((d: { run?: ServerRun | null; command?: RunCommand }) => {
    setRun(d.run ?? null);
    setCommand(d.command ?? "run");
  }, []);

  /** Tell the server what to do with the run. The run itself never depends on this page staying open. */
  const send = useCallback(async (action: "start" | "pause" | "resume" | "end", extra: Record<string, unknown> = {}) => {
    setSending(true); setRunError(null);
    try {
      const res = await fetch("/api/ingestion/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const d = await res.json();
      if (d.run !== undefined) apply(d);
      if (!res.ok && res.status !== 409) setRunError(d.error ?? `Could not ${action} the run`);
    } catch {
      setRunError("Network error. The run itself is unaffected; this page will catch up.");
    } finally {
      setSending(false);
    }
  }, [apply]);

  // Watch the run: on arrival, then every few seconds while it is live.
  const active = run?.state === "running" || run?.state === "paused";
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try { const d = await (await fetch("/api/ingestion/run", { cache: "no-store" })).json(); if (!cancelled) apply(d); } catch { /* next tick */ }
    };
    load();
    if (!active) return () => { cancelled = true; };
    const t = setInterval(load, run?.state === "running" ? 2500 : 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active, run?.state, apply]);

  // When a run reaches its end, refresh the "Last Run" card below.
  useEffect(() => {
    const st = run?.state ?? null;
    if (lastState.current && lastState.current !== st && st && st !== "running" && st !== "paused") refreshStatus();
    lastState.current = st;
  }, [run?.state, refreshStatus]);

  const pausing = run?.state === "running" && command === "pause";
  const ending = run?.state === "running" && command === "end";
  const from = run ? Math.min(run.offset + 1, Math.max(run.sourcesTotal, 1)) : 0;
  const to = run ? (run.sourcesTotal ? Math.min(run.offset + 30, run.sourcesTotal) : run.offset + 30) : 0;

  const statusColor = (s: string) => {
    if (s === "completed") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    if (s === "running") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
    if (s === "partial") return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
    return "bg-red-500/15 text-red-400 border-red-500/30";
  };

  return (
    <div className="space-y-4">
      {/* API key warning */}
      {!status.hasApiKey && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm">
          <AlertCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-400">No Anthropic API key detected</p>
            <p className="text-amber-400/70 text-xs mt-0.5">
              Add <code className="bg-amber-500/20 px-1 rounded">ANTHROPIC_API_KEY=sk-ant-...</code> to your <code className="bg-amber-500/20 px-1 rounded">.env</code> file for LLM extraction.
              Without it, rule-based classification is used — lower accuracy but still functional.
            </p>
          </div>
        </div>
      )}
      {status.hasApiKey && (
        <div className="flex items-center gap-2 text-xs text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Reading enabled · Sonnet 5.5 reads every article in full
        </div>
      )}

      {/* Run controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Pipeline Controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Source filter</label>
              <Select value={sourceFilter} onValueChange={v => v && setSourceFilter(v)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="vendor_rss">Vendor newsrooms</SelectItem>
                  <SelectItem value="investor_relations">Investor relations</SelectItem>
                  <SelectItem value="wire">Wire + Google News</SelectItem>
                  <SelectItem value="procurement">Government procurement</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Max sources</label>
              <Select value={maxSources} onValueChange={v => v && setMaxSources(v)}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources (full run)</SelectItem>
                  <SelectItem value="5">5 sources (quick test)</SelectItem>
                  <SelectItem value="20">20 sources</SelectItem>
                  <SelectItem value="50">50 sources</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Idle: start. Running: the same button pauses, with a small End run beside it. */}
          {!active ? (
            <div className="flex gap-2">
              <Button onClick={() => send("start", { sourceFilter, maxSources: maxSources === "all" ? 0 : parseInt(maxSources) })} disabled={sending} className="gap-2 flex-1">
                <Play className="h-4 w-4" />Run pipeline
              </Button>
              <Button variant="outline" onClick={() => send("start", { sourceFilter, maxSources: maxSources === "all" ? 0 : parseInt(maxSources), dryRun: true })} disabled={sending} className="text-xs">
                Dry run
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              {run?.state === "paused" ? (
                <Button onClick={() => send("resume")} disabled={sending} className="gap-2 flex-1"><Play className="h-4 w-4" />Resume</Button>
              ) : (
                <Button onClick={() => send("pause")} disabled={sending || pausing || ending} className="gap-2 flex-1">
                  {pausing || ending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                  {ending ? "Ending: storing what was read…" : pausing ? "Pausing: finishing articles in hand…" : "Pause"}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => send("end")} disabled={sending || ending} className="h-9 gap-1.5 text-xs border-red-500/30 hover:bg-red-500/10" title="Stop now. Everything read up to this point is stored.">
                <Square className="h-3 w-3 text-red-400" />End run
              </Button>
            </div>
          )}

          {runError && <p className="text-xs text-red-400">{runError}</p>}

          {active && run && (
            <div className="p-3 rounded-md text-xs space-y-1.5 bg-blue-500/10 border border-blue-500/20">
              <p className="font-medium text-blue-300">
                {run.state === "paused" ? "Paused" : run.dryRun ? "Dry run in progress" : "Run in progress"} · batch {run.batch}
                {run.sourcesTotal > 0 ? ` · sources ${from}–${to} of ${run.sourcesTotal}` : ""}
              </p>
              {run.state === "running" && run.live && (
                <p className="text-muted-foreground">
                  {run.live.phase === "crawling" ? "Collecting the feeds…" : run.live.phase === "storing" ? "Storing what was read…" : `Reading: ${Math.min(run.live.read, run.live.toRead)} of ${run.live.toRead} articles in this batch`}
                </p>
              )}
              <p className="text-muted-foreground font-mono">
                so far: {run.totals.articlesTriaged} read · {run.totals.eventsPublished} published · {run.totals.eventsQueued} for review · ${run.totals.costUsd.toFixed(2)}
              </p>
              <p className="text-muted-foreground/70">This run carries on if you leave this page. Only Pause or End run stops it.</p>
            </div>
          )}

          {!active && run && (
            <div className={`p-3 rounded-md text-xs space-y-1 ${run.state === "failed" ? "bg-red-500/10 border border-red-500/20" : "bg-emerald-500/10 border border-emerald-500/20"}`}>
              <p className={`font-medium ${run.state === "failed" ? "text-red-400" : "text-emerald-400"}`}>{run.message ?? (run.state === "failed" ? "Run failed" : "Run complete")}</p>
              <div className="grid grid-cols-3 gap-2 mt-2 text-emerald-400/80">
                <div><div className="font-mono font-bold text-base text-emerald-400">{run.totals.articlesTriaged}</div>articles read</div>
                <div><div className="font-mono font-bold text-base text-emerald-400">{run.totals.eventsPublished}</div>published</div>
                <div><div className="font-mono font-bold text-base text-amber-400">{run.totals.eventsQueued}</div>for review</div>
              </div>
              <p className="text-muted-foreground mt-1 font-mono">
                {run.totals.articlesFound} in the feeds · {run.totals.articlesDuped} seen before · {run.totals.articlesExcluded} read with no event · {run.totals.articlesMerged} added to existing events · ${run.totals.costUsd.toFixed(2)}
              </p>
              {run.totals.eventsDeferred > 0 && <p className="text-muted-foreground mt-1">{run.totals.eventsDeferred} articles were not reached and stay queued for the next run.</p>}
              {run.errors.length > 0 && <p className="text-yellow-400 mt-1" title={run.errors.slice(0, 8).join("\n")}>{run.errors.length} notes or source errors</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Last run summary */}
      {status.lastRun && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center justify-between">
              Last Run
              <Badge variant="outline" className={`text-[10px] ${statusColor(status.lastRun.status)}`}>
                {status.lastRun.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-1.5 text-muted-foreground">
            <div className="flex justify-between"><span>Started</span><span className="font-mono">{new Date(status.lastRun.startedAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}</span></div>
            {/* The funnel, top to bottom. "Already stored" is URLs ingested on an
                earlier run (as events or recorded exclusions) and skipped before any
                model spend — not duplicate events. A feed re-crawled soon after a
                sweep is expected to be almost entirely already stored. */}
            <div className="flex justify-between" title="Every item in every feed, including items the feeds repeat from earlier days"><span>Items in the feeds</span><span className="font-mono">{status.lastRun.articlesFound}</span></div>
            <div className="flex justify-between" title="URLs ingested on an earlier run — skipped before any model spend"><span>Seen on an earlier day</span><span className="font-mono">{status.lastRun.articlesDuped}</span></div>
            {status.lastRun.articlesStale != null && status.lastRun.articlesStale > 0 && (
              <div className="flex justify-between" title="Older than the age cutoff"><span>Too old</span><span className="font-mono">{status.lastRun.articlesStale}</span></div>
            )}
            {status.lastRun.articlesFound - status.lastRun.articlesDuped > 0 && (
              <div className="flex justify-between" title="Items seen for the first time in this run"><span>New today</span><span className="font-mono">{status.lastRun.articlesFound - status.lastRun.articlesDuped}</span></div>
            )}
            {status.lastRun.articlesRelevant != null && (
              <div className="flex justify-between" title="New articles that name a tracked vendor, plus the backlog queued from earlier runs"><span>Waiting to be read</span><span className="font-mono">{status.lastRun.articlesRelevant}</span></div>
            )}
            {status.mode && (
              <div className="flex justify-between" title={status.mode.note ?? undefined}>
                <span>Ingestion mode</span>
                <span className={`font-mono ${status.mode.mode === "historical" ? "text-amber-400" : "text-emerald-400"}`}>{status.mode.mode === "historical" ? "historical fill — cron paused" : "current — cron active"}</span>
              </div>
            )}
            {status.lastRun.articlesTriaged != null && (
              <div className="flex justify-between" title="Whole article read by the model in this run. A run reads for about three minutes; the rest wait for the next run."><span>Read this run</span><span className="font-mono">{status.lastRun.articlesTriaged}</span></div>
            )}
            {status.lastRun.articlesExcluded != null && (
              <div className="flex justify-between" title="Read in full and found to report no contract, deal, partnership, launch, leadership change or results. Normal for news feeds; recorded so it is never paid for again."><span>Read, no event in it</span><span className="font-mono text-zinc-500">{status.lastRun.articlesExcluded}</span></div>
            )}
            {status.lastRun.articlesMerged != null && status.lastRun.articlesMerged > 0 && (
              <div className="flex justify-between" title="A second report of an event already stored; attached to it as another source"><span>Added to an existing event</span><span className="font-mono">{status.lastRun.articlesMerged}</span></div>
            )}
            <div className="flex justify-between"><span>New events published</span><span className="font-mono text-emerald-400">{status.lastRun.eventsPublished}</span></div>
            <div className="flex justify-between"><span>New events held for review</span><span className="font-mono text-amber-400">{status.lastRun.eventsQueued}</span></div>
            {status.lastRun.articlesDeferred != null && status.lastRun.articlesDeferred > 0 && (
              <div className="flex justify-between" title="Not reached in this run's reading time. Nothing is dropped: they stay queued for the next run."><span>Not reached, queued for next run</span><span className="font-mono">{status.lastRun.articlesDeferred}</span></div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Source stats */}
      <Card className="bg-card border-border">
        <CardContent className="pt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1.5"><Clock className="h-3 w-3" />Active sources</span>
            <span className="font-mono font-medium">{status.sourcesTotal}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
