/**
 * Fetch page text for queued (pending) articles that have none, so the Batch API reader can read them.
 * The work is in src/lib/ingestion/pending-text.ts, shared with GET /api/cron/fetch-text — use that route when this
 * machine is in the UK/EU, where Google News answers with its consent page and the publisher link cannot be resolved.
 *
 *   npx tsx scripts/fetch-pending-text.ts [--run-type backfill_queue|all] [--concurrency 6] [--limit N] [--apply]
 */
import { prisma } from "@/lib/db";
import { fetchPendingText } from "@/lib/ingestion/pending-text";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const runType = arg("--run-type", "backfill_queue");

async function main() {
  const r = await fetchPendingText({
    runType: runType === "all" ? undefined : runType, concurrency: Number(arg("--concurrency", "6")),
    limit: Number(arg("--limit", "0")) || undefined, write: process.argv.includes("--apply"),
  });
  console.log(`${runType}: ${r.candidates} queued without readable text · attempted ${r.attempted} · text fetched ${r.fetched} · unavailable ${r.unavailable} · remaining ${r.remaining}`);
  await prisma.$disconnect();
  process.exit(0);
}
main();
