/**
 * Undo the damage of model-service outages recorded as article failures.
 *
 * Before the pipeline could tell "the API refused the request" from "this
 * article cannot be read", every outage day counted a failed attempt against
 * each article it touched, and two such days marked the article FAILED for
 * good. This restores them: FAILED rows whose recorded error is a service
 * failure go back to pending, and pending rows lose the attempts they were
 * charged for one.
 *
 * Nothing is read and nothing is spent here; the rows simply rejoin the queue.
 * Dry run by default.
 *
 *   npx tsx scripts/restore-outage-failures.ts [--apply]
 */
import { prisma } from "@/lib/db";
import { isServiceFailure } from "@/lib/ingestion/reader";

const apply = process.argv.includes("--apply");
const bare = (e: string | null) => (e ?? "").replace(/^read failed \d+x:\s*/, "").trim();

async function main() {
  const failed = await prisma.sourceEvent.findMany({ where: { processingStatus: "failed" }, select: { id: true, processingError: true } });
  const charged = await prisma.sourceEvent.findMany({ where: { processingStatus: "pending", readAttempts: { gt: 0 } }, select: { id: true, processingError: true } });
  const restore = failed.filter(r => isServiceFailure(bare(r.processingError)));
  const reset = charged.filter(r => isServiceFailure(bare(r.processingError)));
  console.log(`FAILED rows: ${failed.length}; failed only because the model service was unavailable: ${restore.length}; left as failed (article-level): ${failed.length - restore.length}`);
  console.log(`pending rows carrying a failed attempt: ${charged.length}; charged for a service outage: ${reset.length}`);
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply."); return; }
  for (let i = 0; i < restore.length; i += 500) {
    await prisma.sourceEvent.updateMany({ where: { id: { in: restore.slice(i, i + 500).map(r => r.id) } }, data: { processingStatus: "pending", readAttempts: 0, processingError: null } });
  }
  for (let i = 0; i < reset.length; i += 500) {
    await prisma.sourceEvent.updateMany({ where: { id: { in: reset.slice(i, i + 500).map(r => r.id) } }, data: { readAttempts: 0, processingError: null } });
  }
  console.log(`applied: ${restore.length} restored to pending, ${reset.length} attempt counts cleared.`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0));
