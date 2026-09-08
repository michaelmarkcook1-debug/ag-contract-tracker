/**
 * Merge duplicate canonical events across the whole store — deterministic,
 * no model, no cost. The same rules the pipeline now applies at ingestion
 * (src/lib/ingestion/dedup.ts), run retrospectively:
 *
 *   same family, same primary entity, and
 *     - counterparties match (orgsMatch) within ±14 days, or
 *     - neither side has a counterparty and the titles match within 7 days.
 *
 * Keeper: published over needs_review, then more sources, then earliest.
 * Losers keep their row as excluded_noise with reviewReason
 * "duplicate_of:<keeperId>"; their SourceEvents move to the keeper, so the
 * keeper gains corroboration. A DedupDecision and a ReviewAction
 * (deterministic_duplicate_suppressed) record every merge — reversible.
 *
 * Dry run by default — prints the plan. Run with --apply to write.
 */
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";
import { orgsMatch, titleCounterparty, titleSimilarity, withinDays, amountsConflict,
         SAME_EVENT_WINDOW_DAYS, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY, TITLE_MATCH_THRESHOLD,
         TITLE_FALLBACK_THRESHOLD, VENDOR_WINDOW_FAMILIES, RESULTS_TITLE_THRESHOLD, COUNTERPARTY_FAMILIES } from "../src/lib/ingestion/dedup";

interface Ev {
  id: string; family: string; primaryEntityId: string; announcementDate: Date; counterparty: string | null;
  canonicalTitle: string; publicationStatus: string; createdAt: Date; sources: number;
}

function sameEvent(a: Ev, b: Ev): boolean {
  if (amountsConflict(a.canonicalTitle, b.canonicalTitle)) return false;
  if (VENDOR_WINDOW_FAMILIES.has(a.family)) {
    return withinDays(a.announcementDate, b.announcementDate, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY)
      && titleSimilarity(a.canonicalTitle, b.canonicalTitle) >= RESULTS_TITLE_THRESHOLD;
  }
  if (a.counterparty && b.counterparty) {
    if (!withinDays(a.announcementDate, b.announcementDate, SAME_EVENT_WINDOW_DAYS)) return false;
    return orgsMatch(a.counterparty, b.counterparty) || titleSimilarity(a.canonicalTitle, b.canonicalTitle) >= TITLE_FALLBACK_THRESHOLD;
  }
  if (a.counterparty || b.counterparty || COUNTERPARTY_FAMILIES.has(a.family)) return false;
  return withinDays(a.announcementDate, b.announcementDate, SAME_EVENT_WINDOW_DAYS_NO_COUNTERPARTY)
    && titleSimilarity(a.canonicalTitle, b.canonicalTitle) >= TITLE_MATCH_THRESHOLD;
}

// Own client rather than the shared singleton: a dropped Neon WebSocket
// leaves a client permanently "not queryable", and a 900-cluster run lives
// long enough to see one. On that error the client is replaced and the
// cluster retried once.
function newClient(): PrismaClient {
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new PrismaClient({ adapter } as any);
}
let prisma = newClient();
const isConnectionDeath = (err: unknown) => /not queryable|ErrorEvent|connection error|fetch failed/i.test(String(err instanceof Error ? err.message : err));

const keeperFirst = (a: Ev, b: Ev) =>
  (a.publicationStatus === "published" ? 0 : 1) - (b.publicationStatus === "published" ? 0 : 1)
  || b.sources - a.sources
  || a.createdAt.getTime() - b.createdAt.getTime();

