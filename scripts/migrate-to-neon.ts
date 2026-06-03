/**
 * Migrate all data from local SQLite (dev.db.sqlite-backup) into Neon Postgres.
 * Reads SQLite directly via better-sqlite3, writes through the Neon-connected Prisma client.
 *
 * Order matters for FK constraints: Entity → EntityAlias → SourceRegistryItem → IngestionRun
 *   → SourceEvent → CanonicalMarketEvent → detail tables → ReviewAction → DedupDecision
 *   → join table.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });
dotenv.config({ path: ".env" });

import Database from "better-sqlite3";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";

const SQLITE_PATH = "dev.db.sqlite-backup";
const BATCH = 500;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set");
const adapter = new PrismaNeon({ connectionString });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter } as any);

const sqlite = new Database(SQLITE_PATH, { readonly: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toBool(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

async function chunkInsert<T>(
  label: string,
  rows: T[],
  insertOne: (row: T) => Promise<unknown>,
) {
  let ok = 0, err = 0;
  const startTime = Date.now();
  for (let i = 0; i < rows.length; i++) {
    try {
      await insertOne(rows[i]);
      ok++;
    } catch (e) {
      err++;
      if (err <= 3) console.error(`  ${label} row error:`, (e as Error).message.slice(0, 200));
    }
    if ((i + 1) % BATCH === 0 || i === rows.length - 1) {
      const rate = (i + 1) / ((Date.now() - startTime) / 1000);
      console.log(`  ${label}: ${i + 1}/${rows.length} (${rate.toFixed(0)}/s, ${err} errors)`);
    }
  }
  console.log(`✓ ${label}: ${ok} inserted, ${err} errors`);
  return { ok, err };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Starting SQLite → Neon Postgres migration");
  console.log(`  Source: ${SQLITE_PATH}`);
  console.log(`  Target: ${connectionString!.split("@")[1]?.split("/")[0] ?? "neon"}`);

  // 1. Entities
  console.log("\n[1/10] Entities…");
  const entities = sqlite.prepare("SELECT * FROM Entity").all() as Array<Record<string, unknown>>;
  await chunkInsert("Entity", entities, async (e) => {
    await prisma.entity.create({
      data: {
        id: e.id as string,
        canonicalName: e.canonicalName as string,
        displayName: e.displayName as string,
        slug: e.slug as string,
        entityType: e.entityType as string,
        parentId: (e.parentId as string) ?? null,
        regions: (e.regions as string) ?? "[]",
        logoUrl: (e.logoUrl as string) ?? null,
        websiteUrl: (e.websiteUrl as string) ?? null,
        isActive: toBool(e.isActive),
        createdAt: toDate(e.createdAt) ?? new Date(),
        updatedAt: toDate(e.updatedAt) ?? new Date(),
      },
    });
  });

  // 2. EntityAlias
  console.log("\n[2/10] EntityAlias…");
  const aliases = sqlite.prepare("SELECT * FROM EntityAlias").all() as Array<Record<string, unknown>>;
  await chunkInsert("EntityAlias", aliases, async (a) => {
    await prisma.entityAlias.create({
      data: {
        id: a.id as string,
        entityId: a.entityId as string,
        alias: a.alias as string,
      },
    });
  });

  // 3. SourceRegistryItem
  console.log("\n[3/10] SourceRegistryItem…");
  const sources = sqlite.prepare("SELECT * FROM SourceRegistryItem").all() as Array<Record<string, unknown>>;
  await chunkInsert("SourceRegistryItem", sources, async (s) => {
    await prisma.sourceRegistryItem.create({
      data: {
        id: s.id as string,
        name: s.name as string,
        provider: s.provider as string,
        url: s.url as string,
        sourceType: s.sourceType as string,
        tier: (s.tier as string) ?? "tier_2_secondary",
        fetchMethod: (s.fetchMethod as string) ?? "rss",
        isActive: toBool(s.isActive ?? 1),
        lastCrawledAt: toDate(s.lastCrawledAt),
        nextDueAt: toDate(s.nextDueAt),
        lastItemCount: (s.lastItemCount as number) ?? 0,
        consecutiveErrors: (s.consecutiveErrors as number) ?? 0,
        lastError: (s.lastError as string) ?? null,
        createdAt: toDate(s.createdAt) ?? new Date(),
        updatedAt: toDate(s.updatedAt) ?? new Date(),
      },
    });
  });

  // 4. IngestionRun
  console.log("\n[4/10] IngestionRun…");
  const runs = sqlite.prepare("SELECT * FROM IngestionRun").all() as Array<Record<string, unknown>>;
  await chunkInsert("IngestionRun", runs, async (r) => {
    await prisma.ingestionRun.create({
      data: {
        id: r.id as string,
        runType: r.runType as string,
        sourceFilter: (r.sourceFilter as string) ?? null,
        startedAt: toDate(r.startedAt) ?? new Date(),
        completedAt: toDate(r.completedAt),
        status: (r.status as string) ?? "running",
        articlesFound: (r.articlesFound as number) ?? 0,
        articlesDuped: (r.articlesDuped as number) ?? 0,
        eventsExtracted: (r.eventsExtracted as number) ?? 0,
        eventsPublished: (r.eventsPublished as number) ?? 0,
        eventsQueued: (r.eventsQueued as number) ?? 0,
        errors: (r.errors as string) ?? "[]",
      },
    });
  });

  // 5. SourceEvent
  console.log("\n[5/10] SourceEvent…");
  const sourceEvents = sqlite.prepare("SELECT * FROM SourceEvent").all() as Array<Record<string, unknown>>;
  await chunkInsert("SourceEvent", sourceEvents, async (se) => {
    await prisma.sourceEvent.create({
      data: {
        id: se.id as string,
        sourceUrl: se.sourceUrl as string,
        rawTextHash: se.rawTextHash as string,
        sourceTitle: (se.sourceTitle as string) ?? null,
        sourceName: (se.sourceName as string) ?? null,
        sourceType: se.sourceType as string,
        publicationDate: toDate(se.publicationDate),
        retrievedAt: toDate(se.retrievedAt) ?? new Date(),
        rawText: (se.rawText as string) ?? null,
        extractedFamily: (se.extractedFamily as string) ?? null,
        extractionConfidence: (se.extractionConfidence as number) ?? null,
        processingStatus: (se.processingStatus as string) ?? "pending",
        ingestionRunId: (se.ingestionRunId as string) ?? null,
        createdAt: toDate(se.createdAt) ?? new Date(),
      },
    });
  });

  // 6. CanonicalMarketEvent
  console.log("\n[6/10] CanonicalMarketEvent…");
  const cmes = sqlite.prepare("SELECT * FROM CanonicalMarketEvent").all() as Array<Record<string, unknown>>;
  await chunkInsert("CanonicalMarketEvent", cmes, async (c) => {
    await prisma.canonicalMarketEvent.create({
      data: {
        id: c.id as string,
        family: c.family as string,
        eventType: c.eventType as string,
        canonicalTitle: c.canonicalTitle as string,
        announcementDate: toDate(c.announcementDate),
        announcementDateBasis: (c.announcementDateBasis as string) ?? "explicit",
        effectiveDate: toDate(c.effectiveDate),
        geography: (c.geography as string) ?? "[]",
        industry: (c.industry as string) ?? null,
        industryBasis: (c.industryBasis as string) ?? "unavailable",
        confidenceScore: (c.confidenceScore as number) ?? 0.5,
        commercialRelevanceScore: (c.commercialRelevanceScore as number) ?? 0.5,
        humanReviewRequired: toBool(c.humanReviewRequired),
        publicationStatus: (c.publicationStatus as string) ?? "published",
        analystInsight: (c.analystInsight as string) ?? null,
        analystInsightConfidence: (c.analystInsightConfidence as number) ?? null,
        originalArticleUrl: (c.originalArticleUrl as string) ?? null,
        primaryEntityId: (c.primaryEntityId as string) ?? null,
        createdAt: toDate(c.createdAt) ?? new Date(),
        updatedAt: toDate(c.updatedAt) ?? new Date(),
      },
    });
  });

  // 7. Detail tables (in parallel since they don't FK each other)
  console.log("\n[7/10] Detail tables…");

  const contracts = sqlite.prepare("SELECT * FROM ContractDetails").all() as Array<Record<string, unknown>>;
  await chunkInsert("ContractDetails", contracts, async (cd) => {
    await prisma.contractDetails.create({
      data: {
        id: cd.id as string,
        canonicalEventId: cd.canonicalEventId as string,
        vendorId: (cd.vendorId as string) ?? null,
        vendorRaw: (cd.vendorRaw as string) ?? null,
        vendorConfidence: (cd.vendorConfidence as number) ?? 0.5,
        clientId: (cd.clientId as string) ?? null,
        clientRaw: (cd.clientRaw as string) ?? null,
        clientAnonymised: toBool(cd.clientAnonymised),
        clientDescriptor: (cd.clientDescriptor as string) ?? null,
        clientIndustry: (cd.clientIndustry as string) ?? null,
        clientConfidence: (cd.clientConfidence as number) ?? 0.5,
        contractEventType: (cd.contractEventType as string) ?? null,
        previousVendorRaw: (cd.previousVendorRaw as string) ?? null,
        incumbentDisplaced: cd.incumbentDisplaced == null ? null : toBool(cd.incumbentDisplaced),
        contractStartDate: toDate(cd.contractStartDate),
        contractEndDate: toDate(cd.contractEndDate),
        contractLengthMonths: (cd.contractLengthMonths as number) ?? null,
        tcvCommittedUsd: (cd.tcvCommittedUsd as number) ?? null,
        tcvCeilingUsd: (cd.tcvCeilingUsd as number) ?? null,
        tcvFrameworkUsd: (cd.tcvFrameworkUsd as number) ?? null,
        tcvEstimateMidUsd: (cd.tcvEstimateMidUsd as number) ?? null,
        tcvOriginalCurrency: (cd.tcvOriginalCurrency as string) ?? null,
        tcvOriginalValue: (cd.tcvOriginalValue as number) ?? null,
        tcvBasis: (cd.tcvBasis as string) ?? "undisclosed",
        tcvIsEstimate: toBool(cd.tcvIsEstimate),
        primaryMacroServiceLine: (cd.primaryMacroServiceLine as string) ?? null,
        primaryMicroServiceLine: (cd.primaryMicroServiceLine as string) ?? null,
        secondaryMacroServiceLines: (cd.secondaryMacroServiceLines as string) ?? "[]",
        secondaryMicroServiceLines: (cd.secondaryMicroServiceLines as string) ?? "[]",
        scopeSummary: (cd.scopeSummary as string) ?? null,
        platformsUsed: (cd.platformsUsed as string) ?? "[]",
        clientServiceCoverageLocation: (cd.clientServiceCoverageLocation as string) ?? "[]",
        vendorDeliveryCentreLocation: (cd.vendorDeliveryCentreLocation as string) ?? "[]",
      },
    });
  });

  const mas = sqlite.prepare("SELECT * FROM MaDetails").all() as Array<Record<string, unknown>>;
  await chunkInsert("MaDetails", mas, async (m) => {
    await prisma.maDetails.create({
      data: {
        id: m.id as string,
        canonicalEventId: m.canonicalEventId as string,
        maEventType: (m.maEventType as string) ?? null,
        acquirerId: (m.acquirerId as string) ?? null,
        acquirerRaw: (m.acquirerRaw as string) ?? null,
        targetId: (m.targetId as string) ?? null,
        targetRaw: (m.targetRaw as string) ?? null,
        dealValueUsd: (m.dealValueUsd as number) ?? null,
        dealValueBasis: (m.dealValueBasis as string) ?? "undisclosed",
        stakePercent: (m.stakePercent as number) ?? null,
        statusAtAnnouncement: (m.statusAtAnnouncement as string) ?? "announced",
        rationale: (m.rationale as string) ?? null,
      },
    });
  });

  const partnerships = sqlite.prepare("SELECT * FROM PartnershipDetails").all() as Array<Record<string, unknown>>;
  await chunkInsert("PartnershipDetails", partnerships, async (p) => {
    await prisma.partnershipDetails.create({
      data: {
        id: p.id as string,
        canonicalEventId: p.canonicalEventId as string,
        partnershipType: (p.partnershipType as string) ?? null,
        entityAId: (p.entityAId as string) ?? null,
        entityARaw: (p.entityARaw as string) ?? null,
        entityBId: (p.entityBId as string) ?? null,
        entityBRaw: (p.entityBRaw as string) ?? null,
        scopeSummary: (p.scopeSummary as string) ?? null,
        platformFocus: (p.platformFocus as string) ?? null,
      },
    });
  });

  const orgs = sqlite.prepare("SELECT * FROM OrgChangeDetails").all() as Array<Record<string, unknown>>;
  await chunkInsert("OrgChangeDetails", orgs, async (o) => {
    await prisma.orgChangeDetails.create({
      data: {
        id: o.id as string,
        canonicalEventId: o.canonicalEventId as string,
        orgEventType: (o.orgEventType as string) ?? null,
        entityId: (o.entityId as string) ?? null,
        personName: (o.personName as string) ?? null,
        roleName: (o.roleName as string) ?? null,
        previousRole: (o.previousRole as string) ?? null,
        locationCity: (o.locationCity as string) ?? null,
        locationCountry: (o.locationCountry as string) ?? null,
        headcount: (o.headcount as number) ?? null,
        rationale: (o.rationale as string) ?? null,
      },
    });
  });

  const offerings = sqlite.prepare("SELECT * FROM OfferingDetails").all() as Array<Record<string, unknown>>;
  await chunkInsert("OfferingDetails", offerings, async (o) => {
    await prisma.offeringDetails.create({
      data: {
        id: o.id as string,
        canonicalEventId: o.canonicalEventId as string,
        offeringType: (o.offeringType as string) ?? null,
        vendorRaw: (o.vendorRaw as string) ?? null,
        offeringName: (o.offeringName as string) ?? null,
        scopeSummary: (o.scopeSummary as string) ?? null,
        targetMarket: (o.targetMarket as string) ?? null,
        platformsUsed: (o.platformsUsed as string) ?? "[]",
      },
    });
  });

  // 8. DedupDecision (optional, may be empty)
  console.log("\n[8/10] DedupDecision…");
  try {
    const dedups = sqlite.prepare("SELECT * FROM DedupDecision").all() as Array<Record<string, unknown>>;
    await chunkInsert("DedupDecision", dedups, async (d) => {
      await prisma.dedupDecision.create({
        data: {
          id: d.id as string,
          eventAId: d.eventAId as string,
          eventBId: d.eventBId as string,
          decision: d.decision as string,
          confidence: (d.confidence as number) ?? 0.5,
          mergeRecommended: toBool(d.mergeRecommended),
          linkRecommended: toBool(d.linkRecommended),
          reasonCodes: (d.reasonCodes as string) ?? "[]",
          riskFlags: (d.riskFlags as string) ?? "[]",
          humanReviewRequired: toBool(d.humanReviewRequired),
          resolvedAt: toDate(d.resolvedAt),
          resolvedBy: (d.resolvedBy as string) ?? null,
          createdAt: toDate(d.createdAt) ?? new Date(),
        },
      });
    });
  } catch (e) {
    console.log("  (skipped — table may not exist)", (e as Error).message.slice(0, 80));
  }

  // 9. ReviewAction (optional)
  console.log("\n[9/10] ReviewAction…");
  try {
    const reviews = sqlite.prepare("SELECT * FROM ReviewAction").all() as Array<Record<string, unknown>>;
    await chunkInsert("ReviewAction", reviews, async (r) => {
      await prisma.reviewAction.create({
        data: {
          id: r.id as string,
          eventId: r.eventId as string,
          action: r.action as string,
          reviewerNote: (r.reviewerNote as string) ?? null,
          previousValue: (r.previousValue as string) ?? null,
          newValue: (r.newValue as string) ?? null,
          createdAt: toDate(r.createdAt) ?? new Date(),
        },
      });
    });
  } catch (e) {
    console.log("  (skipped)", (e as Error).message.slice(0, 80));
  }

  // 10. M2M join table
  console.log("\n[10/10] CanonicalMarketEvent ↔ SourceEvent join…");
  const joins = sqlite.prepare(`SELECT A, B FROM "_CanonicalMarketEventToSourceEvent"`).all() as Array<{ A: string; B: string }>;
  let joinOk = 0, joinErr = 0;
  for (const j of joins) {
    try {
      await prisma.canonicalMarketEvent.update({
        where: { id: j.A },
        data: { sourceEvents: { connect: { id: j.B } } },
      });
      joinOk++;
    } catch (e) {
      joinErr++;
      if (joinErr <= 3) console.error("  join error:", (e as Error).message.slice(0, 100));
    }
    if ((joinOk + joinErr) % 500 === 0) {
      console.log(`  join: ${joinOk + joinErr}/${joins.length}`);
    }
  }
  console.log(`✓ Joins: ${joinOk} ok, ${joinErr} errors`);

  console.log("\n✓ Migration complete.");
  sqlite.close();
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
