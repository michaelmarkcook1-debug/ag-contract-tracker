/**
 * Backfills article text on source events that have none, so every published event can be read from the article
 * rather than from the tracker's summary. Uses the ingestion module's own retrieval (Google News redirect decoding
 * plus publisher fetch); stores the readable text and the publisher URL on the source event; records the attempt
 * so a page that cannot be fetched is not retried for ever. Nothing else on the event is touched.
 *
 *   npx tsx scripts/backfill-article-text.ts                      dry run: counts only
 *   npx tsx scripts/backfill-article-text.ts --apply [--vendors accenture,tcs] [--limit 500] [--concurrency 3] [--max-attempts 3]
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local", override: true });
import { PrismaNeon } from "@prisma/adapter-neon"; import { PrismaClient } from "../src/generated/prisma/client";
import { retrieveArticle, readableArticleText } from "../src/lib/ingestion/article-text";
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) } as any);

const argv = process.argv.slice(2);
const flag = (k: string, d: string | null = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const apply = argv.includes("--apply");
const vendors = flag("--vendors")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const limit = Number(flag("--limit", "0")) || Infinity;
const concurrency = Number(flag("--concurrency", "3"));
const maxAttempts = Number(flag("--max-attempts", "3"));
const MAX_CHARS = 20_000;

async function main() {
  const where: any = { publicationStatus: "published" };
  if (vendors) {
    const ents = await prisma.entity.findMany({ where: { slug: { in: vendors } }, select: { id: true } });
    where.primaryEntityId = { in: ents.map((e: any) => e.id) };
  }
  const evs = await prisma.canonicalMarketEvent.findMany({ where, orderBy: { announcementDate: "desc" }, select: { id: true, announcementDate: true, sourceEvents: { select: { id: true, sourceUrl: true, rawText: true, readAttempts: true } } } });
  // One source row per event to fetch: the first without readable text that has not exhausted its attempts.
  const todo: { eventId: string; sourceId: string; url: string; attempts: number }[] = [];
  let withText = 0, exhausted = 0, notPages = 0;
  for (const e of evs as any[]) {
    if (e.sourceEvents.some((s: any) => readableArticleText(s.rawText, 300, 50))) { withText++; continue; }
    // Procurement records carry a feed key (AU_AusTender, US_USAspending, EU_TED ...) as their source, not a page: nothing to fetch.
    const pages = e.sourceEvents.filter((s: any) => /^https?:\/\//i.test(s.sourceUrl));
    if (!pages.length) { notPages++; continue; }
    const s = pages.find((s: any) => (s.readAttempts ?? 0) < maxAttempts);
    if (!s) { exhausted++; continue; }
    todo.push({ eventId: e.id, sourceId: s.id, url: s.sourceUrl, attempts: s.readAttempts ?? 0 });
  }
  const work = todo.slice(0, Number.isFinite(limit) ? limit : todo.length);
  console.log(`published events ${evs.length}: with text ${withText}, not a page (procurement records) ${notPages}, to fetch ${todo.length} newest first (attempts exhausted ${exhausted}); this run ${work.length}`);
  if (!apply) { console.log("(dry run — re-run with --apply)"); await prisma.$disconnect(); return; }

  let i = 0, ok = 0, resolvedNoText = 0, failed = 0; const t0 = Date.now(); const hosts = new Map<string, number>(); const noTextHosts = new Map<string, number>();
  const worker = async () => {
    while (i < work.length) {
      const w = work[i++];
      const out = await retrieveArticle(w.url, MAX_CHARS).catch(() => ({ publisherUrl: null, article: null }));
      const text = out.article?.text ? readableArticleText(out.article.text, 300, 50) : null;
      if (text) {
        ok++;
        const host = (() => { try { return new URL(out.article!.finalUrl ?? out.publisherUrl!).hostname.replace(/^www\./, ""); } catch { return "?"; } })();
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
        await prisma.sourceEvent.update({ where: { id: w.sourceId }, data: { rawText: out.article!.text.slice(0, 60_000), publisherUrl: out.publisherUrl ?? undefined, readAttempts: w.attempts + 1 } });
      } else {
        if (out.publisherUrl) { resolvedNoText++; try { const h = new URL(out.publisherUrl).hostname.replace(/^www\./, ""); noTextHosts.set(h, (noTextHosts.get(h) ?? 0) + 1); } catch {} } else failed++;
        await prisma.sourceEvent.update({ where: { id: w.sourceId }, data: { publisherUrl: out.publisherUrl ?? undefined, readAttempts: w.attempts + 1 } });
      }
      if ((ok + resolvedNoText + failed) % 100 === 0) console.log(`  ${ok + resolvedNoText + failed}/${work.length}: text ${ok}, resolved-no-text ${resolvedNoText}, unresolved ${failed}, ${Math.round((Date.now() - t0) / 1000)}s`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`✓ done: text stored for ${ok}, resolved but no text ${resolvedNoText}, unresolved ${failed}, ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("top publishers:", [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([h, n]) => `${h} ${n}`).join(", "));
  console.log("resolved but unreadable, by host:", [...noTextHosts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([h, n]) => `${h} ${n}`).join(", "));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
