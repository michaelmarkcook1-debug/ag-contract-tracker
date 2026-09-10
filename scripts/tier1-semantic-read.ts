/**
 * Tier 1 semantic read (AI Delivery Mandate — ContractTracker).
 *
 * Reads the ENTIRE article for canonical events that already hold article-grade
 * text, and enriches those events in place. It never fetches a publisher body,
 * never creates a canonical event, and never touches a snippet-only record —
 * this is a measured validation pass, not a backfill.
 *
 * Article-grade is declared here, once, and applied without exception:
 *   FULL_TEXT             >= 1500 chars
 *   ARTICLE_GRADE_PARTIAL  800-1499 chars
 *   SNIPPET_ONLY          <  800 chars   (excluded)
 *
 * Structured sources (procurement notices, structured datasets) are excluded as
 * article sources: they are forms, not prose, and reading a form with an article
 * reader tests nothing. They are counted and reported as a separate pool.
 *
 * Idempotency (§4): a source row whose stored articleTextHash matches the text
 * we are about to send, under the SAME modelId and promptPolicyVersion, is
 * skipped without a model call. Re-running costs nothing for unchanged work.
 *
 * One article can report several commercial events (§5). Tier 1 enriches the
 * ONE canonical event the row belongs to, choosing the reported event whose
 * provider matches it; every additional event is counted and logged but not
 * stored, so canonical identity and the existing dedup are untouched.
 *
 *   npx tsx scripts/tier1-semantic-read.ts [--apply] [--limit N] [--concurrency N]
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readArticle, READER_MODEL, PROMPT_POLICY_VERSION, canonicalContractEventId, type GroundedEvent } from "@/lib/ingestion/reader";
import { enrichExisting } from "@/lib/ingestion/store";
import { matchTrackedVendor } from "@/lib/ingestion/sources";

const FULL_TEXT_MIN = 1500;
const ARTICLE_GRADE_MIN = 800;
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const LIMIT = Number(arg("--limit", "0"));
const CONCURRENCY = Number(arg("--concurrency", "5"));
const OUT = arg("--out", "_scratch/tier1-result.json");

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 180)));

interface Row { eventId: string; family: string; sourceId: string; title: string; text: string; provider: string | null; sourceType: string; publishedAt: string | null; grade: string; entityName: string | null; vendorRaw: string | null }

async function candidates(): Promise<Row[]> {
  // longest linked article per unread canonical event
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    with best as (
      select c.id eid, c.family, s.id sid, s."rawText" txt, s."sourceTitle" st, s."sourceName" sn,
             s."sourceType" stype, s."publicationDate" pd, s."articleTextHash" prevhash,
             s."modelId" prevmodel, s."promptPolicyVersion" prevpolicy,
             e."canonicalName" ename, d."vendorRaw" vraw,
             row_number() over (partition by c.id order by length(s."rawText") desc) rn
      from "CanonicalMarketEvent" c
      join "_CanonicalMarketEventToSourceEvent" j on j."A" = c.id
      join "SourceEvent" s on s.id = j."B"
      left join "Entity" e on e.id = c."primaryEntityId"
      left join "ContractDetails" d on d."canonicalEventId" = c.id
      where c."readerVersion" is null and s."rawText" is not null and length(s."rawText") >= ${ARTICLE_GRADE_MIN}
        and s."sourceType" not in ('procurement_notice','trusted_structured_dataset','structured_primary_source'))
    select * from best where rn = 1 order by length(txt) desc`);
  return rows.map(r => ({
    eventId: String(r.eid), family: String(r.family), sourceId: String(r.sid),
    text: String(r.txt), title: String(r.st ?? ""), provider: (r.sn as string) ?? null,
    sourceType: String(r.stype ?? "unknown"),
    publishedAt: r.pd ? new Date(r.pd as string).toISOString() : null,
    grade: String(r.txt).length >= FULL_TEXT_MIN ? "FULL_TEXT" : "ARTICLE_GRADE_PARTIAL",
    entityName: (r.ename as string) ?? null, vendorRaw: (r.vraw as string) ?? null,
    // idempotency inputs
    ...( { prevhash: r.prevhash, prevmodel: r.prevmodel, prevpolicy: r.prevpolicy } as object),
  })) as Row[];
}

/** Pick the reported event that belongs to THIS canonical event (§5). */
function pick(evs: GroundedEvent[], row: Row): GroundedEvent | null {
  if (evs.length === 0) return null;
  const want = (row.entityName ?? row.vendorRaw ?? "").toLowerCase().trim();
  if (want) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
    const exact = evs.find(e => e.provider && norm(e.provider) === norm(want));
    if (exact) return exact;
    const partial = evs.find(e => e.provider && (norm(e.provider).includes(norm(want)) || norm(want).includes(norm(e.provider!))));
    if (partial) return partial;
    const tracked = evs.find(e => e.provider && matchTrackedVendor(e.provider) && matchTrackedVendor(e.provider) === matchTrackedVendor(want));
    if (tracked) return tracked;
  }
  // family agreement, else the first with a provider
  return evs.find(e => e.family === row.family && e.provider) ?? evs.find(e => e.provider) ?? null;
}