// A dropped Neon WebSocket surfaces as an unhandled ErrorEvent outside any
// awaited chain and would kill the whole run; log it and carry on — the
// pipeline retries nothing, but the next batch reconnects.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (continuing):", String(reason).slice(0, 200));
});

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");

  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: { in: ["published", "needs_review"] }, primaryEntityId: { not: null }, announcementDate: { not: null } },
    select: {
      id: true, family: true, primaryEntityId: true, announcementDate: true, counterpartyRaw: true, canonicalTitle: true,
      publicationStatus: true, createdAt: true,
      contractDetails: { select: { clientRaw: true } }, maDetails: { select: { targetRaw: true } }, partnershipDetails: { select: { entityBRaw: true } },
      _count: { select: { sourceEvents: true } },
    },
  });
  const evs: Ev[] = rows.map(r => ({
    id: r.id, family: r.family, primaryEntityId: r.primaryEntityId!, announcementDate: r.announcementDate!,
    counterparty: r.counterpartyRaw ?? r.contractDetails?.clientRaw ?? r.maDetails?.targetRaw ?? r.partnershipDetails?.entityBRaw ?? titleCounterparty(r.canonicalTitle),
    canonicalTitle: r.canonicalTitle, publicationStatus: r.publicationStatus, createdAt: r.createdAt, sources: r._count.sourceEvents,
  }));
  console.log(`events considered: ${evs.length}`);

  // Union-find within (family, entity) groups, sorted by date so the window check can stop early.
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const groups = new Map<string, Ev[]>();
  for (const e of evs) { const k = `${e.family}|${e.primaryEntityId}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
  let pairs = 0;
  for (const g of groups.values()) {
    g.sort((a, b) => a.announcementDate.getTime() - b.announcementDate.getTime());
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (g[j].announcementDate.getTime() - g[i].announcementDate.getTime() > SAME_EVENT_WINDOW_DAYS * 86_400_000) break;
        if (sameEvent(g[i], g[j])) { union(g[i].id, g[j].id); pairs++; }
      }
    }
  }
  const clusters = new Map<string, Ev[]>();
  for (const e of evs) { const r = find(e.id); clusters.set(r, [...(clusters.get(r) ?? []), e]); }
  const merges: { keeper: Ev; losers: Ev[] }[] = [];
  for (const c of clusters.values()) { if (c.length < 2) continue; const [keeper, ...losers] = [...c].sort(keeperFirst); merges.push({ keeper, losers }); }
  const loserCount = merges.reduce((n, m) => n + m.losers.length, 0);
  console.log(`matching pairs: ${pairs} · clusters: ${merges.length} · events to fold in: ${loserCount}`);
  const byFamily = new Map<string, number>();
  merges.forEach(m => m.losers.forEach(l => byFamily.set(l.family, (byFamily.get(l.family) ?? 0) + 1)));
  console.log("folded by family:", [...byFamily.entries()].map(([k, v]) => `${k}=${v}`).join(", "));
  console.log("\nsample clusters:");
  const fr = merges.filter(m => m.keeper.family === "FINANCIAL_RESULTS").slice(0, 6);
  const rest = merges.filter(m => m.keeper.family !== "FINANCIAL_RESULTS").slice(0, 8);
  [...fr, ...rest].forEach(m => {
    console.log(`  KEEP  ${m.keeper.publicationStatus.padEnd(12)} ${m.keeper.announcementDate.toISOString().slice(0, 10)} ${m.keeper.canonicalTitle.slice(0, 70)}`);
    m.losers.forEach(l => console.log(`    ←   ${l.publicationStatus.padEnd(12)} ${l.announcementDate.toISOString().slice(0, 10)} ${l.canonicalTitle.slice(0, 70)}`));
  });

  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }

  // Four independent writes per loser, run in order rather than in one
  // transaction: connecting a cluster's sources to the keeper can exceed
  // Prisma's 5s transaction window on Neon, and a rollback then loses all four.
  let done = 0, failed = 0;
  const foldOne = async (m: { keeper: Ev; losers: Ev[] }, l: Ev) => {
        const loserSources = await prisma.sourceEvent.findMany({ where: { canonicalEvents: { some: { id: l.id } } }, select: { id: true } });
        if (loserSources.length) {
          await prisma.canonicalMarketEvent.update({ where: { id: m.keeper.id }, data: { sourceEvents: { connect: loserSources.map(s => ({ id: s.id })) } } });
        }
        await prisma.canonicalMarketEvent.update({ where: { id: l.id }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: `duplicate_of:${m.keeper.id}` } });
        await prisma.dedupDecision.upsert({
          where: { eventAId_eventBId: { eventAId: m.keeper.id, eventBId: l.id } },
          create: { eventAId: m.keeper.id, eventBId: l.id, decision: "merged_deterministic", confidence: 0.9, mergeRecommended: true, humanReviewRequired: false,
                    reasonCodes: JSON.stringify(["same_vendor", "counterparty_or_title_match", "date_window"]), resolvedAt: new Date(), resolvedBy: "dedupe-events.ts" },
          update: { decision: "merged_deterministic", confidence: 0.9, mergeRecommended: true, humanReviewRequired: false, resolvedAt: new Date(), resolvedBy: "dedupe-events.ts" },
        });
        await prisma.reviewAction.create({ data: { eventId: l.id, action: "deterministic_duplicate_suppressed", previousValue: l.publicationStatus, newValue: "excluded_noise", reviewerNote: `duplicate_of:${m.keeper.id}` } });
  };
  for (const m of merges) {
    for (const l of m.losers) {
      try {
        try { await foldOne(m, l); }
        catch (err) {
          if (!isConnectionDeath(err)) throw err;
          console.log("  connection lost — reconnecting and retrying this cluster");
          await prisma.$disconnect().catch(() => {});
          prisma = newClient();
          await new Promise(r => setTimeout(r, 2000));
          await foldOne(m, l);
        }
        done++;
      } catch (err) {
        failed++;
        if (failed <= 5) console.log(`  failed ${l.id}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
      if ((done + failed) % 100 === 0) console.log(`  merged ${done}/${loserCount}${failed ? ` (failed ${failed})` : ""}`);
    }
  }
  console.log(`done: ${done} events folded into ${merges.length} keepers${failed ? `; ${failed} failed` : ""}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
