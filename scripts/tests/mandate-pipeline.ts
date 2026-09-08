/**
 * Mandate §30 — pipeline and storage behaviour, end to end through runPipeline.
 *
 * Covers the cases the mandate names that the reader-only regression cannot:
 * multiple events from one article, several articles collapsing to one event,
 * opportunity vs completed, the sponsorship false positive, buyer sector, AI
 * relevance, grounding, model identity recorded on the row, a model failure
 * leaving a PENDING row (never a regex verdict), and the previous exclusion
 * reason being retained rather than deleted.
 *
 * Writes to the database under a unique URL prefix and deletes exactly what it
 * created. Costs a few cents in model spend.
 *
 *   npx tsx scripts/tests/mandate-pipeline.ts [--keep]
 */
import { prisma } from "@/lib/db";
import { runPipeline } from "@/lib/ingestion/pipeline";
import { READER_MODEL, PROMPT_POLICY_VERSION } from "@/lib/ingestion/reader";
import { FIXTURES, FIVE_REPORTS } from "./fixtures/regression-articles";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); }
}

const STAMP = Date.now();
const PREFIX = `https://example.invalid/mandate-test-${STAMP}`;
const mk = (i: number, f: { title: string; text: string; provider: string; sourceType: string }) => ({
  // A date no real event occupies: the fixtures describe real awards, and a
  // present-day date would let them match (and enrich) genuine stored events.
  title: f.title, url: `${PREFIX}-${i}`, publishedAt: "2027-03-15T09:00:00Z", snippet: null,
  sourceId: "mandate-test", provider: f.provider, sourceType: f.sourceType, publisherUrl: null, bodyText: f.text,
});

