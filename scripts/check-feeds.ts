/**
 * Feed health check — crawls every configured source in parallel and reports
 * which are LIVE (returning articles), EMPTY (reachable but 0 items) or DEAD
 * (404/403/timeout/fetch failure).
 *
 * Vendor RSS URLs rot frequently: companies silently move or retire their
 * newsroom/IR feeds, and the pipeline then quietly ingests nothing. Run this
 * whenever ingestion volume drops:
 *
 *   npm run check:feeds
 *
 * Exits 1 if any source is DEAD, so it can gate CI if desired.
 */
import {
  ALL_SOURCES,
  VENDOR_RSS_SOURCES,
  INVESTOR_RELATIONS_SOURCES,
  WIRE_SOURCES,
  GOOGLE_NEWS_SOURCES,
  PROCUREMENT_SOURCES,
  SourceDefinition,
} from "../src/lib/ingestion/sources";
import { crawlSource } from "../src/lib/ingestion/crawler";

type Verdict = "LIVE" | "EMPTY" | "DEAD";
interface Row { name: string; url: string; verdict: Verdict; detail: string }

async function checkGroup(label: string, sources: SourceDefinition[]): Promise<Row[]> {
  if (sources.length === 0) {
    console.log(`\n=== ${label} — none configured ===`);
    return [];
  }
  const rows: Row[] = await Promise.all(
    sources.map(async (s): Promise<Row> => {
      try {
        const { articles, error } = await crawlSource(s);
        if (error) return { name: s.name, url: s.url, verdict: "DEAD", detail: error };
        if (articles.length === 0) return { name: s.name, url: s.url, verdict: "EMPTY", detail: "0 items" };
        return { name: s.name, url: s.url, verdict: "LIVE", detail: `${articles.length} items` };
      } catch (err) {
        return { name: s.name, url: s.url, verdict: "DEAD", detail: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const icon: Record<Verdict, string> = { LIVE: "✓", EMPTY: "○", DEAD: "✗" };
  const counts = { LIVE: 0, EMPTY: 0, DEAD: 0 };
  console.log(`\n=== ${label} (${sources.length}) ===`);
  for (const r of rows) {
    counts[r.verdict]++;
    // Only print the noise-free summary line; DEAD/EMPTY include the reason.
    if (r.verdict === "LIVE") console.log(`  ${icon[r.verdict]} ${r.name.slice(0, 38).padEnd(40)} ${r.detail}`);
    else console.log(`  ${icon[r.verdict]} ${r.name.slice(0, 38).padEnd(40)} ${r.detail}\n      ${r.url}`);
  }
  console.log(`  → ${counts.LIVE} live, ${counts.EMPTY} empty, ${counts.DEAD} dead`);
  return rows;
}

async function main() {
  const all: Row[] = [];
  all.push(...await checkGroup("VENDOR PRESS RSS", VENDOR_RSS_SOURCES));
  all.push(...await checkGroup("INVESTOR RELATIONS", INVESTOR_RELATIONS_SOURCES));
  all.push(...await checkGroup("WIRE SERVICES", WIRE_SOURCES));
  all.push(...await checkGroup("PROCUREMENT", PROCUREMENT_SOURCES));
  all.push(...await checkGroup("GOOGLE NEWS", GOOGLE_NEWS_SOURCES));

  const dead = all.filter(r => r.verdict === "DEAD");
  const empty = all.filter(r => r.verdict === "EMPTY");
  const live = all.filter(r => r.verdict === "LIVE");
  const items = live.reduce((n, r) => n + parseInt(r.detail), 0);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`TOTAL: ${ALL_SOURCES.length} sources — ${live.length} live, ${empty.length} empty, ${dead.length} dead`);
  console.log(`Articles available this pass: ${items}`);
  if (dead.length) {
    console.log(`\nDEAD sources need new URLs:`);
    dead.forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  process.exit(dead.length > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