(async () => {
  const t0 = Date.now();
  const cands = await candidates();
  // One article can be the best text for several canonical events (157 of them
  // are, in this estate). Read the ARTICLE once and apply the reading to every
  // event that cites it — reading per-event paid twice for 219 articles.
  // Group by the CONTENT hash, not the source row: the same article is often
  // stored twice (a Google News URL and its resolved publisher URL), and keying
  // on the row id paid twice for identical text. §7 is one content hash + one
  // policy = one paid read.
  const groups = new Map<string, Row[]>();
  for (const c of cands) {
    const key = crypto.createHash("sha256").update(c.text.replace(/\r/g, "").trim()).digest("hex");
    const g = groups.get(key); g ? g.push(c) : groups.set(key, [c]);
  }
  const allGroups = [...groups.values()];
  const work = LIMIT > 0 ? allGroups.slice(0, LIMIT) : allGroups;
  const stat = { candidates: cands.length, distinctArticles: 0, duplicateReadsAvoided: 0, attempted: 0, read: 0, skippedIdempotent: 0, enriched: 0, noEventFound: 0,
    failed: 0, extraEventsSeen: 0, multiEventArticles: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    byGrade: {} as Record<string, number>, errors: [] as string[] };
  stat.distinctArticles = allGroups.length; stat.duplicateReadsAvoided = cands.length - allGroups.length;
  for (const g of work) stat.byGrade[g[0].grade] = (stat.byGrade[g[0].grade] ?? 0) + 1;
  console.log(`candidates=${cands.length} distinctArticles=${allGroups.length} (duplicate reads avoided ${stat.duplicateReadsAvoided}) FULL_TEXT=${stat.byGrade.FULL_TEXT ?? 0} PARTIAL=${stat.byGrade.ARTICLE_GRADE_PARTIAL ?? 0} work=${work.length} apply=${apply} concurrency=${CONCURRENCY}`);

  const detail: Array<Record<string, unknown>> = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= work.length) return;
      const members = work[i];
      const row = members[0] as Row & { prevhash?: string; prevmodel?: string; prevpolicy?: string };
      const hash = crypto.createHash("sha256").update(row.text.replace(/\r/g, "").trim()).digest("hex");
      if (row.prevhash === hash && row.prevmodel === READER_MODEL && row.prevpolicy === PROMPT_POLICY_VERSION) {
        stat.skippedIdempotent++; continue;
      }
      stat.attempted++;
      const out = await readArticle({ title: row.title, text: row.text, provider: row.provider, sourceType: row.sourceType, publishedAt: row.publishedAt });
      if (!out.ok) {
        stat.failed++;
        if (stat.errors.length < 25) stat.errors.push(`${row.eventId}: ${out.error.slice(0, 120)}`);
        stat.inputTokens += out.usage.inputTokens; stat.outputTokens += out.usage.outputTokens; stat.costUsd += out.usage.costUsd;
        if (apply) await prisma.sourceEvent.update({ where: { id: row.sourceId }, data: { processingError: out.error.slice(0, 300) } }).catch(() => {});
        continue;
      }
      stat.read++;
      const r = out.reading;
      stat.inputTokens += r.usage.inputTokens; stat.outputTokens += r.usage.outputTokens; stat.costUsd += r.usage.costUsd;
      if (r.events.length > 1) { stat.multiEventArticles++; stat.extraEventsSeen += r.events.length - 1; }
      for (const m of members) {
        const ev = pick(r.events, m);
        detail.push({ eventId: m.eventId, sourceId: m.sourceId, grade: m.grade, chars: m.text.length,
          segments: r.segments, articleType: r.articleType, eventsReported: r.events.length, sharedArticle: members.length > 1,
          picked: ev ? { type: ev.commercialEventType, status: ev.eventStatus, sector: ev.buyerSector, ai: ev.aiRelevance,
            provider: ev.provider, buyer: ev.buyer, pricingModel: ev.pricingModel, outcomePricing: ev.outcomePricing,
            feeAtRisk: ev.feeAtRisk, incumbent: ev.incumbent ?? ev.displacedProvider, scope: ev.serviceScope } : null });
        if (!ev) { stat.noEventFound++; continue; }
        if (apply) {
          const first = ev.announcementDate ? new Date(ev.announcementDate) : new Date();
          const idKey = ev.provider ? canonicalContractEventId(ev.provider, ev.buyer, ev.buyerDescriptor, ev.commercialEventType, first) : undefined;
          await enrichExisting(m.eventId, ev, idKey).catch(e => { stat.errors.push(`enrich ${m.eventId}: ${String(e).slice(0, 100)}`); });
          stat.enriched++;
        }
      }
      if (apply) {
        await prisma.sourceEvent.update({ where: { id: row.sourceId }, data: {
          articleType: r.articleType, articleTextHash: r.textHash, articleTextChars: r.textChars,
          modelId: r.modelId, promptPolicyVersion: r.promptPolicyVersion, analysedAt: new Date(r.analysedAt), processingError: null,
        } }).catch(() => {});
      }
      if ((stat.attempted % 25) === 0) console.log(`  ${stat.attempted}/${work.length} read=${stat.read} enriched=${stat.enriched} failed=${stat.failed} $${stat.costUsd.toFixed(2)} ${Math.round((Date.now()-t0)/1000)}s`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  const runtimeS = Math.round((Date.now() - t0) / 1000);
  const result = { ...stat, runtimeS, apply, model: READER_MODEL, policy: PROMPT_POLICY_VERSION, finishedAt: new Date().toISOString() };
  fs.mkdirSync("_scratch", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ result, detail }, null, 1));
  console.log("\nDONE " + JSON.stringify(result));
  await prisma.$disconnect();
})();
