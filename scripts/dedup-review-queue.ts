/**
 * Deduplicate the needs_review queue. Deterministic only — no LLM, no cost.
 *
 * The existing dedup scripts (semantic/titles/entity-clusters) only ever look at
 * PUBLISHED events, so nothing has ever deduplicated the review queue.
 *
 * Similarity uses Jaccard (intersection / UNION). An earlier min()-denominator
 * version scored "Capita | New Win | DWP | BPO" as a 100% match for
 * "Capita | Framework Award | UK Civil Service | Pandemic Response", because the
 * shorter title's only long word was "capita" — that would have merged distinct
 * contracts. Jaccard plus a minimum token count and a same-family requirement
 * removes that failure mode.
 *
 * Survivor = highest confidence, then earliest created. Losers are marked
 * excluded_noise (reversible) rather than deleted.
 *
 * Run with --apply to write; default is a dry run.
 */
import { prisma } from "../src/lib/db";

const MIN_TOKENS = 4;      // ignore titles too short to compare meaningfully
const JACCARD = 0.75;      // intersection / union
const DAY_WINDOW = 7;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tokens = (t: string) => new Set(norm(t).split(" ").filter(w => w.length > 3));
function jaccard(a: Set<string>, b: Set<string>) {
  let inter = 0; a.forEach(w => { if (b.has(w)) inter++; });
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");

  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "needs_review" },
    select: { id: true, canonicalTitle: true, announcementDate: true, family: true, confidenceScore: true, createdAt: true },
  });
  console.log(`review queue: ${rows.length}`);

  const better = (a: typeof rows[0], b: typeof rows[0]) =>
    b.confidenceScore !== a.confidenceScore ? b.confidenceScore - a.confidenceScore
                                            : a.createdAt.getTime() - b.createdAt.getTime();

  const losers = new Map<string, string>();   // loserId -> survivorTitle

  // Pass 1 — identical normalised titles (same event from multiple sources)
  const byTitle = new Map<string, typeof rows>();
  rows.forEach(r => byTitle.set(norm(r.canonicalTitle), [...(byTitle.get(norm(r.canonicalTitle)) ?? []), r]));
  let exact = 0;
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    const [keep, ...drop] = [...group].sort(better);
    drop.forEach(d => { losers.set(d.id, keep.canonicalTitle); exact++; });
  }
  console.log(`  exact-title duplicates: ${exact}`);

  // Pass 2 — near-identical titles, same family, within the date window
  const prepared = rows.filter(r => !losers.has(r.id))
    .map(r => ({ ...r, tk: tokens(r.canonicalTitle), t: r.announcementDate?.getTime() ?? 0 }))
    .filter(r => r.tk.size >= MIN_TOKENS);
  let near = 0; const samples: string[] = [];
  for (let i = 0; i < prepared.length; i++) {
    if (losers.has(prepared[i].id)) continue;
    for (let j = i + 1; j < prepared.length; j++) {
      if (losers.has(prepared[j].id)) continue;
      if (prepared[i].family !== prepared[j].family) continue;
      if (Math.abs(prepared[i].t - prepared[j].t) / 86400000 > DAY_WINDOW) continue;
      const sim = jaccard(prepared[i].tk, prepared[j].tk);
      if (sim < JACCARD) continue;
      const [keep, drop] = [prepared[i], prepared[j]].sort(better);
      losers.set(drop.id, keep.canonicalTitle); near++;
      if (samples.length < 6) samples.push(`   ${(sim*100).toFixed(0)}%  keep: ${keep.canonicalTitle.slice(0,56)}\n         drop: ${drop.canonicalTitle.slice(0,56)}`);
    }
  }
  console.log(`  near-duplicate titles:  ${near}`);
  samples.forEach(s => console.log(s));

  console.log(`\nTOTAL to collapse: ${losers.size} of ${rows.length} (${((losers.size/rows.length)*100).toFixed(0)}%)`);
  console.log(`queue after dedup:  ${rows.length - losers.size}`);
  if (!apply) { console.log("\n(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }

  const ids = [...losers.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    await prisma.canonicalMarketEvent.updateMany({
      where: { id: { in: ids.slice(i, i + 200) } },
      data: { publicationStatus: "excluded_noise", humanReviewRequired: false },
    });
  }
  console.log(`\n✓ collapsed ${ids.length} duplicates into their surviving records`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
