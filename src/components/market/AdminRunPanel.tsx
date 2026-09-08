"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Play, RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";

interface IngestionStatus {
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

interface RunResult {
  success: boolean;
  error?: string;
  result?: {
    runId?: string;
    status?: string;
    message?: string;
    phase?: string; sourcesAvailable?: number; sourcesProcessed?: number; sourcesTotal?: number;
    articlesFound?: number; articlesDuped?: number; eventsExtracted?: number;
    articlesStale?: number; articlesRelevant?: number; articlesTriaged?: number; articlesExcluded?: number;
    eventsPublished?: number; eventsQueued?: number; eventsDeferred?: number; errors?: string[];
  };
}

export function AdminRunPanel({ initialStatus }: { initialStatus: IngestionStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [maxSources, setMaxSources] = useState<string>("all");

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/ingestion");
    const data = await res.json();
    setStatus(data);
  }, []);

  const [batchProgress, setBatchProgress] = useState("");

  const triggerRun = useCallback(async (dryRun = false) => {
    setRunning(true);
    setLastResult(null);
    setBatchProgress("");

    // Sources per API call. The route runs under a 300s ceiling with a 200s
    // model budget, so a batch this size finishes with room to spare.
    const BATCH_SIZE = 30;
    const limit = maxSources === "all" ? 999 : parseInt(maxSources);
    let offset = 0;
    let totalArticles = 0;
    let totalStale = 0;
    let totalRelevant = 0;
    let totalTriaged = 0;
    let totalExcluded = 0;
    let totalPublished = 0;
    let totalQueued = 0;
    let totalDeferred = 0;
    let totalErrors: string[] = [];
    let sourcesAvailable = 0;
    let batchNum = 0;

    try {
      while (offset < limit) {
        batchNum++;
        const batchLimit = Math.min(BATCH_SIZE, limit - offset);
        setBatchProgress(`Batch ${batchNum}: processing sources ${offset + 1}–${offset + batchLimit}…`);

        const res = await fetch("/api/ingestion", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceFilter,
            maxSources: batchLimit,
            sourceOffset: offset,
            dryRun,
          }),
        });

        const text = await res.text();
        let data: RunResult;
        try {
          data = JSON.parse(text);
        } catch {
          setLastResult({ success: false, error: `Batch ${batchNum} returned non-JSON: ${text.slice(0, 150)}` });
          break;
        }

        if (!data.success) {
          setLastResult({ success: false, error: data.error ?? `Batch ${batchNum} failed` });
          break;
        }

        const r = data.result;
        if (r) {
          totalArticles += r.articlesFound ?? 0;
          totalStale += r.articlesStale ?? 0;
          totalRelevant += r.articlesRelevant ?? 0;
          totalTriaged += r.articlesTriaged ?? 0;
          totalExcluded += r.articlesExcluded ?? 0;
          totalPublished += r.eventsPublished ?? 0;
          totalQueued += r.eventsQueued ?? 0;
          totalDeferred += r.eventsDeferred ?? 0;
          totalErrors = totalErrors.concat(r.errors ?? []);
          sourcesAvailable = r.sourcesAvailable ?? 0;
        }

        offset += batchLimit;

        // Stop if we've processed all available sources
        if (sourcesAvailable > 0 && offset >= sourcesAvailable) break;
        // Stop if this batch had no sources (past the end)
        if (r && (r.sourcesTotal ?? 0) === 0) break;

        setBatchProgress(`Batch ${batchNum} done. ${totalArticles} articles found so far…`);
      }

      setLastResult({
        success: true,
        result: {
          message: `Pipeline complete — ${batchNum} batches.`,
          articlesFound: totalArticles,
          articlesStale: totalStale,
          articlesRelevant: totalRelevant,
          articlesTriaged: totalTriaged,
          articlesExcluded: totalExcluded,
          eventsPublished: totalPublished,
          eventsQueued: totalQueued,
          eventsDeferred: totalDeferred,
          errors: totalErrors,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastResult({ success: false, error: msg });
    } finally {
      setRunning(false);
      setBatchProgress("");
      await refreshStatus();
    }
  }, [sourceFilter, maxSources, refreshStatus]);

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
          LLM extraction enabled (triage: Haiku 4.5 · analysis: Sonnet 5)
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

