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
 * Dry run by default.
 *   npx tsx scripts/dedup-catalogue.ts [--limit N] [--budget 5] [--show] [--samples 30] [--apply]
 *   npx tsx scripts/dedup-catalogue.ts --undo
 */
import fs from "fs";
import { prisma } from "@/lib/db";

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 160)));
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", "0"));
const BUDGET = Number(arg("--budget", "5"));
const WINDOW_DAYS = 45;
const REMENTION_DAYS = 365;
const DAY = 86_400_000;
const MODEL = { id: "claude-haiku-5-5", inPerM: 0.1, outPerM: 0.5 };
const CACHE = "_scratch/catalogue-verdicts-v2.json";
const ACTION = "dedup_catalogue";
const VERSION = "dedup-catalogue/1.1.0-2026-11-25";

const SYSTEM = [
  "You compare contract records in an IT-services market tracker. Every record below is for the same provider.",
  "Decide whether RECORD describes the same contract event as one of the numbered CANDIDATES.",
  "Same event: the same award, renewal, extension, expansion or termination between this provider and the same client, as reported by different sources. Client names may be written differently (an acronym, an agency or parent name, a legal suffix). A stated value on one record and none, or an estimate, on the other does not make them different.",
  "A later record that only re-reports or refers back to a contract already recorded (same client, same stated value, no new award, renewal or change of its own) is the same event.",
  "An unnamed client matches a named one only when the date, scope and stated value together clearly identify the same deal; a similar scope alone is not enough.",
  "NOT the same: a different client; a different contract or programme with the same client; a different kind of event on the same contract (an award and its later extension, expansion, dispute or termination); a framework award and a call-off under it; stated values that clearly conflict; separate announcements that happen to fall close together.",
  "If you are not sure, answer 0.",
  "Reply with JSON only: {\"same\": <candidate number, or 0 for none>, \"why\": \"<12 words>\"}",
].join("\n");

interface Ev {
  id: string; title: string; date: Date | null; status: string; vendorKey: string; client: string | null; anon: boolean;
  type: string | null; eventStatus: string | null; stated: number | null; estimate: number | null; origValue: number | null; origCcy: string | null;
  term: number | null; scope: string | null; sources: number; created: Date;
}

const STOP = new Set(("a an and the of to in on for with by at from as its it is are be via over into under up through new this that their will has have " +
  "contract deal award win wins won new_win newwin renewal extension expansion services service solutions unnamed client undisclosed").split(" "));