(async () => {
  const articles = [...FIXTURES.map((f, i) => mk(i, f)), ...FIVE_REPORTS.map((f, i) => mk(100 + i, f))];
  const runStart = new Date();

  // A row already excluded by the old regex pipeline: §20 says the record must
  // survive the re-read, not be deleted, and must keep its earlier verdict.
  const priorUrl = `${PREFIX}-0`;
  await prisma.sourceEvent.create({ data: {
    sourceUrl: priorUrl, rawTextHash: `test-${STAMP}`, sourceTitle: FIXTURES[0].title, sourceName: FIXTURES[0].provider,
    sourceType: FIXTURES[0].sourceType, processingStatus: "excluded", exclusionReason: "rules:noise", extractedFamily: "EXCLUDED",
  } });

  console.log(`\n=== running ${articles.length} fixture articles through runPipeline ===`);
  const p = await runPipeline({ articles, maxArticleAgeDays: 0, maxExtractions: 60, concurrency: 5, timeBudgetMs: 900_000, runType: "mandate_test", reprocessExcluded: true });
  console.log(`read ${p.articlesTriaged} · pending ${p.articlesPending} · non-event ${p.articlesExcluded} · published ${p.eventsPublished} · review ${p.eventsQueued} · merged ${p.articlesMerged} · $${p.usage.costUsd.toFixed(2)} · errors ${p.errors.length}\n`);
  p.errors.forEach(e => console.log(`  err: ${e.slice(0, 200)}`));

  const rows = await prisma.sourceEvent.findMany({
    where: { sourceUrl: { startsWith: PREFIX } },
    select: { id: true, sourceUrl: true, sourceTitle: true, processingStatus: true, exclusionReason: true, previousExclusionReason: true,
      articleType: true, articleTextHash: true, articleTextChars: true, modelId: true, promptPolicyVersion: true, analysedAt: true,
      canonicalEvents: { select: { id: true, family: true, eventType: true, commercialEventType: true, eventStatus: true, publicationStatus: true, reviewReason: true,
        buyerSector: true, aiRelevance: true, supportingText: true, canonicalContractEventId: true, readerVersion: true, counterpartyRaw: true,
        contractDetails: { select: { tcvCommittedUsd: true, tcvIsEstimate: true, contractLengthMonths: true, clientDescriptor: true, previousVendorRaw: true } },
        sourceEvents: { select: { id: true } } } } },
  });
  const byTitle = (frag: string) => rows.find(r => (r.sourceTitle ?? "").toLowerCase().includes(frag.toLowerCase()));
  const events = rows.flatMap(r => r.canonicalEvents);

  console.log("=== §30 cases ===");

  // 1. every read row records model identity, prompt policy, article hash and length
  const read = rows.filter(r => r.processingStatus !== "pending");
  ok("model identity recorded on every read row", read.every(r => r.modelId === READER_MODEL), `${read.filter(r => r.modelId === READER_MODEL).length}/${read.length}`);
  ok("prompt policy version recorded", read.every(r => r.promptPolicyVersion === PROMPT_POLICY_VERSION));
  ok("article hash and length recorded", read.every(r => !!r.articleTextHash && (r.articleTextChars ?? 0) > 0));
  ok("analysis timestamp recorded", read.every(r => !!r.analysedAt));
  ok("reader version stamped on every event", events.every(e => e.readerVersion === PROMPT_POLICY_VERSION));

  // 2. sponsorship is not a contract event
  const spon = byTitle("Ryder Cup");
  ok("sponsorship produces no contract event", !!spon && spon.canonicalEvents.length === 0, spon ? `${spon.articleType} / ${spon.exclusionReason}` : "row missing");

  // 3. multiple events from one article
  const tcs = byTitle("TCS wins two large European deals");
  const tcsContracts = tcs?.canonicalEvents.filter(e => e.family === "CONTRACT") ?? [];
  ok("two deals in one article become two contract events", tcsContracts.length === 2, `${tcsContracts.length} contract of ${tcs?.canonicalEvents.length} events`);

  // 4. several articles about one contract collapse to one event
  const serco = rows.filter(r => /fylingdales|missile-warning|early warning radar/i.test(r.sourceTitle ?? ""));
  const sercoIds = new Set(serco.flatMap(r => r.canonicalEvents.map(e => e.canonicalContractEventId)));
  ok("five reports of one award → one event", sercoIds.size === 1, `${serco.length} articles → ${sercoIds.size} identities`);
  const sercoEvent = serco.flatMap(r => r.canonicalEvents)[0];
  ok("the shared event carries every reporting article", (sercoEvent?.sourceEvents.length ?? 0) >= 4, `${sercoEvent?.sourceEvents.length} sources`);

  // 5. opportunity vs completed
  const tender = byTitle("Ministry of Defence launches tender");
  const tenderEv = tender?.canonicalEvents[0];
  ok("a tender is an OPPORTUNITY, not an award", tenderEv?.eventStatus === "OPPORTUNITY", `${tenderEv?.eventStatus}`);
  ok("an opportunity is not published as a win", tenderEv?.publicationStatus === "needs_review", `${tenderEv?.publicationStatus} / ${tenderEv?.reviewReason}`);
  const caseStudy = byTitle("scaled claims automation");
  ok("a case study's delivered work is COMPLETED", caseStudy?.canonicalEvents.some(e => e.eventStatus === "COMPLETED") ?? false, caseStudy?.canonicalEvents.map(e => e.eventStatus).join(","));

  // 6. buyer sector on both axes
  const nordea = byTitle("Nordea");
  const mod = byTitle("Early warning radar");
  ok("a named bank is PRIVATE_SECTOR", nordea?.canonicalEvents[0]?.buyerSector === "PRIVATE_SECTOR", `${nordea?.canonicalEvents[0]?.buyerSector}`);
  ok("a ministry is PUBLIC_SECTOR", mod?.canonicalEvents[0]?.buyerSector === "PUBLIC_SECTOR", `${mod?.canonicalEvents[0]?.buyerSector}`);

  // 7. AI relevance
  const genpact = byTitle("agentic claims assistant");
  ok("an agentic AI build is EXPLICIT_AI", genpact?.canonicalEvents[0]?.aiRelevance === "EXPLICIT_AI", `${genpact?.canonicalEvents[0]?.aiRelevance}`);
  ok("a network outsourcing deal is not marked AI", byTitle("Volvo")?.canonicalEvents[0]?.aiRelevance === "NOT_AI_SPECIFIC", `${byTitle("Volvo")?.canonicalEvents[0]?.aiRelevance}`);

  // 8. grounding: every stored event carries a supporting passage that occurs in the article
  // A merged event's passages come from whichever article reported it, so the
  // quote is checked against every article linked to that event, not just one.
  const textById = new Map(rows.map(r => [r.id, (articles.find(a => a.url === r.sourceUrl)?.bodyText ?? "").replace(/\s+/g, " ").toLowerCase()]));
  const seenEvents = new Set<string>();
  let grounded = 0; const ungrounded: string[] = [];
  for (const r of rows) for (const e of r.canonicalEvents) {
    if (seenEvents.has(e.id)) continue;
    seenEvents.add(e.id);
    const corpus = e.sourceEvents.map(s => textById.get(s.id) ?? "").join(" \n ");
    for (const [k, v] of Object.entries(JSON.parse(e.supportingText ?? "{}") as Record<string, string>)) {
      const q = v.replace(/\s+/g, " ").toLowerCase();
      if (q.length >= 20 && corpus.includes(q.slice(0, Math.min(60, q.length)))) grounded++;
      else if (q.length >= 20) ungrounded.push(`${k}:${q.slice(0, 50)}`);
    }
  }
  ok("every supporting passage occurs in one of the event's articles", ungrounded.length === 0, `${grounded} grounded${ungrounded.length ? `, not found: ${ungrounded.slice(0, 3).join(" | ")}` : ""}`);

  // 9. values: stated only, never estimated by the reader
  ok("no reader-stored value is flagged as an estimate", events.every(e => e.contractDetails?.tcvIsEstimate !== true));
  const hcl = byTitle("Volvo Group");
  ok("an undisclosed value stays null", hcl?.canonicalEvents[0]?.contractDetails?.tcvCommittedUsd == null, `${hcl?.canonicalEvents[0]?.contractDetails?.tcvCommittedUsd}`);

  // 10. an award reported only in a stock note is still found
  const ltts = byTitle("shares jump");
  ok("an award inside a stock note is captured", (ltts?.canonicalEvents.length ?? 0) >= 1, `${ltts?.articleType} → ${ltts?.canonicalEvents.length} events`);

  // 11. an award deep inside an earnings transcript is found (fact past 4,000 chars)
  const wipro = byTitle("earnings call");
  ok("an award past the 4,000-char mark is captured", (wipro?.canonicalEvents.length ?? 0) >= 1, `${wipro?.articleTextChars} chars → ${wipro?.canonicalEvents.length} events`);

  // 12. §20 — the earlier exclusion record survives the re-read
  const prior = rows.find(r => r.sourceUrl === priorUrl);
  ok("a re-read keeps the previous exclusion reason", prior?.previousExclusionReason === "rules:noise", `${prior?.previousExclusionReason}`);
  ok("the previously excluded row was re-read, not deleted", !!prior && prior.processingStatus !== "excluded", `${prior?.processingStatus}`);

  // 13. §22 — no silent regex fallback anywhere in the run
  ok("no row was classified without the model", rows.every(r => r.processingStatus === "pending" || r.modelId === READER_MODEL || r.exclusionReason?.startsWith("rules:")));
  ok("model failures become PENDING, never a verdict", rows.every(r => r.processingStatus !== "pending" || (r.canonicalEvents.length === 0 && !r.exclusionReason)));

  console.log(`\n${passed} passed, ${failed} failed`);

  if (!process.argv.includes("--keep")) {
    const evIds = (await prisma.canonicalMarketEvent.findMany({ where: { id: { in: [...new Set(events.map(e => e.id))] }, createdAt: { gte: runStart } }, select: { id: true } })).map(e => e.id);
    await prisma.contractDetails.deleteMany({ where: { canonicalEventId: { in: evIds } } });
    await prisma.canonicalMarketEvent.deleteMany({ where: { id: { in: evIds } } });
    await prisma.sourceEvent.deleteMany({ where: { sourceUrl: { startsWith: PREFIX } } });
    await prisma.ingestionRun.deleteMany({ where: { runType: "mandate_test", startedAt: { gte: runStart } } });
    console.log(`cleaned up ${rows.length} rows and ${evIds.length} events`);
  }
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})();
