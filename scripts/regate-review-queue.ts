/**
 * Re-gate the review queue with the evidence gate (src/lib/ingestion/gate.ts).
 *
 * The queue was filled by a confidence threshold that measured extraction
 * completeness, not whether the event was real. This applies the same rules
 * the pipeline now applies at ingestion, to every needs_review event:
 *
 *   publish — passes the gate (vendor resolved, counterparty named, event type
 *             valid for the family, award language present for contracts)
 *   archive — announced more than ARCHIVE_AFTER_YEARS ago AND no counterparty:
 *             excluded_noise with reason "archived:stale_no_counterparty"
 *   keep    — stays in needs_review; reviewReason is updated to say why
 *
 * Every write is logged as a ReviewAction (regate_publish / regate_archive /
 * regate_keep) with the previous status, so it can be reversed.
 *
 * Before gating, three gaps the old pipeline left are repaired, because they
 * are not evidence against the event, just fields it never filled:
 *   - one triage read (Haiku) over the title, summary and any stored text gives
 *     the event STATUS (announced / opportunity / terminated / disputed …) the
 *     gate now judges on, and the counterparty where a contract / partnership
 *     / M&A row has none; results are cached in REGATE_CACHE so --apply does
 *     not pay again;
 *   - no primary entity although the title names a tracked vendor → resolved;
 *   - event type outside the family's set → normalised to the family default.
 *
 * Dry run by default — prints the plan. Run with --apply to write.
 */
import fs from "fs";
import { prisma } from "../src/lib/db";
import { decidePublication, COUNTERPARTY_FAMILIES } from "../src/lib/ingestion/gate";
import { isValidEventType, defaultEventType, triageArticle, EMPTY_USAGE, ExtractionResult } from "../src/lib/ingestion/classifier";
import { titleCounterparty } from "../src/lib/ingestion/dedup";
import { matchTrackedVendor } from "../src/lib/ingestion/sources";
import type { RawArticle } from "../src/lib/ingestion/crawler";

const ARCHIVE_AFTER_YEARS = 2;
const CACHE_PATH = process.env.REGATE_CACHE ?? "/tmp/regate-enrichment.json";
type Outcome = "publish" | "archive" | "keep";
type Enrichment = { clientRaw: string | null; vendorRaw: string | null; eventStatus?: string | null; articleType?: string | null };

async function resolveEntityId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const e = await prisma.entity.findFirst({
    where: { OR: [{ canonicalName: { equals: name } }, { aliases: { some: { alias: { equals: name } } } }] },
    select: { id: true },
  });
  return e?.id ?? null;
}

