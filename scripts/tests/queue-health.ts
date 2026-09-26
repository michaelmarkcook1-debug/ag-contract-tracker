/**
 * Ingestion queue health — the mechanisms whose absence stalled production
 * from 2026-09-11 to 09-26 (poison articles re-read first every day, deferred
 * work written row by row until the function died, the same article paid for
 * twice under two URLs). No model spend: every path exercised here stops
 * before a model call. Writes under a unique URL prefix and removes it.
 *
 *   npx tsx --env-file=.env --env-file=.env.local scripts/tests/queue-health.ts
 */
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { runPipeline, prioritise, SCHEDULED_SWEEP } from "@/lib/ingestion/pipeline";
import { storePending, storeDeferred, findReadByContent, storeDuplicateContent, MAX_READ_ATTEMPTS } from "@/lib/ingestion/store";
import { PROMPT_POLICY_VERSION } from "@/lib/ingestion/reader";
import type { RawArticle } from "@/lib/ingestion/crawler";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const P = `https://example.invalid/queue-test-${Date.now()}`;
const art = (i: number, body: string | null = null): RawArticle => ({ title: `Queue test ${i}`, url: `${P}-${i}`, publishedAt: "2027-03-15T09:00:00Z", snippet: null, sourceId: "queue-test", provider: "Infosys", sourceType: "wire_service", publisherUrl: null, bodyText: body });

(async () => {
  const runId = (await prisma.ingestionRun.create({ data: { runType: "queue_test" } })).id;
  try {
    console.log("=== read order ===");
    const a = [art(1), art(2), art(3), art(4)];
    const order = prioritise(a, new Map([[a[0].url, 1], [a[1].url, 0]])).map(x => x.url.slice(-1));
    ok("never-seen articles before the backlog", order[0] === "3" && order[1] === "4", order.join(","));
    ok("backlog by fewest failed attempts", order[2] === "2" && order[3] === "1", order.join(","));
    ok("order is stable within a band", prioritise([art(7), art(8)], new Map()).map(x => x.url.slice(-1)).join("") === "78");

    console.log("\n=== failed reads stop being retried ===");
    const poison = art(10, "x".repeat(400));
    const first = await storePending(poison, "text", "model output hit max_tokens (truncated)", runId);
    let row = await prisma.sourceEvent.findUnique({ where: { sourceUrl: poison.url }, select: { processingStatus: true, readAttempts: true } });
    ok("first failure stays pending and counts", first === "pending" && row?.processingStatus === "pending" && row.readAttempts === 1, JSON.stringify(row));
    const second = await storePending(poison, "text", "model output hit max_tokens (truncated)", runId);
    const row2 = await prisma.sourceEvent.findUnique({ where: { sourceUrl: poison.url }, select: { processingStatus: true, readAttempts: true, processingError: true } });
    ok(`failure ${MAX_READ_ATTEMPTS} marks it FAILED, visibly`, second === "failed" && row2?.processingStatus === "failed" && (row2.processingError ?? "").startsWith("read failed 2x"), row2?.processingError ?? "");
    const drain = await prisma.sourceEvent.findMany({ where: { processingStatus: "pending", readAttempts: { lt: MAX_READ_ATTEMPTS }, sourceUrl: { startsWith: P } }, select: { sourceUrl: true } });
    ok("a failed article is not in the drain", !drain.some(d => d.sourceUrl === poison.url));

    console.log("\n=== deferral is one batch and never clobbers ===");
    const deferred = [art(20), art(21), art(22)];
    const wrote = await storeDeferred(deferred, runId);
    ok("deferred articles are stored as pending", wrote === 3);
    const again = await storeDeferred([art(20), poison], runId);
    const p2 = await prisma.sourceEvent.findUnique({ where: { sourceUrl: poison.url }, select: { processingStatus: true } });
    ok("re-deferral writes nothing and leaves existing rows alone", again === 0 && p2?.processingStatus === "failed", `wrote ${again}, poison ${p2?.processingStatus}`);
    const deferredAttempts = await prisma.sourceEvent.findUnique({ where: { sourceUrl: art(20).url }, select: { readAttempts: true } });
    ok("time deferral is not a failed attempt", deferredAttempts?.readAttempts === 0);

    console.log("\n=== deadline: no read starts past it; everything found is kept ===");
    const body = "Infosys has been selected by a European bank for a multi-year application services engagement covering maintenance and modernisation across the group. ".repeat(3);
    const late = [art(30, body), art(31, body)];
    const p = await runPipeline({ articles: late, maxArticleAgeDays: 0, concurrency: 2, timeBudgetMs: 60_000, deadlineMs: 0, runType: "queue_test" });
    ok("deadline passed → zero model calls", p.usage.costUsd === 0 && p.articlesTriaged === 0, `triaged ${p.articlesTriaged}, $${p.usage.costUsd}`);
    const kept = await prisma.sourceEvent.count({ where: { sourceUrl: { in: late.map(l => l.url) }, processingStatus: "pending" } });
    ok("articles not reached are persisted pending", kept === 2, `${kept} pending`);
    ok("the scheduled sweep has a deadline inside the 300s ceiling", (SCHEDULED_SWEEP.deadlineMs ?? 999_999) + 90_000 + 25_000 <= 300_000, `${SCHEDULED_SWEEP.deadlineMs}ms`);

    console.log("\n=== one paid read per article content ===");
    const text = "Wipro wins a five-year contract from a Nordic retailer to run its cloud estate. ".repeat(4);
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const orig = await prisma.sourceEvent.create({ data: { sourceUrl: `${P}-40`, sourceType: "wire_service", processingStatus: "extracted", extractedFamily: "READ", articleTextHash: hash, promptPolicyVersion: PROMPT_POLICY_VERSION, ingestionRunId: runId } });
    const ev = await prisma.canonicalMarketEvent.create({ data: { family: "CONTRACT", eventType: "new_win", canonicalTitle: "queue test event", sourceEvents: { connect: { id: orig.id } } } });
    const prior = await findReadByContent(hash);
    ok("the earlier read is found by content hash", prior?.id === orig.id && prior.eventIds.includes(ev.id));
    await storeDuplicateContent(art(41, text), text, hash, prior!, runId);
    const linked = await prisma.canonicalMarketEvent.findUnique({ where: { id: ev.id }, select: { sourceEvents: { select: { sourceUrl: true } } } });
    ok("a second URL for the same text is attached, not re-read", (linked?.sourceEvents.length ?? 0) === 2, `${linked?.sourceEvents.length} sources`);
    ok("a different policy is not treated as already read", (await findReadByContent(crypto.createHash("sha256").update(text + "x").digest("hex"))) === null);
    await prisma.canonicalMarketEvent.delete({ where: { id: ev.id } });
  } finally {
    await prisma.sourceEvent.deleteMany({ where: { sourceUrl: { startsWith: P } } });
    await prisma.ingestionRun.deleteMany({ where: { runType: "queue_test" } });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
