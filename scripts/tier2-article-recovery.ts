/**
 * Tier 2 article recovery (AI Delivery Mandate §3–§5).
 *
 * Recovers ARTICLE TEXT — no model calls, no semantics. Resolves Google News
 * redirects to publisher URLs and fetches article bodies with the existing
 * lawful fetch path (retrieveArticle), then records what was actually obtained
 * so the next run never re-attempts a URL that is permanently dead.
 *
 * Target population, in priority order (§3) — only rows behind a canonical
 * event the reader has not yet read, never a structured procurement notice:
 *   1 unresolved Google News redirect (publisherUrl null)
 *   2 publisher URL known, body absent (< 800 chars)
 *   3 body present but incomplete (200-799 chars)
 * Rows with no URL at all are unrecoverable and are not attempted.
 *
 * Never replaces good text with a failed fetch: a shorter or empty result is
 * recorded as state and the existing body is kept (last-known-good, §5).
 *
 *   npx tsx --env-file=.env --env-file=.env.local scripts/tier2-article-recovery.ts \
 *     [--apply] [--limit N] [--concurrency N] [--retry-failed]
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { retrieveArticle } from "@/lib/ingestion/article-text";

const MAX_CHARS = 60_000;
const FULL_TEXT_MIN = 1500, ARTICLE_GRADE_MIN = 800, SNIPPET_MIN = 200;
const MAX_ATTEMPTS = 3;
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const apply = process.argv.includes("--apply");
const retryFailed = process.argv.includes("--retry-failed");
const LIMIT = Number(arg("--limit", "0"));
const CONCURRENCY = Number(arg("--concurrency", "3"));
/** Delay before each request. The source rate-limits; pacing is what makes a long pass survivable. */
const PACE_MS = Number(arg("--pace-ms", "400"));
const OUT = arg("--out", "_scratch/tier2-recovery.json");

process.on("unhandledRejection", e => console.error("unhandled (continuing):", String(e).slice(0, 160)));

const classify = (len: number) =>
  len >= FULL_TEXT_MIN ? "FULL_TEXT" : len >= ARTICLE_GRADE_MIN ? "PARTIAL_ARTICLE"
  : len >= SNIPPET_MIN ? "SNIPPET_ONLY" : "UNREADABLE";

interface Cand { sid: string; url: string; pub: string | null; curChars: number; priority: number; isGnews: boolean; attempts: number }