const SUFFIX = new Set(["inc", "incorporated", "ltd", "limited", "plc", "llc", "corp", "corporation", "co", "company", "group", "holdings", "sa", "ag", "nv", "se", "gmbh", "pvt", "private", "the", "of", "and", "for"]);
const words = (s: string | null) => (s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const nameTokens = (s: string | null) => new Set(words(s).filter(w => !SUFFIX.has(w)));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
/** One name inside the other counts as a match too ("Home Office" / "UK Home Office"). */
function clientSim(a: string | null, b: string | null): number {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return Math.max(n / (x.size + y.size - n), n / Math.min(x.size, y.size) >= 1 ? 0.8 : 0);
}
const money = (v: number | null) => v == null ? null : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}bn` : `$${(v / 1e6).toFixed(1)}m`;
const day = (d: Date | null) => d ? d.toISOString().slice(0, 10) : "undated";
function line(e: Ev): string {
  // Only a value the parties stated is shown. Our own estimate is a calculation, and two similar records get the same
  // one, which reads as evidence of identity when it is none.
  const value = e.stated != null ? `${money(e.stated)} stated` : "not stated";
  return `(${day(e.date)}) [${e.type ?? "?"}${e.eventStatus ? ", " + e.eventStatus.toLowerCase() : ""}] client: ${e.client ?? (e.anon ? "unnamed" : "none given")} | value: ${value}${e.term ? ` | term: ${e.term} months` : ""} | ${e.title.slice(0, 150)}${e.scope ? ` | scope: ${e.scope.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 170)}` : ""}`;
}

async function load(): Promise<Ev[]> {
  const ids = await prisma.canonicalMarketEvent.findMany({ where: { family: "CONTRACT", publicationStatus: { in: ["published", "needs_review"] } }, select: { id: true } });
  const out: Ev[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const page = await prisma.canonicalMarketEvent.findMany({
      where: { id: { in: ids.slice(i, i + 500).map(r => r.id) } },
      select: {
        id: true, canonicalTitle: true, announcementDate: true, publicationStatus: true, primaryEntityId: true, counterpartyRaw: true, eventStatus: true, createdAt: true,
        contractDetails: { select: { vendorRaw: true, clientRaw: true, clientAnonymised: true, contractEventType: true, tcvCommittedUsd: true, tcvEstimateMidUsd: true, tcvOriginalValue: true, tcvOriginalCurrency: true, contractLengthMonths: true, scopeSummary: true } },
        _count: { select: { sourceEvents: true } },
      },
    });
    for (const e of page) {
      const cd = e.contractDetails;
      const vendorKey = e.primaryEntityId ?? (cd?.vendorRaw ? "raw:" + words(cd.vendorRaw).join(" ") : "");
      if (!vendorKey) continue;
      out.push({
        id: e.id, title: e.canonicalTitle, date: e.announcementDate, status: e.publicationStatus, vendorKey,
        client: cd?.clientRaw ?? e.counterpartyRaw ?? null, anon: !!cd?.clientAnonymised, type: cd?.contractEventType ?? null, eventStatus: e.eventStatus,
        // A stated value of exactly 0 is an empty field, not a contract worth nothing.
        stated: cd?.tcvCommittedUsd && cd.tcvCommittedUsd > 0 ? cd.tcvCommittedUsd : null, estimate: cd?.tcvEstimateMidUsd ?? null, origValue: cd?.tcvOriginalValue ?? null, origCcy: cd?.tcvOriginalCurrency ?? null,
        term: cd?.contractLengthMonths ?? null, scope: cd?.scopeSummary ?? null, sources: e._count.sourceEvents, created: e.createdAt,
      });
    }
  }
  return out;
}

/** Lower is the better record to keep: published, a stated value, more sources, more detail, older. */
const rank = (e: Ev) => [e.status === "published" ? 0 : 1, e.stated != null ? 0 : 1, -e.sources, -(e.scope?.length ?? 0) - (e.client ? 200 : 0) - (e.term ? 100 : 0), e.created.getTime()];
const before = (a: Ev, b: Ev) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return a.id < b.id; };

async function undo() {
  const acts = await prisma.reviewAction.findMany({ where: { action: ACTION }, select: { eventId: true, previousValue: true } });
  let n = 0;
  for (const a of acts) {
    const r = await prisma.canonicalMarketEvent.updateMany({ where: { id: a.eventId, publicationStatus: "excluded_noise", reviewReason: { startsWith: "duplicate_of:" } }, data: { publicationStatus: a.previousValue ?? "published", reviewReason: null, humanReviewRequired: a.previousValue === "needs_review" } });
    n += r.count;
  }
  await prisma.reviewAction.createMany({ data: acts.map(a => ({ eventId: a.eventId, action: "dedup_catalogue_undone", previousValue: "excluded_noise", newValue: a.previousValue ?? "published", reviewerNote: VERSION })) });
  console.log(`restored ${n} of ${acts.length} merged records. Sources attached to the survivors were left in place; they are harmless.`);
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
    const vendorWords = new Set(words(group[0].title.split("|")[0]));
    const tok = new Map(group.map(e => [e.id, new Set(words(e.title + " " + (e.scope ?? "").slice(0, 200)).filter(w => !STOP.has(w) && !vendorWords.has(w) && w.length > 1))]));
    for (const e of group) {
      if (!e.date) continue;
      const scored: [Ev, number][] = [];
      for (const o of group) {
        if (o.id === e.id || !o.date || !before(o, e)) continue;
        const gap = Math.abs(o.date.getTime() - e.date.getTime());
        if (gap > REMENTION_DAYS * DAY) continue;
        const c = clientSim(e.client, o.client);
        const sameValue = e.stated != null && o.stated != null && Math.abs(e.stated - o.stated) <= 0.01 * Math.max(e.stated, o.stated);
        // Beyond the normal window only one case is worth asking about: the same client and the same stated value,
        // which is how a contract re-reported months later shows up (and how its value gets counted twice).
        if (gap > WINDOW_DAYS * DAY && !(sameValue && c >= 0.5)) continue;
        const t = jaccard(tok.get(e.id)!, tok.get(o.id)!);
        const bothNamed = !!e.client && !!o.client;
        const plausible = c >= 0.5 || sameValue || t >= 0.4 || (!bothNamed && t >= 0.25) || (bothNamed && t >= 0.3);
        if (plausible) scored.push([o, c * 1.5 + t + (sameValue ? 0.5 : 0)]);
      }
      if (scored.length) jobs.push({ e, cands: scored.sort((a, b) => b[1] - a[1]).slice(0, 6).map(s => s[0]) });
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
      const user = `RECORD: ${line(job.e)}\n\nCANDIDATES:\n` + job.cands.map((c, n) => `${n + 1}. ${line(c)}`).join("\n");
      try {
        let res: Response | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
            headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
            // 2500: on the hard comparisons Haiku thinks first, and a small allowance runs out mid-thought.
            body: JSON.stringify({ model: MODEL.id, max_tokens: 2500, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
            signal: AbortSignal.timeout(60_000) });
          if (res.ok || (res.status !== 429 && res.status < 500)) break;
          await new Promise(r => setTimeout(r, 1500 * 2 ** attempt));
        }
        if (!res || !res.ok) { failures++; continue; }
        const d = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
        const u = d.usage ?? {};
        spent += ((u.input_tokens ?? 0) * MODEL.inPerM + (u.cache_read_input_tokens ?? 0) * MODEL.inPerM * 0.1 + (u.cache_creation_input_tokens ?? 0) * MODEL.inPerM * 1.25 + (u.output_tokens ?? 0) * MODEL.outPerM) / 1e6;
        const raw = (d.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
        const v = /"same"\s*:\s*(\d+)/.exec(raw);
        if (!v) { failures++; continue; }
        const n = Number(v[1]);
        cache[job.e.id] = { cands: candIds, same: n >= 1 && n <= candIds.length ? n : 0, why: (/"why"\s*:\s*"([^"]*)/.exec(raw)?.[1] ?? "").slice(0, 140) };
        if (++asked % 200 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log(`  ${asked} judged · $${spent.toFixed(2)}`); }
      } catch { failures++; }
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

  console.log(`live contract records: ${events.length}; with at least one candidate: ${jobs.length}; judged ${judged}${LIMIT > 0 ? ` (limit ${LIMIT})` : ""}; new verdicts ${asked} for $${spent.toFixed(2)} (${MODEL.id}); no verdict ${failures}${stopped ? "; STOPPED at the budget" : ""}`);
  const pub = merges.filter(m => m.loser.status === "published").length;
  const stated = merges.filter(m => m.loser.status === "published" && m.loser.stated != null);
  const kept = stated.filter(m => m.keep.stated != null);
  console.log(`duplicates found: ${merges.length} (${pub} published, ${merges.length - pub} in review)`);
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
      await prisma.$transaction(async tx => {
        const cur = await tx.canonicalMarketEvent.findUnique({ where: { id: m.loser.id }, select: { publicationStatus: true, sourceEvents: { select: { id: true } } } });
        if (!cur || cur.publicationStatus === "excluded_noise") return;
        // The duplicate's sources also support the survivor. They stay linked to the duplicate too, so an undo needs nothing else.
        if (cur.sourceEvents.length) await tx.canonicalMarketEvent.update({ where: { id: m.keep.id }, data: { sourceEvents: { connect: cur.sourceEvents.map(s => ({ id: s.id })) } } });
        await tx.canonicalMarketEvent.update({ where: { id: m.loser.id }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: `duplicate_of:${m.keep.id}` } });
        await tx.reviewAction.create({ data: { eventId: m.loser.id, action: ACTION, previousValue: cur.publicationStatus, newValue: "excluded_noise", reviewerNote: `${VERSION} duplicate_of:${m.keep.id} · ${m.why}`.slice(0, 500) } });
      });
      done++;
    } catch (err) { console.error(`merge ${m.loser.id}: ${String(err).slice(-160)}`); }
  }
  console.log(`applied: ${done} duplicates folded into their survivors. Undo with: npx tsx scripts/dedup-catalogue.ts --undo`);
}

main().then(() => prisma.$disconnect()).then(() => process.exit(0));
