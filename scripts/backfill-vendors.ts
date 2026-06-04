/**
 * Backfill: create missing Entity records for all 63 tracked vendors,
 * add alias mappings for common name variants, then re-import predecessor
 * records for any vendor that was previously excluded.
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env", override: true });
dotenv.config({ path: ".env.local", override: true });

import { readFileSync } from "fs";
import crypto from "crypto";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";
import { extractArticle, ruleBasedExtract } from "../src/lib/ingestion/classifier";
import type { RawArticle } from "../src/lib/ingestion/crawler";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL not set");
const adapter = new PrismaNeon({ connectionString });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new PrismaClient({ adapter } as any);

const PRED_PATH = "/Users/michaelcook/Documents/Dev Projects/byson/b-yson-training-nextjs-branded/data/contracts.json";

// ── Vendor definitions with aliases ─────────────────────────────────────────
const VENDOR_DEFS: { name: string; slug: string; aliases: string[] }[] = [
  { name: "Accenture",              slug: "accenture",              aliases: ["Accenture Plc", "Accenture plc", "Accenture PLC", "Accenture Federal Services"] },
  { name: "ADP",                    slug: "adp",                    aliases: ["ADP, LLC", "Automatic Data Processing"] },
  { name: "Alorica",                slug: "alorica",                aliases: ["Alorica Inc"] },
  { name: "Amdocs",                 slug: "amdocs",                 aliases: ["Amdocs Ltd", "Amdocs Limited"] },
  { name: "Atento",                 slug: "atento",                 aliases: ["Atento S.A."] },
  { name: "Atos",                   slug: "atos",                   aliases: ["Atos SE", "Atos / Eviden", "Eviden", "Atos Group"] },
  { name: "Birlasoft",              slug: "birlasoft",              aliases: ["Birlasoft Ltd", "Birlasoft Limited"] },
  { name: "Broadridge",             slug: "broadridge",             aliases: ["Broadridge Financial Solutions"] },
  { name: "Capita",                 slug: "capita",                 aliases: ["Capita Plc", "Capita plc"] },
  { name: "Capgemini",              slug: "capgemini",              aliases: ["Capgemini SE", "Capgemini Technology Services"] },
  { name: "CGI",                    slug: "cgi",                    aliases: ["CGI Inc", "CGI Group", "CGI Group Inc"] },
  { name: "Coforge",                slug: "coforge",                aliases: ["Coforge Ltd", "Coforge Limited", "NIIT Technologies"] },
  { name: "Cognizant",              slug: "cognizant",              aliases: ["Cognizant Technology Solutions", "Cognizant Technology Solutions Corp"] },
  { name: "Concentrix",             slug: "concentrix",             aliases: ["Concentrix Corp", "Concentrix Corporation"] },
  { name: "Conduent",               slug: "conduent",               aliases: ["Conduent Inc", "Conduent Incorporated"] },
  { name: "CSS Corp",               slug: "css-corp",               aliases: ["CSS Corp Pvt Ltd", "Movate"] },
  { name: "Datamatics",             slug: "datamatics",             aliases: ["Datamatics Global Services"] },
  { name: "Deloitte",               slug: "deloitte",               aliases: ["Deloitte Consulting", "Deloitte LLP", "Deloitte Touche Tohmatsu"] },
  { name: "Dell Technologies",      slug: "dell-technologies",      aliases: ["Dell Inc", "Dell EMC", "Dell Technologies Inc"] },
  { name: "DXC Technology",         slug: "dxc-technology",         aliases: ["DXC Technology Co", "DXC Technology Company"] },
  { name: "EPAM",                   slug: "epam",                   aliases: ["EPAM Systems", "EPAM Systems Inc"] },
  { name: "EXL",                    slug: "exl",                    aliases: ["EXL Service", "EXL Service Holdings", "ExlService Holdings"] },
  { name: "EY",                     slug: "ey",                     aliases: ["Ernst & Young", "Ernst & Young LLP", "EY LLP"] },
  { name: "Firstsource",            slug: "firstsource",            aliases: ["Firstsource Solutions", "Firstsource Solutions Ltd"] },
  { name: "Foundever",              slug: "foundever",              aliases: ["Foundever (formerly Sitel)", "Sitel Group"] },
  { name: "Fujitsu",                slug: "fujitsu",                aliases: ["Fujitsu Ltd", "Fujitsu Limited", "Fujitsu Australia"] },
  { name: "Genpact",                slug: "genpact",                aliases: ["Genpact Ltd", "Genpact Limited"] },
  { name: "HCLTech",                slug: "hcltech",                aliases: ["HCL Technologies", "HCL Technologies Ltd", "HCL Tech"] },
  { name: "Hexaware",               slug: "hexaware",               aliases: ["Hexaware Technologies", "Hexaware Technologies Ltd"] },
  { name: "Hitachi Digital Services", slug: "hitachi-digital",      aliases: ["Hitachi Digital / Hitachi Systems", "Hitachi Systems", "Hitachi Vantara"] },
  { name: "IBM",                    slug: "ibm",                    aliases: ["International Business Machines", "International Business Machines Corp", "IBM Corp", "IBM Corporation"] },
  { name: "Infosys",                slug: "infosys",                aliases: ["Infosys Ltd", "Infosys Limited", "Infosys BPM"] },
  { name: "KPMG",                   slug: "kpmg",                   aliases: ["KPMG LLP", "KPMG International"] },
  { name: "Kyndryl",                slug: "kyndryl",                aliases: ["Kyndryl Holdings", "Kyndryl Holdings Inc", "Kyndryl Inc"] },
  { name: "L&T Technology Services", slug: "ltts",                  aliases: ["LTTS", "L&T Technology Services Ltd"] },
  { name: "LTIMindtree",            slug: "ltimindtree",            aliases: ["LTIMindtree Ltd", "LTI", "Mindtree", "Larsen & Toubro Infotech"] },
  { name: "Majorel",                slug: "majorel",                aliases: ["Majorel Group"] },
  { name: "Mastek",                 slug: "mastek",                 aliases: ["Mastek Ltd", "Mastek Limited"] },
  { name: "Mphasis",                slug: "mphasis",                aliases: ["Mphasis Ltd", "Mphasis Limited"] },
  { name: "Nagarro",                slug: "nagarro",                aliases: ["Nagarro SE"] },
  { name: "NEC",                    slug: "nec",                    aliases: ["NEC Corporation", "NEC Corp"] },
  { name: "NICE",                   slug: "nice",                   aliases: ["NICE Systems", "NICE Ltd", "NICE inContact"] },
  { name: "NTT DATA",               slug: "ntt-data",               aliases: ["NTT DATA Group Corp", "NTT Data", "NTT DATA Inc", "NTT DATA Services"] },
  { name: "Orange Business",        slug: "orange-business",        aliases: ["Orange Business Services", "Orange S.A."] },
  { name: "Persistent",             slug: "persistent",             aliases: ["Persistent Systems", "Persistent Systems Ltd"] },
  { name: "PwC",                    slug: "pwc",                    aliases: ["PricewaterhouseCoopers", "PwC LLP", "PricewaterhouseCoopers LLP"] },
  { name: "Searce",                 slug: "searce",                 aliases: ["Searce Inc"] },
  { name: "Singtel",                slug: "singtel",                aliases: ["Singapore Telecommunications", "NCS", "NCS Group"] },
  { name: "Sopra Steria",           slug: "sopra-steria",           aliases: ["Sopra Steria Group"] },
  { name: "Stefanini",              slug: "stefanini",              aliases: ["Stefanini Group", "Stefanini IT Solutions"] },
  { name: "Sutherland",             slug: "sutherland",             aliases: ["Sutherland Global Services"] },
  { name: "Synechron",              slug: "synechron",              aliases: ["Synechron Inc"] },
  { name: "TCS",                    slug: "tcs",                    aliases: ["Tata Consultancy Services", "Tata Consultancy Services Ltd", "Tata Consultancy Services Limited"] },
  { name: "Tech Mahindra",          slug: "tech-mahindra",          aliases: ["Tech Mahindra Ltd", "Tech Mahindra Limited"] },
  { name: "Teleperformance",        slug: "teleperformance",        aliases: ["Teleperformance SE", "Teleperformance Group"] },
  { name: "TELUS International",    slug: "telus-international",    aliases: ["TELUS Digital", "TELUS International Inc"] },
  { name: "Tietoevry",              slug: "tietoevry",              aliases: ["Tietoevry Oyj", "TietoEVRY", "Tieto"] },
  { name: "TTEC",                   slug: "ttec",                   aliases: ["TTEC Holdings", "TTEC Holdings Inc", "TeleTech"] },
  { name: "Unisys",                 slug: "unisys",                 aliases: ["Unisys Corp", "Unisys Corporation"] },
  { name: "UST",                    slug: "ust",                    aliases: ["UST Global", "UST Inc"] },
  { name: "Virtusa",                slug: "virtusa",                aliases: ["Virtusa Corp", "Virtusa Corporation"] },
  { name: "Wipro",                  slug: "wipro",                  aliases: ["Wipro Ltd", "Wipro Limited"] },
  { name: "WNS",                    slug: "wns",                    aliases: ["WNS Holdings", "WNS (Holdings) Limited", "WNS Global Services"] },
];

// Build a lookup from any name variant -> canonical name
function buildAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of VENDOR_DEFS) {
    map.set(v.name.toLowerCase(), v.name);
    for (const a of v.aliases) map.set(a.toLowerCase(), v.name);
  }
  return map;
}

function hashArticle(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// ── Step 1: Create missing entities + aliases ───────────────────────────────
async function ensureEntities() {
  console.log("Step 1: Ensuring all 63 vendor entities exist with aliases...");
  let created = 0, aliasesAdded = 0;

  for (const def of VENDOR_DEFS) {
    // Find existing by canonical name or any alias
    let entity = await prisma.entity.findFirst({
      where: {
        OR: [
          { canonicalName: def.name },
          { slug: def.slug },
          ...def.aliases.map(a => ({ aliases: { some: { alias: a } } })),
        ],
      },
      select: { id: true, canonicalName: true },
    });

    if (!entity) {
      entity = await prisma.entity.create({
        data: {
          canonicalName: def.name,
          displayName: def.name,
          slug: def.slug,
          entityType: "vendor",
          regions: "[]",
          isActive: true,
        },
      });
      created++;
      console.log(`  Created: ${def.name}`);
    }

    // Add missing aliases
    for (const alias of [def.name, ...def.aliases]) {
      const exists = await prisma.entityAlias.findFirst({
        where: { entityId: entity.id, alias },
      });
      if (!exists) {
        await prisma.entityAlias.create({
          data: { entityId: entity.id, alias },
        });
        aliasesAdded++;
      }
    }
  }

  console.log(`  Entities created: ${created}, aliases added: ${aliasesAdded}`);
}

// ── Step 2: Re-import predecessor records for all tracked vendors ───────────
interface PredRecord {
  id: string; title: string; body?: string; articleUrl?: string;
  scopeStatus?: string; isNoise?: boolean;
  serviceProvider?: string; canonicalProvider?: string;
  clientName?: string; clientIndustry?: string;
  contractStartDate?: string; contractEndDate?: string;
  tcvUsd?: number; tcvEstimated?: boolean;
  geography?: string; source?: string;
  informationType?: string;
}

async function resolveVendorId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const e = await prisma.entity.findFirst({
    where: {
      OR: [
        { canonicalName: name },
        { aliases: { some: { alias: name } } },
      ],
    },
    select: { id: true },
  });
  return e?.id ?? null;
}

async function backfillPredecessor() {
  console.log("\nStep 2: Backfilling predecessor records for all tracked vendors...");
  const aliasMap = buildAliasMap();

  const raw = JSON.parse(readFileSync(PRED_PATH, "utf-8")) as { contracts: PredRecord[] };
  const all = raw.contracts;
  console.log(`  ${all.length.toLocaleString()} total predecessor records`);

  // Filter: in-scope + identified vendor + non-noise
  const filtered = all.filter(c => {
    const inScope = c.scopeStatus === "in_scope" || c.scopeStatus === "In Scope";
    if (!inScope) return false;
    if (c.isNoise) return false;
    const provider = c.canonicalProvider || c.serviceProvider || "";
    if (!provider || provider === "Unknown" || provider === "Unknown Provider") return false;
    if (!c.title || c.title.length < 15) return false;
    // Must be one of our 63 tracked vendors
    const canonical = aliasMap.get(provider.toLowerCase());
    if (!canonical) return false;
    return true;
  });
  console.log(`  ${filtered.length.toLocaleString()} in-scope records matching tracked vendors`);

  // Skip URLs already in SourceEvent
  const existingUrls = new Set(
    (await prisma.sourceEvent.findMany({ select: { sourceUrl: true } })).map(s => s.sourceUrl)
  );
  console.log(`  ${existingUrls.size.toLocaleString()} URLs already in SourceEvent`);

  const toProcess = filtered.filter(c => {
    const sourceUrl = c.articleUrl || `predecessor://${c.id}`;
    return !existingUrls.has(sourceUrl);
  });
  console.log(`  ${toProcess.length.toLocaleString()} new records to process`);

  if (toProcess.length === 0) { console.log("  Nothing new to import."); return; }

  const useLlm = !!process.env.ANTHROPIC_API_KEY;
  console.log(`  LLM extraction: ${useLlm ? "enabled" : "DISABLED"}`);

  const run = await prisma.ingestionRun.create({
    data: { runType: "predecessor_backfill", sourceFilter: "predecessor" },
  });

  const stats = { processed: 0, published: 0, queued: 0, excluded: 0, errors: 0 };
  const CONCURRENCY = 10;
  const PROGRESS_EVERY = 100;
  const startTime = Date.now();

  async function processOne(c: PredRecord): Promise<void> {
    try {
      const sourceUrl = c.articleUrl || `predecessor://${c.id}`;
      const provider = c.canonicalProvider || c.serviceProvider || "Unknown";
      const article: RawArticle = {
        title: c.title.slice(0, 300),
        url: sourceUrl,
        publishedAt: c.contractStartDate ?? null,
        snippet: (c.body || c.title).slice(0, 1500),
        sourceId: "predecessor-backfill",
        provider,
        sourceType: c.source?.includes("InvestorRelations") ? "investor_relations_release" :
                    c.source?.includes("press") ? "vendor_press_release" : "wire_service",
      };

      const existing = await prisma.sourceEvent.findUnique({
        where: { sourceUrl }, select: { id: true },
      });
      if (existing) { stats.excluded++; return; }

      const result = useLlm ? await extractArticle(article) : ruleBasedExtract(article);
      if (result.family === "EXCLUDED") { stats.excluded++; return; }

      const isHighConf = result.confidenceScore >= 0.72 && result.extractionMethod === "llm";
      const publicationStatus = isHighConf ? "published" : "needs_review";
      const vendorId = await resolveVendorId(result.vendorRaw || provider);

      await prisma.$transaction(async (tx) => {
        const sourceEvent = await tx.sourceEvent.create({
          data: {
            sourceUrl,
            rawTextHash: hashArticle(sourceUrl),
            sourceTitle: article.title,
            sourceName: provider,
            sourceType: article.sourceType,
            publicationDate: article.publishedAt ? new Date(article.publishedAt) : null,
            rawText: article.snippet,
            extractedFamily: result.family,
            extractionConfidence: result.confidenceScore,
            processingStatus: "extracted",
            ingestionRunId: run.id,
          },
        });

        const event = await tx.canonicalMarketEvent.create({
          data: {
            family: result.family,
            eventType: result.eventType,
            canonicalTitle: result.canonicalTitle.slice(0, 500),
            announcementDate: article.publishedAt ? new Date(article.publishedAt) : null,
            announcementDateBasis: "explicit",
            geography: JSON.stringify(result.geography),
            industry: result.industry,
            industryBasis: result.industry ? "classified" : "unavailable",
            confidenceScore: result.confidenceScore,
            commercialRelevanceScore: result.tcvUsd ? Math.min(0.95, 0.6 + result.confidenceScore * 0.35) : result.confidenceScore * 0.8,
            humanReviewRequired: publicationStatus === "needs_review",
            publicationStatus,
            analystInsight: result.analystInsight,
            originalArticleUrl: sourceUrl,
            primaryEntityId: vendorId,
            sourceEvents: { connect: { id: sourceEvent.id } },
          },
        });

        if (result.family === "CONTRACT") {
          await tx.contractDetails.create({
            data: {
              canonicalEventId: event.id,
              vendorId: vendorId ?? undefined,
              vendorRaw: result.vendorRaw || provider,
              vendorConfidence: vendorId ? 0.9 : 0.6,
              clientRaw: result.clientRaw,
              clientConfidence: 0.5,
              contractEventType: result.eventType,
              tcvCommittedUsd: result.tcvUsd && !result.tcvIsEstimate ? result.tcvUsd : null,
              tcvEstimateMidUsd: result.tcvUsd && result.tcvIsEstimate ? result.tcvUsd : null,
              tcvBasis: result.tcvUsd ? (result.tcvIsEstimate ? "model_estimated" : "official_disclosed") : "undisclosed",
              tcvIsEstimate: result.tcvIsEstimate,
              contractLengthMonths: result.contractLengthMonths,
              primaryMacroServiceLine: result.primaryMacroServiceLine,
              scopeSummary: article.snippet?.slice(0, 500),
              platformsUsed: "[]",
              clientServiceCoverageLocation: JSON.stringify(result.geography),
              secondaryMacroServiceLines: "[]",
              secondaryMicroServiceLines: "[]",
            },
          });
        }
      });

      if (publicationStatus === "published") stats.published++; else stats.queued++;
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 5) console.error(`  Error on ${c.id}:`, (err as Error).message);
    }
  }

  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= toProcess.length) return;
      await processOne(toProcess[idx]);
      stats.processed++;
      if (stats.processed % PROGRESS_EVERY === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = stats.processed / elapsed;
        const eta = rate > 0 ? ((toProcess.length - stats.processed) / rate / 60).toFixed(1) : "?";
        console.log(`  ${stats.processed}/${toProcess.length} | pub:${stats.published} queued:${stats.queued} excl:${stats.excluded} err:${stats.errors} | ${rate.toFixed(1)}/s ETA ${eta}min`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await prisma.ingestionRun.update({
    where: { id: run.id },
    data: {
      status: stats.errors > toProcess.length * 0.1 ? "partial" : "completed",
      completedAt: new Date(),
      articlesFound: stats.processed,
      articlesDuped: 0,
      eventsExtracted: stats.published + stats.queued,
      eventsPublished: stats.published,
      eventsQueued: stats.queued,
    },
  });

  const totalMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log(`\n${"=".repeat(54)}`);
  console.log(`Predecessor backfill complete in ${totalMin} min:`);
  console.log(`  Processed:    ${stats.processed.toLocaleString()}`);
  console.log(`  Published:    ${stats.published.toLocaleString()}`);
  console.log(`  Queued:       ${stats.queued.toLocaleString()}`);
  console.log(`  Excluded:     ${stats.excluded.toLocaleString()}`);
  console.log(`  Errors:       ${stats.errors.toLocaleString()}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await ensureEntities();
  await backfillPredecessor();
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
