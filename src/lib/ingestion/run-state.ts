/**
 * Ingestion run lifecycle (AI Delivery Mandate §14).
 *
 * A run row is written when the pass starts and its counters only when the pass
 * finishes. A fire killed at the platform's function ceiling therefore left the
 * row at status "running" for ever, with zeroes that looked like "did nothing"
 * but only meant "never finalised". Five runs sat that way, the oldest since
 * 21 July, and run health could not be read from the run log at all.
 *
 * The fix is general, not five row ids: every run heartbeats while it works,
 * and every new run first sweeps anything whose heartbeat has gone cold into a
 * terminal state. A dead run can no longer look healthy.
 */
import { prisma } from "@/lib/db";

/** Platform function ceiling (300s) plus margin for a final write that never landed. */
export const STALE_RUN_MS = 15 * 60_000;

/**
 * Sweep runs whose execution died into a terminal state. PARTIAL when the run
 * had produced something before it died, FAILED when it had not — the counters
 * written by the heartbeat are what make that distinction possible.
 */
export async function finaliseStaleRuns(now = new Date()): Promise<{ failed: number; partial: number }> {
  const cutoff = new Date(now.getTime() - STALE_RUN_MS);
  const stale = await prisma.ingestionRun.findMany({
    where: { status: "running", completedAt: null,
      OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null, startedAt: { lt: cutoff } }] },
    select: { id: true, articlesTriaged: true, eventsPublished: true, heartbeatAt: true },
  });
  let failed = 0, partial = 0;
  for (const r of stale) {
    const didWork = r.articlesTriaged > 0 || r.eventsPublished > 0;
    await prisma.ingestionRun.update({ where: { id: r.id }, data: {
      status: didWork ? "partial" : "failed",
      completedAt: r.heartbeatAt ?? now,
      endedReason: r.heartbeatAt ? "died_after_heartbeat" : "timed_out_no_finalise",
    } }).catch(() => {});
    didWork ? partial++ : failed++;
  }
  return { failed, partial };
}

/**
 * Beat while the run works, carrying the counters known so far. Best-effort:
 * a failed heartbeat must never take down the pass it is reporting on.
 */
export async function beat(runId: string, counters: Partial<{
  articlesFound: number; articlesTriaged: number; articlesExcluded: number;
  eventsPublished: number; costUsd: number;
}> = {}): Promise<void> {
  await prisma.ingestionRun.update({ where: { id: runId }, data: { heartbeatAt: new Date(), ...counters } })
    .catch(() => {});
}
