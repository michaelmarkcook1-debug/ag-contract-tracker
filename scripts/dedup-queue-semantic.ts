/**
 * LLM adjudication for review-queue pairs in the ambiguous similarity band.
 *
 * Deterministic dedup safely handles >=0.75 Jaccard. Below that sit pairs that
 * are plainly the same event but worded differently by the extractor
 * ("Federal Reseller" vs "US Federal IT Reseller", "Extension" vs "Expansion"),
 * mixed in with genuinely distinct deals. Title overlap alone cannot separate
 * them, so each pair is judged by Haiku — the cheap tier, one short call each.
 *
 * Only pairs judged SAME are collapsed; anything else is left in the queue.
 * Losers are marked excluded_noise (reversible), never deleted.
 *
 * Run with --apply to write; default is a dry run.
 */
import { prisma } from "../src/lib/db";
import { MODEL_TIERS, costOf } from "../src/lib/ingestion/classifier";

const LOW = 0.50, HIGH = 0.75, DAYS = 7;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tok = (t: string) => new Set(norm(t).split(" ").filter(w => w.length > 3));
const jac = (a: Set<string>, b: Set<string>) => { let i = 0; a.forEach(w => { if (b.has(w)) i++; }); const u = a.size + b.size - i; return u ? i / u : 0; };

async function judge(a: string, b: string): Promise<{ same: boolean; cost: number }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL_TIERS.triage, max_tokens: 60,
      system: 'You judge whether two market-intelligence headlines describe THE SAME real-world event (same parties, same deal/announcement), even if worded differently. Different deals by the same vendor are DISTINCT. Return JSON only: {"verdict":"SAME"|"DISTINCT"}',
      messages: [{ role: "user", content: `A: ${a}\nB: ${b}` }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return { same: false, cost: 0 };
  const d = await res.json() as { content?: { type: string; text: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  const cost = costOf(MODEL_TIERS.triage, d.usage?.input_tokens ?? 0, d.usage?.output_tokens ?? 0);
  const text = (d.content ?? []).find(c => c.type === "text")?.text ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { same: false, cost };
  try { return { same: JSON.parse(m[0]).verdict === "SAME", cost }; } catch { return { same: false, cost }; }
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run\n");
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "needs_review" },
    select: { id: true, canonicalTitle: true, announcementDate: true, family: true, confidenceScore: true, createdAt: true },
  });
  const p = rows.map(r => ({ ...r, tk: tok(r.canonicalTitle), t: r.announcementDate?.getTime() ?? 0 })).filter(r => r.tk.size >= 4);
  const pairs: [typeof p[0], typeof p[0], number][] = [];
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
    if (p[i].family !== p[j].family) continue;
    if (Math.abs(p[i].t - p[j].t) / 86400000 > DAYS) continue;
    const s = jac(p[i].tk, p[j].tk);
    if (s >= LOW && s < HIGH) pairs.push([p[i], p[j], s]);
  }
  console.log(`queue: ${rows.length} | ambiguous pairs to judge: ${pairs.length}`);
  if (!pairs.length) { await prisma.$disconnect(); return; }

  const losers = new Map<string, string>(); let cost = 0, same = 0, distinct = 0;
  for (const [a, b, s] of pairs) {
    if (losers.has(a.id) || losers.has(b.id)) continue;
    const r = await judge(a.canonicalTitle, b.canonicalTitle);
    cost += r.cost;
    if (r.same) {
      const [keep, drop] = [a, b].sort((x, y) => y.confidenceScore - x.confidenceScore || x.createdAt.getTime() - y.createdAt.getTime());
      losers.set(drop.id, keep.id); same++;
      if (same <= 8) console.log(`  SAME ${(s*100).toFixed(0)}%  keep: ${keep.canonicalTitle.slice(0,52)}\n                drop: ${drop.canonicalTitle.slice(0,52)}`);
    } else { distinct++; }
  }
  console.log(`\nSAME: ${same} | DISTINCT: ${distinct} | judging cost $${cost.toFixed(4)}`);
  console.log(`queue after: ${rows.length - losers.size}`);
  if (!apply) { console.log("\n(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }
  const ids = [...losers.keys()];
  for (let i = 0; i < ids.length; i += 200)
    await prisma.canonicalMarketEvent.updateMany({ where: { id: { in: ids.slice(i, i+200) } }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false } });
  console.log(`\n✓ collapsed ${ids.length} semantic duplicates`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
