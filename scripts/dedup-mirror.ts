/**
 * The same deal recorded from each party's side: "Dell | Partnership | NTT DATA" and "NTT DATA | Partnership | Dell".
 *
 * The provider-by-provider dedupe (dedup-catalogue.ts) never compares these, because the two records have different
 * providers. This pass pairs records whose provider and other party are swapped (same family, close in date), asks
 * Sonnet whether they are one event, folds the weaker record into the better one, and gives the survivor the other
 * side's name as its counterparty when it had none (lifting a no_counterparty review hold that only that caused).
 *
 * Covers published and review records in PARTNERSHIP, M_AND_A and CONTRACT. Dry run by default.
 *   npx tsx scripts/dedup-mirror.ts [--budget 3] [--show] [--apply]
 *   npx tsx scripts/dedup-catalogue.ts --scope review --undo     (undo: these folds are logged as dedup_review)
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { loadEvs, mirrorCandidates, indexByProvider, judgeSame, foldDuplicate, otherParty, line, SYSTEM_MIRROR, REVIEW_WINDOW, MIRROR_FAMILIES, type Ev } from "@/lib/ingestion/review-dedupe";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const BUDGET = Number(arg("--budget", "3"));
const CACHE = "_scratch/mirror-verdicts.json";
const ACTION = "dedup_review";

async function main() {
  const ids = (await prisma.canonicalMarketEvent.findMany({
    where: { family: { in: [...MIRROR_FAMILIES] }, publicationStatus: { in: ["published", "needs_review"] } }, select: { id: true },
  })).map(r => r.id);
  const evs = await loadEvs(ids);
  const byProvider = indexByProvider(evs);
  const windowDays = (f: string) => REVIEW_WINDOW[f] ?? 45;
  const jobs = evs.map(e => ({ e, cands: mirrorCandidates(e, byProvider, windowDays) })).filter(j => j.cands.length);
  console.log(`records: ${evs.length}; with a possible other-side twin: ${jobs.length}`);

  const cache: Record<string, { cands: string[]; same: number; why: string }> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  let spent = 0, cursor = 0, failures = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const job = jobs[cursor++];
      if (!job) return;
      const key = job.cands.map(c => c.id).join();
      if (cache[job.e.id]?.cands.join() === key) continue;
      if (spent >= BUDGET) return;
      const v = await judgeSame(job.e, job.cands, { model: "sonnet", system: SYSTEM_MIRROR, withFamily: true });
      if (!v) { failures++; continue; }
      spent += v.costUsd;
      cache[job.e.id] = { cands: job.cands.map(c => c.id), same: v.same, why: v.why };
    }
  }));
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  // Best records first, so a twin of a twin lands on the final survivor.
  const byId = new Map(evs.map(e => [e.id, e]));
  const survivorOf = new Map<string, string>();
  const merges: { loser: Ev; keep: Ev; why: string }[] = [];
  for (const job of jobs) {
    const v = cache[job.e.id];
    if (!v?.same || v.cands.join() !== job.cands.map(c => c.id).join() || survivorOf.has(job.e.id)) continue;
    let keepId = v.cands[v.same - 1];
    while (survivorOf.has(keepId)) keepId = survivorOf.get(keepId)!;
    const keep = byId.get(keepId);
    if (!keep || keepId === job.e.id) continue;
    survivorOf.set(job.e.id, keepId);
    merges.push({ loser: job.e, keep, why: v.why });
  }
  const fam: Record<string, number> = {};
  for (const m of merges) fam[m.loser.family] = (fam[m.loser.family] ?? 0) + 1;
  console.log(`judged ${jobs.length} (Sonnet $${spent.toFixed(2)} this run, ${failures} unanswered) · twins found: ${merges.length} — ${Object.entries(fam).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(", ")}`);
  console.log(`  survivors that gain a named counterparty: ${merges.filter(m => !otherParty(m.keep)).length}; review items among the folded: ${merges.filter(m => m.loser.status === "needs_review").length}`);
  if (process.argv.includes("--show")) for (const m of merges.slice(0, 25)) console.log(`  DUP ${line(m.loser, true).slice(0, 170)}\n   =  ${line(m.keep, true).slice(0, 170)}\n      ${m.why}`);
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply."); return; }
  let done = 0;
  for (const m of merges) {
    try { if (await foldDuplicate(m.loser, m.keep.id, m.why, ACTION, { fillCounterparty: otherParty(m.keep) ? undefined : m.loser.provider })) done++; }
    catch (err) { console.error(`fold ${m.loser.id}: ${String(err).slice(-160)}`); }
  }
  console.log(`applied: ${done} twins folded into their survivors.`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0));
