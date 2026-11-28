/**
 * Duplicate contracts already in the catalogue, judged on what they say.
 *
 * Earlier passes compared records whose provider and client were spelled the
 * same, or whose titles shared words. Neither can tell that "Department of
 * Veterans Affairs · EHRM ceiling increase" and "VA · electronic health record
 * contract change" are one event, and both will merge two different awards to
 * the same client. This pass does what the backlog's headline pass does
 * (backlog-prepare --step context): candidates are found for free, then a
 * model answers one question per record, and says no when unsure.
 *
 *   candidates  same provider, announced within 45 days of each other, and
 *               either the client names overlap, the stated values are equal,
 *               or the titles share enough words to be worth asking about
 *   verdict     Haiku 5.5 with room to think; cached in _scratch
 *   merge       the richer record survives. The duplicate's sources are also
 *               attached to it; the duplicate becomes excluded_noise with
 *               reviewReason duplicate_of:<survivor>. Logged to ReviewAction,
 *               and --undo reverses every merge this script made.
 *
 * Two scopes:
 *   --scope catalogue (default)  every live CONTRACT record against the others
 *   --scope review               every record waiting in review, of any family, against the published catalogue and the
 *                                rest of the queue. A review item held because its article only mentions the event
 *                                (event_source_mismatch) is folded WITHOUT donating that article to the survivor.
 *
 * Dry run by default.
 *   npx tsx scripts/dedup-catalogue.ts [--scope review] [--limit N] [--budget 5] [--show] [--samples 30] [--apply]
 *   npx tsx scripts/dedup-catalogue.ts [--scope review] --undo
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { REVIEW_WINDOW, SYSTEM_CONTRACTS as SYSTEM, SYSTEM_REVIEW, DEDUPE_VERSION as VERSION, DEDUPE_MODELS, line as fmt, toEv, EV_SELECT, before, candidatesFor, judgeSame, foldDuplicate, type Ev } from "@/lib/ingestion/review-dedupe";

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 160)));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", "0"));
const BUDGET = Number(arg("--budget", "5"));
const SCOPE = arg("--scope", "catalogue") === "review" ? "review" : "catalogue";
/** How far apart two reports of one event can be dated. Review items get a wider look: there are few of them. */
const WINDOW: Record<string, number> = SCOPE === "review" ? REVIEW_WINDOW : { CONTRACT: 45 };
const windowDays = (family: string) => WINDOW[family] ?? 45;
/** Judge model: haiku (default, the catalogue pass) or sonnet (the review queue, at the owner's request 2026-11-27). */
const MODEL_NAME = arg("--model", "haiku") === "sonnet" ? "sonnet" : "haiku";
if (!DEDUPE_MODELS[MODEL_NAME]) throw new Error("unknown model");
const CACHE = (SCOPE === "review" ? "_scratch/review-verdicts" : "_scratch/catalogue-verdicts-v2") + (MODEL_NAME === "haiku" ? "" : `-${MODEL_NAME}`) + ".json";
const ACTION = SCOPE === "review" ? "dedup_review" : "dedup_catalogue";



async function undo() {
  const acts = await prisma.reviewAction.findMany({ where: { action: ACTION }, select: { eventId: true, previousValue: true, reviewerNote: true } });
  let n = 0;
  for (const a of acts) {
    // A review item goes back with the reason it was held for.
    const was = / · was:(.*)$/.exec(a.reviewerNote ?? "")?.[1] || null;
    const r = await prisma.canonicalMarketEvent.updateMany({ where: { id: a.eventId, publicationStatus: "excluded_noise", reviewReason: { startsWith: "duplicate_of:" } }, data: { publicationStatus: a.previousValue ?? "published", reviewReason: a.previousValue === "needs_review" ? was : null, humanReviewRequired: a.previousValue === "needs_review" } });
    n += r.count;
  }
  await prisma.reviewAction.createMany({ data: acts.map(a => ({ eventId: a.eventId, action: "dedup_catalogue_undone", previousValue: "excluded_noise", newValue: a.previousValue ?? "published", reviewerNote: VERSION })) });
  console.log(`restored ${n} of ${acts.length} merged records. Sources attached to the survivors were left in place; they are harmless.`);
}

const line = (e: Ev) => fmt(e, SCOPE === "review");

async function load(): Promise<Ev[]> {
  const where = SCOPE === "review"
    ? { publicationStatus: { in: ["published", "needs_review"] }, family: { in: Object.keys(WINDOW) } }
    : { family: "CONTRACT", publicationStatus: { in: ["published", "needs_review"] } };
  const ids = await prisma.canonicalMarketEvent.findMany({ where, select: { id: true } });
  const out: Ev[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const page = await prisma.canonicalMarketEvent.findMany({ where: { id: { in: ids.slice(i, i + 500).map(r => r.id) } }, select: EV_SELECT });
    for (const r of page) { const e = toEv(r); if (e) out.push(e); }
  }
  return out;
}

