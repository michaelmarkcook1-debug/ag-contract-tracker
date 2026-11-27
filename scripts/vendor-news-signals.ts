/**
 * Collect vendor news and incident signals for Deal Maker (see src/lib/dealmaker/news.ts).
 *
 * For each tracked vendor: GDELT DOC 2.0 article list for the last --months months (up to 75 English headlines),
 * then one Haiku call that places each headline in a category or "none" (not about this company, or no signal).
 * Results replace SystemSetting "dealmaker.newsSignals"; vendors that fail keep their previous entry.
 *
 *   npx tsx scripts/vendor-news-signals.ts [--months 6] [--delay 6] [--only "Accenture,IBM"] [--dry]
 */
import { TRACKED_VENDORS } from "@/lib/ingestion/sources";
import { prisma } from "@/lib/db";
import { CATEGORIES, NEWS_VERSION, getNewsSignals, saveNewsSignals, scoreCounts, type Category, type Headline, type NewsSignals, type VendorNews } from "@/lib/dealmaker/news";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const MONTHS = Number(arg("--months", "6"));
const DELAY = Number(arg("--delay", "6")) * 1000;
const ONLY = arg("--only", "").split(",").map(s => s.trim()).filter(Boolean);
const dry = process.argv.includes("--dry");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Haiku 5.5, USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, read 2026-11-27). */
const HAIKU = { id: "claude-haiku-5-5", input: 0.1, output: 0.5 };

/** How the press names a vendor whose short name is ambiguous in news search. */
const QUERY_NAME: Record<string, string> = {
  AWS: "Amazon Web Services", EY: "Ernst & Young", NICE: "NICE Ltd", TCS: "Tata Consultancy Services", UST: "UST Global", EXL: "EXL Service",
  NEC: "NEC Corporation", Indra: "Indra Sistemas", ADP: "Automatic Data Processing", "Orange Business": "Orange Business", SAP: "SAP SE",
  "CSS Corp": "CSS Corp", Majorel: "Majorel", iQor: "iQor", Searce: "Searce",
};

let cooldownUntil = 0;
async function gdelt(name: string): Promise<{ title: string; url: string; seendate: string; domain: string }[] | null> {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${name}" sourcelang:english`)}&mode=artlist&maxrecords=75&format=json&timespan=${MONTHS}m`;
  const steps = [30, 75, 150, 300];
  for (let i = 0; i < 4; i++) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(Math.min(wait, 300_000));
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; contract-tracker/1.0)" }, signal: AbortSignal.timeout(60_000) });
      const body = (await res.text()).trim();
      if (res.status === 429 || /limit requests/i.test(body)) { cooldownUntil = Date.now() + steps[i] * 1000; continue; }
      if (!res.ok) return null;
      if (!body.startsWith("{")) return [];
      return ((JSON.parse(body) as { articles?: { title: string; url: string; seendate: string; domain: string }[] }).articles ?? []);
    } catch { await sleep(10_000 * (i + 1)); }
  }
  return null;
}

const SYSTEM = `You classify news headlines about one company for an IT-services market tracker. For each numbered headline, give the single category that best fits what the headline says happened TO or BY this company:
${CATEGORIES.map(c => `- ${c.key}: ${c.label}`).join("\n")}
- none: not about this company (a namesake, a passing mention), or no such event
legal = lawsuits, bid protests, investigations, fines, settlements, regulatory action. security = data breaches, ransomware, cyber attacks, outages. financial = layoffs, job cuts, losses, downgrades, restructuring, profit warnings. leadership = a senior executive leaving or replaced. contract_loss = a lost re-compete, a terminated, cancelled or not-renewed contract.
Reply with JSON only: {"c": ["<category for headline 1>", "<category for headline 2>", ...]}`;

async function classify(vendor: string, titles: string[]): Promise<{ cats: (Category | "none")[]; costUsd: number } | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: HAIKU.id, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content: `Company: ${vendor}\n\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}` }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  const d = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  const raw = (d.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
  const m = raw.match(/\{[\s\S]*\}/);
  let arr: unknown[] = [];
  try { arr = m ? (JSON.parse(m[0]) as { c?: unknown[] }).c ?? [] : []; } catch { return null; }
  const valid = new Set<string>([...CATEGORIES.map(c => c.key), "none"]);
  const cats = titles.map((_, i) => valid.has(String(arr[i])) ? String(arr[i]) as Category | "none" : "none");
  return { cats, costUsd: ((d.usage?.input_tokens ?? 0) * HAIKU.input + (d.usage?.output_tokens ?? 0) * HAIKU.output) / 1e6 };
}

async function main() {
  const prev = await getNewsSignals();
  const out: NewsSignals = { version: NEWS_VERSION, fetchedAt: new Date().toISOString(), months: MONTHS, vendors: { ...(prev?.vendors ?? {}) } };
  const vendors = ONLY.length ? TRACKED_VENDORS.filter(v => ONLY.includes(v)) : [...TRACKED_VENDORS];
  let cost = 0, ok = 0, failed = 0;
  for (const [i, vendor] of vendors.entries()) {
    if (i) await sleep(DELAY);
    const arts = await gdelt(QUERY_NAME[vendor] ?? vendor);
    if (!arts) { failed++; console.log(`  ${vendor}: GDELT unavailable (kept previous)`); continue; }
    const seen = new Set<string>();
    const uniq = arts.filter(a => { const k = a.title.toLowerCase().replace(/\W+/g, " ").trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
    const res = uniq.length ? await classify(vendor, uniq.map(a => a.title.slice(0, 200))) : { cats: [], costUsd: 0 };
    if (!res) { failed++; console.log(`  ${vendor}: classification failed (kept previous)`); continue; }
    cost += res.costUsd;
    const counts: Partial<Record<Category, number>> = {};
    const examples: Headline[] = [];
    uniq.forEach((a, k) => {
      const c = res.cats[k];
      if (c === "none") return;
      counts[c] = (counts[c] ?? 0) + 1;
      if (c !== "contract_win" && c !== "ma") examples.push({ title: a.title, url: a.url, domain: a.domain, category: c, date: `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` });
    });
    const order: Category[] = ["legal", "security", "contract_loss", "financial", "leadership"];
    examples.sort((x, y) => order.indexOf(x.category) - order.indexOf(y.category) || y.date.localeCompare(x.date));
    const v: VendorNews = { score: scoreCounts(counts), counts, examples: examples.slice(0, 6), scanned: uniq.length, fetchedAt: new Date().toISOString() };
    out.vendors[vendor] = v; ok++;
    console.log(`  ${vendor.padEnd(24)} risk ${String(v.score).padStart(3)} · ${uniq.length} headlines · ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ") || "no signals"}`);
  }
  console.log(`vendors: ${ok} updated, ${failed} kept previous · Haiku $${cost.toFixed(3)}`);
  if (!dry) { await saveNewsSignals(out); console.log("saved to SystemSetting dealmaker.newsSignals"); }
  await prisma.$disconnect();
  process.exit(0);
}
main();
