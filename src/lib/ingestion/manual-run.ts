/**
 * A pipeline run started from the Admin page, owned by the server.
 *
 * The page used to drive the run itself, asking for one batch of sources after
 * another, so the run ended the moment the page was left. Here the run lives in
 * the database (SystemSetting) and each batch starts the next: the page only
 * watches, and sends pause, resume or end.
 *
 *   running  a batch is in flight, or about to be
 *   paused   stopped between batches; resume carries on from the same place
 *   ended    stopped by a person; everything read up to then was stored
 *   completed / failed
 *
 * Pause and end are cooperative. The batch in flight is told to stop starting
 * new work (PipelineOptions.stopSignal); reads already under way finish, what
 * was read is stored, and what was found but not read stays queued. Nothing is
 * thrown away. A paused batch is run again on resume: articles it already read
 * are skipped as seen and the queued ones are read.
 *
 * Two keys, two writers: the batch in flight is the only writer of the run
 * record while it works; the page's commands go to a separate control key, so
 * neither can overwrite the other.
 */
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { runPipeline, ROUTE_TIME_BUDGET_MS, type PipelineOptions, type PipelineProgress } from "./pipeline";

const RUN_KEY = "ingestion.manualRun";
const CONTROL_KEY = "ingestion.manualRun.control";
/** Sources per batch: one batch fits a single 300s function with room to store. */
export const BATCH_SOURCES = 30;
/** A running run whose batch has not reported for this long has lost its batch. */
const STALLED_MS = 120_000;

export type RunState = "running" | "paused" | "ended" | "completed" | "failed";
export type RunCommand = "run" | "pause" | "end";

export interface RunTotals {
  articlesFound: number; articlesDuped: number; articlesRelevant: number; articlesTriaged: number; articlesExcluded: number;
  articlesMerged: number; eventsPublished: number; eventsQueued: number; eventsDeferred: number; costUsd: number;
}
export interface ManualRun {
  id: string;
  state: RunState;
  sourceFilter: NonNullable<PipelineOptions["sourceFilter"]>;
  /** How many sources this run covers in all (0 until the first batch reports). */
  sourcesTotal: number;
  /** Upper bound the person chose, or null for every source. */
  sourceLimit: number | null;
  dryRun: boolean;
  /** Sources completed. */
  offset: number;
  /** Batch number about to run or running, from 1. */
  batch: number;
  /** Batch currently claimed by a function, or null between batches. */
  stepping: number | null;
  startedAt: string;
  heartbeatAt: string;
  endedAt: string | null;
  totals: RunTotals;
  /** Counts for the batch in flight, refreshed every few seconds. */
  live: { phase: string; found: number; toRead: number; read: number } | null;
  errors: string[];
  message: string | null;
}

const ZERO: RunTotals = { articlesFound: 0, articlesDuped: 0, articlesRelevant: 0, articlesTriaged: 0, articlesExcluded: 0, articlesMerged: 0, eventsPublished: 0, eventsQueued: 0, eventsDeferred: 0, costUsd: 0 };
const now = () => new Date().toISOString();

async function readRaw(): Promise<{ raw: string; run: ManualRun } | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: RUN_KEY } });
  if (!row) return null;
  try { return { raw: row.value, run: JSON.parse(row.value) as ManualRun }; } catch { return null; }
}
async function write(run: ManualRun): Promise<void> {
  const value = JSON.stringify(run);
  await prisma.systemSetting.upsert({ where: { key: RUN_KEY }, update: { value }, create: { key: RUN_KEY, value } });
}
async function command(runId: string): Promise<RunCommand> {
  const row = await prisma.systemSetting.findUnique({ where: { key: CONTROL_KEY } });
  try { const c = JSON.parse(row?.value ?? "{}") as { runId?: string; command?: RunCommand }; return c.runId === runId && c.command ? c.command : "run"; } catch { return "run"; }
}
async function setCommand(runId: string, cmd: RunCommand): Promise<void> {
  const value = JSON.stringify({ runId, command: cmd, at: now() });
  await prisma.systemSetting.upsert({ where: { key: CONTROL_KEY }, update: { value }, create: { key: CONTROL_KEY, value } });
}