async function candidates(): Promise<Cand[]> {
  // Attempted-and-dead rows are excluded unless --retry-failed: BLOCKED and
  // INVALID are terminal, FETCH_FAILED is retried up to MAX_ATTEMPTS.
  const skip = retryFailed
    ? `and coalesce(s."redirectState",'') not in ('BLOCKED','INVALID')`
    : `and (s."bodyState" is null or s."bodyState" in ('SNIPPET_ONLY','UNREADABLE'))
       and coalesce(s."redirectState",'') not in ('BLOCKED','INVALID','FAILED')
       and s."bodyAttempts" < ${MAX_ATTEMPTS}`;
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    select distinct on (s.id) s.id sid, s."sourceUrl" url, s."publisherUrl" pub,
      coalesce(length(s."rawText"),0) curchars, s."bodyAttempts" attempts,
      (s."sourceUrl" like '%news.google.com%') isgnews,
      case
        when s."sourceUrl" like '%news.google.com%' and s."publisherUrl" is null then 1
        when s."publisherUrl" is not null and coalesce(length(s."rawText"),0) < ${ARTICLE_GRADE_MIN} then 2
        else 3 end priority
    from "SourceEvent" s
    join "_CanonicalMarketEventToSourceEvent" j on j."B" = s.id
    join "CanonicalMarketEvent" c on c.id = j."A"
    where c."readerVersion" is null
      and s."sourceType" not in ('procurement_notice','trusted_structured_dataset','structured_primary_source')
      and s."sourceUrl" is not null
      and coalesce(length(s."rawText"),0) < ${ARTICLE_GRADE_MIN}
      ${skip}
    order by s.id`);
  const out = rows.map(r => ({ sid: String(r.sid), url: String(r.url), pub: (r.pub as string) ?? null,
    curChars: Number(r.curchars), priority: Number(r.priority), isGnews: Boolean(r.isgnews), attempts: Number(r.attempts) }));
  out.sort((a, b) => a.priority - b.priority || b.curChars - a.curChars);
  return out;
}

(async () => {
  const t0 = Date.now();
  const all = await candidates();
  const work = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  const s = { candidates: all.length, attempted: 0,
    redirect: { RESOLVED: 0, ALREADY_RESOLVED: 0, FAILED: 0, NOT_APPLICABLE: 0 } as Record<string, number>,
    body: { FULL_TEXT: 0, PARTIAL_ARTICLE: 0, SNIPPET_ONLY: 0, UNREADABLE: 0, FETCH_FAILED: 0 } as Record<string, number>,
    improved: 0, keptExisting: 0, byPriority: {} as Record<string, number>, errors: [] as string[] };
  for (const c of work) s.byPriority[`p${c.priority}`] = (s.byPriority[`p${c.priority}`] ?? 0) + 1;
  console.log(`candidates=${all.length} work=${work.length} apply=${apply} concurrency=${CONCURRENCY} priorities=${JSON.stringify(s.byPriority)}`);

  // Google News rate-limits redirect resolution. Before the limiter engages the
  // failure rate is ~0; once it engages EVERY request fails. Marking those rows
  // FETCH_FAILED would exclude them from all future runs on a false premise, so
  // a run of consecutive failures aborts the pass instead of recording state.
  const THROTTLE_ABORT = 25;
  let consecutiveFailures = 0, aborted = false;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= work.length) return;
      if (aborted) return;
      const c = work[i];
      // polite pacing: the limiter engaged at ~1,400 requests at concurrency 6
      if (PACE_MS > 0) await new Promise(r => setTimeout(r, PACE_MS));
      s.attempted++;
      let publisherUrl: string | null = c.pub, text = "", failed = "";
      try {
        const got = await retrieveArticle(c.pub ?? c.url, MAX_CHARS);
        publisherUrl = got.publisherUrl ?? c.pub;
        text = got.article?.text ?? "";
      } catch (e) { failed = String(e).slice(0, 140); }

      const rState = !c.isGnews ? "NOT_APPLICABLE"
        : c.pub ? "ALREADY_RESOLVED"
        : publisherUrl ? "RESOLVED" : "FAILED";
      s.redirect[rState] = (s.redirect[rState] ?? 0) + 1;

      const bState = failed || !publisherUrl ? "FETCH_FAILED" : classify(text.length);
      s.body[bState] = (s.body[bState] ?? 0) + 1;
      if (bState === "FETCH_FAILED") {
        if (++consecutiveFailures >= THROTTLE_ABORT) {
          aborted = true;
          console.log(`\nABORT: ${THROTTLE_ABORT} consecutive fetch failures — treating as rate limiting, not dead URLs. No state written for this burst.`);
          return;
        }
        continue; // do not persist state for a failure that may be throttling
      }
      consecutiveFailures = 0;

      // last-known-good: never let a worse fetch overwrite better stored text
      const better = text.length > c.curChars;
      if (better) s.improved++; else s.keptExisting++;
      if (failed && s.errors.length < 25) s.errors.push(`${c.sid}: ${failed}`);

      if (apply) {
        const hash = better ? crypto.createHash("sha256").update(text).digest("hex") : null;
        await prisma.$executeRawUnsafe(`
          update "SourceEvent" set
            "publisherUrl" = coalesce($2, "publisherUrl"),
            "redirectState" = $3, "redirectAttemptedAt" = now(),
            "bodyState" = $4, "bodyAttemptedAt" = now(), "bodyAttempts" = "bodyAttempts" + 1,
            "bodyChars" = $5,
            "rawText" = case when $6::boolean then $7 else "rawText" end,
            "rawTextHash" = case when $6::boolean then $8 else "rawTextHash" end
          where id = $1`, c.sid, publisherUrl, rState, bState, text.length || null, better, better ? text : null, hash)
          .catch(e => { if (s.errors.length < 30) s.errors.push(`write ${c.sid}: ${String(e).slice(0, 90)}`); });
      }
      if ((s.attempted % 50) === 0) console.log(`  ${s.attempted}/${work.length} resolved=${s.redirect.RESOLVED} full=${s.body.FULL_TEXT} partial=${s.body.PARTIAL_ARTICLE} failed=${s.body.FETCH_FAILED} ${Math.round((Date.now()-t0)/1000)}s`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
  const result = { ...s, aborted, runtimeS: Math.round((Date.now() - t0) / 1000), apply, finishedAt: new Date().toISOString() };
  fs.mkdirSync("_scratch", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log("\nDONE " + JSON.stringify(result));
  await prisma.$disconnect();
})();