async function main() {
  if (process.argv.includes("--undo")) { await undo(); return; }
  const events = await load();
  const byVendor = new Map<string, Ev[]>();
  for (const e of events) (byVendor.get(e.vendorKey) ?? byVendor.set(e.vendorKey, []).get(e.vendorKey)!).push(e);

  // Candidates: for each record, up to six better-ranked records for the same provider within the window that share a client, a value or enough of a title.
  const jobs: { e: Ev; cands: Ev[] }[] = [];
  for (const group of byVendor.values()) {
    if (group.length < 2) continue;
    for (const e of group) {
      if (SCOPE === "review" && e.status !== "needs_review") continue;   // only the queue is judged; the catalogue is what it is judged against
      const cands = candidatesFor(e, group, windowDays, { loose: SCOPE === "review" });
      if (cands.length) jobs.push({ e, cands });
    }
  }
  const todo = LIMIT > 0 ? jobs.slice(0, LIMIT) : jobs;
  const cache: Record<string, { cands: string[]; same: number; why: string }> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  let spent = 0, asked = 0, failures = 0, stopped = false, cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    for (;;) {
      const job = todo[cursor++];
      if (!job) return;
      const candIds = job.cands.map(c => c.id);
      const hit = cache[job.e.id];
      if (hit && hit.cands.join() === candIds.join()) continue;
      if (spent >= BUDGET) { stopped = true; return; }
      const v = await judgeSame(job.e, job.cands, { model: MODEL_NAME, system: SCOPE === "review" ? SYSTEM_REVIEW : SYSTEM, withFamily: SCOPE === "review" });
      if (!v) { failures++; continue; }
      spent += v.costUsd;
      cache[job.e.id] = { cands: candIds, same: v.same, why: v.why };
      if (++asked % 200 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`  ${asked} judged · $${spent.toFixed(2)}`); }
    }
  }));
  fs.mkdirSync("_scratch", { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  // Merge, best records first, so a duplicate of a duplicate lands on the final survivor.
  const byId = new Map(events.map(e => [e.id, e]));
  const survivorOf = new Map<string, string>();
  const merges: { loser: Ev; keep: Ev; why: string }[] = [];
  let judged = 0;
  const ordered = [...todo].sort((a, b) => before(a.e, b.e) ? -1 : 1);
  for (const job of ordered) {
    const v = cache[job.e.id];
    if (!v || v.cands.join() !== job.cands.map(c => c.id).join()) continue;
    judged++;
    if (!v.same) continue;
    let keepId = v.cands[v.same - 1];
    while (survivorOf.has(keepId)) keepId = survivorOf.get(keepId)!;
    const keep = byId.get(keepId);
    if (!keep || keepId === job.e.id) continue;
    survivorOf.set(job.e.id, keepId);
    merges.push({ loser: job.e, keep, why: v.why });
  }

  console.log(`${SCOPE === "review" ? `review queue: ${events.filter(e => e.status === "needs_review").length} records, compared against ${events.filter(e => e.status === "published").length} published` : `live contract records: ${events.length}`}; with at least one candidate: ${jobs.length}; judged ${judged}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}; new verdicts ${asked} for $${spent.toFixed(2)} (${DEDUPE_MODELS[MODEL_NAME].id}); no verdict ${failures}${stopped ? "; STOPPED at the budget" : ""}`);
  const pub = merges.filter(m => m.loser.status === "published").length;
  const stated = merges.filter(m => m.loser.status === "published" && m.loser.stated != null);
  const kept = stated.filter(m => m.keep.stated != null);
  console.log(`duplicates found: ${merges.length} (${pub} published, ${merges.length - pub} in review)`);
  if (SCOPE === "review") {
    const fam: Record<string, number> = {}, into: Record<string, number> = {};
    for (const m of merges) { fam[m.loser.family] = (fam[m.loser.family] ?? 0) + 1; into[m.keep.status] = (into[m.keep.status] ?? 0) + 1; }
    console.log(`  by kind: ${Object.entries(fam).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ")}`);
    console.log(`  duplicate of something already published: ${into.published ?? 0}; duplicate of another review item: ${into.needs_review ?? 0}`);
    console.log(`  held as a passing mention (their article is not attached to the survivor): ${merges.filter(m => (m.loser.reason ?? "").includes("event_source_mismatch")).length}`);
  }
  console.log(`stated contract value counted twice today and removed by this merge: $${(kept.reduce((s, m) => s + (m.loser.stated ?? 0), 0) / 1e9).toFixed(1)}bn across ${kept.length} records`);
  const lost = merges.filter(m => m.loser.stated != null && m.keep.stated == null);
  if (lost.length) console.log(`note: ${lost.length} duplicates carry a stated value their survivor lacks (the survivor was published, the duplicate was in review); the value stays on the duplicate's record`);

  if (process.argv.includes("--show")) {
    const n = Number(arg("--samples", "30"));
    const pick = merges.map((m, i) => [m, Math.sin((i + 1) * 7919)] as const).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
    for (const m of pick) console.log(`  DUP  ${line(m.loser).slice(0, 210)}\n   =   ${line(m.keep).slice(0, 210)}\n       ${m.why}`);
  }
  if (!apply) { console.log("dry run: nothing changed. Re-run with --apply."); return; }

  let done = 0;
  for (const m of merges) {
    try {
      if (await foldDuplicate(m.loser, m.keep.id, m.why, ACTION)) done++;
    } catch (err) { console.error(`merge ${m.loser.id}: ${String(err).slice(-160)}`); }
  }
  console.log(`applied: ${done} duplicates folded into their survivors. Undo with: npx tsx scripts/dedup-catalogue.ts ${SCOPE === "review" ? "--scope review " : ""}--undo`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0));