export const isActive = (run: ManualRun | null): run is ManualRun => !!run && (run.state === "running" || run.state === "paused");
export const isStalled = (run: ManualRun) => run.state === "running" && Date.now() - Date.parse(run.heartbeatAt) > STALLED_MS;

/** The run and the command pending against it, for the page. */
export async function getRun(): Promise<{ run: ManualRun | null; command: RunCommand; stalled: boolean }> {
  const r = (await readRaw())?.run ?? null;
  return { run: r, command: r ? await command(r.id) : "run", stalled: r ? isStalled(r) : false };
}

export async function startRun(opts: { sourceFilter?: ManualRun["sourceFilter"]; sourceLimit?: number | null; dryRun?: boolean }): Promise<{ run: ManualRun; started: boolean }> {
  const current = (await readRaw())?.run ?? null;
  if (isActive(current) && !isStalled(current)) return { run: current, started: false };
  const run: ManualRun = {
    id: `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, state: "running",
    sourceFilter: opts.sourceFilter ?? "all", sourcesTotal: 0, sourceLimit: opts.sourceLimit ?? null, dryRun: !!opts.dryRun,
    offset: 0, batch: 1, stepping: null, startedAt: now(), heartbeatAt: now(), endedAt: null,
    totals: { ...ZERO }, live: null, errors: [], message: null,
  };
  await write(run);
  await setCommand(run.id, "run");
  return { run, started: true };
}

/** Ask the batch in flight to stop after the reads it has started. */
export async function pauseRun(): Promise<ManualRun | null> {
  const r = (await readRaw())?.run ?? null;
  if (!r || r.state !== "running") return r;
  await setCommand(r.id, "pause");
  // No batch in flight (or it died): nothing to wait for.
  if (r.stepping === null || isStalled(r)) { const paused = { ...r, state: "paused" as const, stepping: null, live: null, heartbeatAt: now(), message: "Paused." }; await write(paused); return paused; }
  return r;
}

/** Carry on a paused (or stalled) run. Returns true when a batch should be started. */
export async function resumeRun(): Promise<{ run: ManualRun | null; kick: boolean }> {
  const r = (await readRaw())?.run ?? null;
  if (!r || !(r.state === "paused" || isStalled(r))) return { run: r, kick: false };
  const run = { ...r, state: "running" as const, stepping: null, heartbeatAt: now(), message: null };
  await write(run);
  await setCommand(run.id, "run");
  return { run, kick: true };
}

/** End the run. A batch in flight stores what it has read first. */
export async function endRun(): Promise<ManualRun | null> {
  const r = (await readRaw())?.run ?? null;
  if (!isActive(r)) return r;
  await setCommand(r.id, "end");
  if (r.state === "paused" || r.stepping === null || isStalled(r)) {
    const ended = { ...r, state: "ended" as const, stepping: null, live: null, endedAt: now(), heartbeatAt: now(), message: "Ended by you. Everything read up to that point was stored." };
    await write(ended);
    return ended;
  }
  return r;
}

/**
 * Claim one batch. Only one function may work a given batch: the claim is a
 * compare-and-swap on the stored record, so a duplicate start loses.
 */
export async function claimBatch(runId: string, batch: number): Promise<ManualRun | null> {
  const cur = await readRaw();
  if (!cur || cur.run.id !== runId || cur.run.state !== "running" || cur.run.batch !== batch) return null;
  if (cur.run.stepping === batch && !isStalled(cur.run)) return null;
  const claimed: ManualRun = { ...cur.run, stepping: batch, heartbeatAt: now(), live: { phase: "crawling", found: 0, toRead: 0, read: 0 } };
  const swapped = await prisma.systemSetting.updateMany({ where: { key: RUN_KEY, value: cur.raw }, data: { value: JSON.stringify(claimed) } });
  return swapped.count === 1 ? claimed : null;
}

const add = (t: RunTotals, p: PipelineProgress): RunTotals => ({
  articlesFound: t.articlesFound + p.articlesFound, articlesDuped: t.articlesDuped + p.articlesDuped, articlesRelevant: t.articlesRelevant + p.articlesRelevant,
  articlesTriaged: t.articlesTriaged + p.articlesTriaged, articlesExcluded: t.articlesExcluded + p.articlesExcluded, articlesMerged: t.articlesMerged + p.articlesMerged,
  eventsPublished: t.eventsPublished + p.eventsPublished, eventsQueued: t.eventsQueued + p.eventsQueued, eventsDeferred: t.eventsDeferred + p.eventsDeferred,
  costUsd: t.costUsd + p.usage.costUsd,
});

/**
 * Work one claimed batch to the end and record where the run stands.
 * Returns the next batch number when another should be started.
 */
export async function workBatch(claimed: ManualRun): Promise<number | null> {
  let run = claimed;
  const stopSignal = { stop: false };
  let livePipeline: PipelineProgress | null = null;
  let asked: RunCommand = "run";
  let ticks = 0;
  let busy = false;
  // Every 3s: has the page asked us to pause or end? Every 9s: report in.
  const watch = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      asked = await command(run.id);
      if (asked !== "run") stopSignal.stop = true;
      if (++ticks % 3 === 0) {
        run = { ...run, heartbeatAt: now(), live: livePipeline ? { phase: livePipeline.phase, found: livePipeline.articlesFound, toRead: livePipeline.articlesRelevant, read: livePipeline.articlesProcessed } : run.live };
        await write(run);
      }
    } catch { /* a missed tick is harmless */ } finally { busy = false; }
  }, 3000);

  let result: PipelineProgress | null = null;
  let failure: string | null = null;
  try {
    const size = run.sourceLimit ? Math.min(BATCH_SOURCES, run.sourceLimit - run.offset) : BATCH_SOURCES;
    result = await runPipeline({
      sourceFilter: run.sourceFilter, maxSourcesPerRun: size, sourceOffset: run.offset, dryRun: run.dryRun,
      maxExtractions: 400, concurrency: 12, timeBudgetMs: ROUTE_TIME_BUDGET_MS, deadlineMs: 185_000, stopSignal, runType: run.dryRun ? "dry_run" : "manual",
    }, p => { livePipeline = p; });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(watch);
    // Let a tick that is mid-write finish, or it could land after the final record below.
    for (let i = 0; busy && i < 100; i++) await new Promise(r => setTimeout(r, 50));
  }

  // One last look, so a command sent while the batch was storing is honoured.
  asked = await command(run.id).catch(() => asked);
  const base = { ...run, stepping: null, live: null, heartbeatAt: now() };
  if (!result) {
    await write({ ...base, state: "failed", endedAt: now(), errors: [...run.errors, failure ?? "batch failed"].slice(-30), message: `Batch ${run.batch} failed: ${failure}` });
    return null;
  }
  const totals = add(run.totals, result);
  const errors = [...run.errors, ...result.errors].slice(-30);
  const sourcesTotal = run.sourceLimit ? Math.min(run.sourceLimit, result.sourcesAvailable) : result.sourcesAvailable;
  // A batch that was cut short is run again on resume; a batch that ran its course is done.
  const offset = result.interrupted ? run.offset : run.offset + result.sourcesTotal;
  const finished = offset >= sourcesTotal || result.sourcesTotal === 0;
  const next = { ...base, totals, errors, sourcesTotal, offset };

  if (asked === "end") { await write({ ...next, state: "ended", endedAt: now(), message: "Ended by you. Everything read up to that point was stored." }); return null; }
  if (finished && !result.interrupted) { await write({ ...next, state: "completed", endedAt: now(), message: `Complete: ${run.batch} batch${run.batch === 1 ? "" : "es"}.` }); return null; }
  if (asked === "pause") { await write({ ...next, state: "paused", batch: result.interrupted ? run.batch : run.batch + 1, message: "Paused. Everything read so far is stored." }); return null; }
  await write({ ...next, batch: run.batch + 1 });
  return run.batch + 1;
}

/** Start the next batch in a function of its own, so each batch gets a full time allowance. */
export async function kickBatch(origin: string, runId: string, batch: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${origin}/api/ingestion/run/step`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, batch }), signal: AbortSignal.timeout(20_000) });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
  }
  return false;
}

/**
 * Claim a batch and work it after this request has been answered. Must be
 * called while handling a request (it uses after()). Returns false when the
 * batch was not ours to take.
 */
export async function launchBatch(origin: string, runId: string, batch: number): Promise<boolean> {
  const claimed = await claimBatch(runId, batch);
  if (!claimed) return false;
  after(async () => {
    const next = await workBatch(claimed);
    if (next !== null) await kickBatch(origin, runId, next);
  });
  return true;
}
