/**
 * Fetch page text for queued (pending) articles that have none, so the Batch API reader can read them.
 *
 * The backlog batch reader does not fetch pages; it leaves an article with no readable text queued for the daily run.
 * A queue-only backfill (backfill-history.ts --queue-only) stores Google News items with only a snippet, so this
 * step fetches each article with the ingestion module's own retrieval (Google News redirect decoding + publisher
 * fetch) and stores the text and publisher URL. A page that cannot be fetched is marked so it is not retried for
 * ever; the daily run still gets its own chance at it.
 *
 *   npx tsx scripts/fetch-pending-text.ts [--run-type backfill_queue] [--concurrency 6] [--limit N] [--apply]
 */
import { prisma } from "@/lib/db";
import { retrieveArticle, readableArticleText } from "@/lib/ingestion/article-text";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const RUN_TYPE = arg("--run-type", "backfill_queue");
const CONCURRENCY = Number(arg("--concurrency", "6"));
const LIMIT = Number(arg("--limit", "0")) || Infinity;
const UNFETCHABLE = "page text unavailable (fetch-pending-text)";

async function main() {
  const runs = (await prisma.ingestionRun.findMany({ where: { runType: RUN_TYPE }, select: { id: true } })).map(r => r.id);
  const rows = await prisma.sourceEvent.findMany({
    where: { processingStatus: "pending", ingestionRunId: { in: runs }, NOT: { processingError: UNFETCHABLE } },
    select: { id: true, sourceUrl: true, rawText: true },
  });
  const todo = rows.filter(r => !readableArticleText(r.rawText)).slice(0, LIMIT);
  console.log(`${RUN_TYPE}: ${rows.length} pending; ${todo.length} without readable text${apply ? "" : " (dry run)"}`);
  if (!apply) { await prisma.$disconnect(); process.exit(0); }
  let got = 0, failed = 0, next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const r = todo[next++];
      if (!r) return;
      try {
        const { publisherUrl, article } = await retrieveArticle(r.sourceUrl);
        const text = article ? readableArticleText(article.text) : null;
        if (text) { await prisma.sourceEvent.update({ where: { id: r.id }, data: { rawText: article!.text, publisherUrl: publisherUrl ?? article!.finalUrl } }); got++; }
        else { await prisma.sourceEvent.update({ where: { id: r.id }, data: { processingError: UNFETCHABLE, publisherUrl: publisherUrl ?? undefined } }); failed++; }
      } catch { failed++; }
      if ((got + failed) % 100 === 0) console.log(`  ${got + failed}/${todo.length} · text ${got} · unavailable ${failed}`);
    }
  }));
  console.log(`done: text fetched for ${got}, unavailable ${failed}`);
  await prisma.$disconnect();
  process.exit(0);
}
main();
