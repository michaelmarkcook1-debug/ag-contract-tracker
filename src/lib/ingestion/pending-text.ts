/**
 * Page text for queued (pending) articles that have none, so the Batch API reader can read them.
 *
 * Shared by scripts/fetch-pending-text.ts and GET /api/cron/fetch-text. The production route exists because Google
 * News sends requests from a UK/EU address to its cookie-consent page, so the link to the publisher cannot be
 * resolved from a laptop there; from Vercel's US region it resolves normally.
 */
import { prisma } from "@/lib/db";
import { retrieveArticle, readableArticleText } from "./article-text";

export const UNFETCHABLE = "page text unavailable (fetch-pending-text)";
export const UNFETCHABLE_PROD = "page text unavailable (fetched from production)";

export interface PendingTextResult { candidates: number; attempted: number; fetched: number; unavailable: number; remaining: number }

export async function fetchPendingText(opts: { runType?: string; limit?: number; concurrency?: number; deadlineMs?: number; retryLocalFailures?: boolean; write?: boolean } = {}): Promise<PendingTextResult> {
  const started = Date.now();
  const runIds = opts.runType ? (await prisma.ingestionRun.findMany({ where: { runType: opts.runType }, select: { id: true } })).map(r => r.id) : null;
  // A row that failed only from the laptop (consent wall) is tried again here; one that failed in production is not.
  const skip = opts.retryLocalFailures ? [UNFETCHABLE_PROD] : [UNFETCHABLE, UNFETCHABLE_PROD];
  const rows = await prisma.sourceEvent.findMany({
    where: { processingStatus: "pending", ...(runIds ? { ingestionRunId: { in: runIds } } : {}), OR: [{ processingError: null }, { processingError: { notIn: skip } }] },
    select: { id: true, sourceUrl: true, rawText: true },
  });
  const todo = rows.filter(r => !readableArticleText(r.rawText));
  const batch = todo.slice(0, opts.limit ?? todo.length);
  const res: PendingTextResult = { candidates: todo.length, attempted: 0, fetched: 0, unavailable: 0, remaining: todo.length };
  if (opts.write === false) return res;
  const marker = process.env.VERCEL ? UNFETCHABLE_PROD : UNFETCHABLE;
  let next = 0;
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, async () => {
    for (;;) {
      if (opts.deadlineMs && Date.now() - started > opts.deadlineMs) return;
      const r = batch[next++];
      if (!r) return;
      res.attempted++;
      try {
        const { publisherUrl, article } = await retrieveArticle(r.sourceUrl);
        const text = article ? readableArticleText(article.text) : null;
        if (text) { await prisma.sourceEvent.update({ where: { id: r.id }, data: { rawText: article!.text, publisherUrl: publisherUrl ?? article!.finalUrl, processingError: null } }); res.fetched++; }
        else { await prisma.sourceEvent.update({ where: { id: r.id }, data: { processingError: marker, publisherUrl: publisherUrl ?? undefined } }); res.unavailable++; }
      } catch { res.unavailable++; }
    }
  }));
  res.remaining = todo.length - res.attempted;
  return res;
}