          <div className="flex gap-2">
            <Button onClick={() => triggerRun(false)} disabled={running} className="gap-2 flex-1">
              {running ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? (batchProgress || "Running pipeline…") : "Run pipeline"}
            </Button>
            <Button variant="outline" onClick={() => triggerRun(true)} disabled={running} className="text-xs">
              Dry run
            </Button>
          </div>

          {lastResult && (
            <div className={`p-3 rounded-md text-xs space-y-1 ${lastResult.success ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
              {lastResult.success && lastResult.result ? (
                <>
                  <p className="font-medium text-emerald-400">
                    {lastResult.result.message ?? "Run complete"}
                  </p>
                  {lastResult.result.articlesFound != null && (
                    <div className="grid grid-cols-3 gap-2 mt-2 text-emerald-400/80">
                      <div><div className="font-mono font-bold text-base text-emerald-400">{lastResult.result.articlesFound}</div>articles found</div>
                      <div><div className="font-mono font-bold text-base text-emerald-400">{lastResult.result.eventsPublished}</div>published</div>
                      <div><div className="font-mono font-bold text-base text-amber-400">{lastResult.result.eventsQueued}</div>needs review</div>
                    </div>
                  )}
                  {lastResult.result.articlesTriaged != null && (
                    <p className="text-muted-foreground mt-1 font-mono">
                      {lastResult.result.articlesRelevant} candidates · {lastResult.result.articlesTriaged} triaged · {lastResult.result.articlesExcluded} excluded by the model · {lastResult.result.articlesStale} skipped as stale
                    </p>
                  )}
                  {(lastResult.result.eventsDeferred ?? 0) > 0 && (
                    <p className="text-muted-foreground mt-1">
                      {lastResult.result.eventsDeferred} candidates deferred to the next run (model budget). Run again to ingest more.
                    </p>
                  )}
                  {(lastResult.result.errors?.length ?? 0) > 0 && (
                    <p className="text-yellow-400 mt-1">{lastResult.result.errors!.length} source errors</p>
                  )}
                </>
              ) : (
                <p className="text-red-400">{lastResult.error ?? "Unknown error"}</p>
              )}
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
            <div className="flex justify-between"><span>Articles found</span><span className="font-mono">{status.lastRun.articlesFound}</span></div>
            <div className="flex justify-between" title="URLs ingested on an earlier run — skipped before any model spend"><span>Already stored</span><span className="font-mono">{status.lastRun.articlesDuped}</span></div>
            {status.lastRun.articlesStale != null && status.lastRun.articlesStale > 0 && (
              <div className="flex justify-between" title="Older than the age cutoff"><span>Too old</span><span className="font-mono">{status.lastRun.articlesStale}</span></div>
            )}
            {status.lastRun.articlesRelevant != null && (
              <div className="flex justify-between" title="Survived the rules, vendor gate and age cutoff"><span>Candidates</span><span className="font-mono">{status.lastRun.articlesRelevant}</span></div>
            )}
            {status.lastRun.articlesTriaged != null && (
              <div className="flex justify-between"><span>Triaged by the model</span><span className="font-mono">{status.lastRun.articlesTriaged}</span></div>
            )}
            {status.lastRun.articlesExcluded != null && (
              <div className="flex justify-between" title="Judged out of scope by the model; recorded so they are never re-bought"><span>Excluded by the model</span><span className="font-mono text-zinc-500">{status.lastRun.articlesExcluded}</span></div>
            )}
            {status.lastRun.articlesMerged != null && status.lastRun.articlesMerged > 0 && (
              <div className="flex justify-between" title="Re-reports attached to an event already stored"><span>Merged into existing</span><span className="font-mono">{status.lastRun.articlesMerged}</span></div>
            )}
            <div className="flex justify-between"><span>Published</span><span className="font-mono text-emerald-400">{status.lastRun.eventsPublished}</span></div>
            <div className="flex justify-between"><span>Queued for review</span><span className="font-mono text-amber-400">{status.lastRun.eventsQueued}</span></div>
            {status.lastRun.articlesDeferred != null && status.lastRun.articlesDeferred > 0 && (
              <div className="flex justify-between" title="Candidates not reached within the run's budget — picked up next run"><span>Deferred</span><span className="font-mono">{status.lastRun.articlesDeferred}</span></div>
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