// A dropped Neon WebSocket surfaces as an unhandled ErrorEvent outside any
// awaited chain and would kill the whole run; log it and carry on — the
// pipeline retries nothing, but the next batch reconnects.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection (continuing):", String(reason).slice(0, 200));
});

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");

  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "needs_review" },
    select: {
      id: true, family: true, eventType: true, canonicalTitle: true, announcementDate: true, confidenceScore: true,
      primaryEntityId: true, counterpartyRaw: true, analystInsight: true, reviewReason: true,
      primaryEntity: { select: { canonicalName: true } },
      contractDetails: { select: { clientRaw: true, vendorRaw: true, scopeSummary: true } },
      maDetails: { select: { targetRaw: true } },
      partnershipDetails: { select: { entityBRaw: true } },
      sourceEvents: { select: { sourceTitle: true, rawText: true, sourceType: true }, take: 1 },
    },
  });
  console.log(`needs_review: ${rows.length}`);

  const cutoff = Date.now() - ARCHIVE_AFTER_YEARS * 365.25 * 86_400_000;
  const tally: Record<Outcome, number> = { publish: 0, archive: 0, keep: 0 };
  const reasonCounts = new Map<string, number>();
  const samples: Record<Outcome, string[]> = { publish: [], archive: [], keep: [] };
  const plan: { id: string; outcome: Outcome; reason: string | null; title: string;
                fix: { counterpartyRaw?: string; primaryEntityId?: string; eventType?: string } }[] = [];
  const repairs = { counterparty: 0, entity: 0, eventType: 0 };

  // ── enrichment (cached) ───────────────────────────────────────────────────
  const cache: Record<string, Enrichment> = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};
  const needEnrich = rows.filter(e => !cache[e.id] || cache[e.id].eventStatus === undefined);
  if (needEnrich.length && process.env.ANTHROPIC_API_KEY) {
    console.log(`enriching counterparties for ${needEnrich.length} rows via triage (cached to ${CACHE_PATH})…`);
    let cursor = 0; let spent = 0;
    await Promise.all(Array.from({ length: 5 }, async () => {
      while (cursor < needEnrich.length) {
        const e = needEnrich[cursor++]; const se = e.sourceEvents[0];
        const body = se?.rawText && se.rawText.length > 300 && !se.rawText.trimStart().startsWith("<a ") ? se.rawText.slice(0, 4000) : null;
        const t = await triageArticle({
          title: se?.sourceTitle ?? e.canonicalTitle, url: "", publishedAt: e.announcementDate?.toISOString() ?? null,
          snippet: [e.canonicalTitle, e.contractDetails?.scopeSummary, e.analystInsight].filter(Boolean).join(" ").slice(0, 1200) || null,
          sourceId: "", provider: e.primaryEntity?.canonicalName ?? "", sourceType: se?.sourceType ?? "wire_service", bodyText: body,
        });
        spent += t?.usage.costUsd ?? 0;
        cache[e.id] = { clientRaw: t?.clientRaw ?? cache[e.id]?.clientRaw ?? null, vendorRaw: t?.vendorRaw ?? cache[e.id]?.vendorRaw ?? null, eventStatus: t?.eventStatus ?? null, articleType: t?.articleType ?? null };
      }
    }));
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
    console.log(`  enrichment spend: $${spent.toFixed(3)}`);
  } else if (needEnrich.length) {
    console.log(`(${needEnrich.length} rows lack a counterparty; set ANTHROPIC_API_KEY to enrich them)`);
  }

  for (const e of rows) {
    const fix: { counterpartyRaw?: string; primaryEntityId?: string; eventType?: string } = {};
    let counterparty = e.counterpartyRaw ?? e.contractDetails?.clientRaw ?? e.maDetails?.targetRaw
      ?? e.partnershipDetails?.entityBRaw ?? titleCounterparty(e.canonicalTitle);
    if (!counterparty && cache[e.id]?.clientRaw) { counterparty = cache[e.id].clientRaw; fix.counterpartyRaw = counterparty!; repairs.counterparty++; }
    let vendorName = e.primaryEntity?.canonicalName ?? e.contractDetails?.vendorRaw ?? cache[e.id]?.vendorRaw ?? null;
    let vendorId = e.primaryEntityId;
    if (!vendorId) {
      vendorId = await resolveEntityId(vendorName ?? matchTrackedVendor(e.canonicalTitle));
      if (vendorId) { fix.primaryEntityId = vendorId; repairs.entity++; }
    }
    let eventType = e.eventType;
    if (!isValidEventType(e.family, eventType)) {
      eventType = defaultEventType(e.family, `${e.canonicalTitle} ${e.sourceEvents[0]?.sourceTitle ?? ""}`);
      fix.eventType = eventType; repairs.eventType++;
    }
    const se = e.sourceEvents[0];
    // Google News rows stored the redirect link as their "snippet"; that is not evidence.
    const body = se?.rawText && se.rawText.length > 200 && !se.rawText.trimStart().startsWith("<a ") ? se.rawText : null;

    const result: ExtractionResult = {
      family: e.family, eventType, canonicalTitle: e.canonicalTitle,
      vendorRaw: vendorName, clientRaw: counterparty,
      tcvUsd: null, tcvIsEstimate: false, contractLengthMonths: null, primaryMacroServiceLine: null,
      geography: [], industry: null, confidenceScore: e.confidenceScore, extractionMethod: "llm",
      summary: e.contractDetails?.scopeSummary ?? e.analystInsight ?? null, analystInsight: null, missingCritical: [],
      eventTypeValid: isValidEventType(e.family, eventType), exclusionReason: null, usage: EMPTY_USAGE,
      eventStatus: cache[e.id]?.eventStatus ?? null, articleType: cache[e.id]?.articleType ?? null,
    };
    const article: RawArticle = {
      title: se?.sourceTitle ?? e.canonicalTitle, url: "", publishedAt: e.announcementDate?.toISOString() ?? null,
      snippet: null, sourceId: "", provider: vendorName ?? "", sourceType: se?.sourceType ?? "wire_service",
      bodyText: body, publisherUrl: null,
    };

    const stale = e.announcementDate ? e.announcementDate.getTime() < cutoff : false;
    let outcome: Outcome; let reason: string | null;
    if (stale && !counterparty) { outcome = "archive"; reason = "archived:stale_no_counterparty"; }
    else {
      void article;
      const g = decidePublication(result, vendorId);
      outcome = g.status === "published" ? "publish" : "keep"; reason = g.reason;
    }
    tally[outcome]++;
    for (const r of (reason ?? "").split(",").filter(Boolean)) {
      const k = r.split(":")[0]; reasonCounts.set(k, (reasonCounts.get(k) ?? 0) + 1);
    }
    if (samples[outcome].length < 8) samples[outcome].push(`${e.family}/${e.eventType} ${e.confidenceScore.toFixed(2)} ${reason ?? ""} | ${e.canonicalTitle.slice(0, 70)}`);
    plan.push({ id: e.id, outcome, reason, title: e.canonicalTitle, fix });
  }

  console.log(`\nrepairs: counterparty ${repairs.counterparty} · entity ${repairs.entity} · eventType ${repairs.eventType}`);
  console.log(`plan: publish ${tally.publish} · archive ${tally.archive} · keep ${tally.keep}`);
  console.log("reasons:", [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", "));
  for (const o of ["publish", "archive", "keep"] as Outcome[]) { console.log(`\n${o} sample:`); samples[o].forEach(s => console.log("  " + s)); }

  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }

  let done = 0;
  for (let i = 0; i < plan.length; i += 20) {
    await Promise.all(plan.slice(i, i + 20).map(async p => {
      const newStatus = p.outcome === "publish" ? "published" : p.outcome === "archive" ? "excluded_noise" : "needs_review";
      await prisma.$transaction([
        prisma.canonicalMarketEvent.update({
          where: { id: p.id },
          data: { publicationStatus: newStatus, humanReviewRequired: p.outcome === "keep", reviewReason: p.outcome === "publish" ? null : p.reason, ...p.fix },
        }),
        prisma.reviewAction.create({
          data: {
            eventId: p.id, action: `regate_${p.outcome}`, previousValue: "needs_review", newValue: newStatus,
            reviewerNote: [p.reason, Object.keys(p.fix).length ? `repaired:${Object.keys(p.fix).join("+")}` : null].filter(Boolean).join(" "),
          },
        }),
      ]);
      done++;
    }));
    if (done % 200 === 0 || i + 20 >= plan.length) console.log(`  written ${done}/${plan.length}`);
  }
  console.log("done");
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
