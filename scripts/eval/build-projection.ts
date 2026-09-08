/**
 * Build the ARTICLE-DERIVED contract event projection for the AI Delivery
 * Mandate programme (§23, §26).
 *
 * The programme already has a projection of the PUBLIC procurement corpus
 * (~/Dev/ai-delivery-mandate/00-programme/contract-tracker/ct_projection.py).
 * This is its private-sector counterpart: the commercial events the reader
 * found in articles, in the same shape, so both can sit in one event space.
 *
 * It carries only what an article stated. Nothing is estimated, nothing is
 * promoted into an analytical value, and every row names the article it came
 * from and the passage that supports it, so a reader can check the claim.
 *
 *   npx tsx scripts/eval/build-projection.ts [--out scripts/eval/article-projection.json] [--since 2024-01-01]
 */
import fs from "fs";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { READER_MODEL, PROMPT_POLICY_VERSION } from "@/lib/ingestion/reader";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

(async () => {
  const out = arg("--out", "scripts/eval/article-projection.json");
  const since = new Date(arg("--since", "2024-01-01"));

  const events = await prisma.canonicalMarketEvent.findMany({
    where: { family: "CONTRACT", readerVersion: { not: null }, announcementDate: { gte: since } },
    select: {
      id: true, canonicalContractEventId: true, canonicalTitle: true, commercialEventType: true, eventStatus: true,
      buyerSector: true, aiRelevance: true, supportingText: true, readerVersion: true, announcementDate: true,
      announcementDateBasis: true, effectiveDate: true, geography: true, industry: true, publicationStatus: true,
      counterpartyRaw: true, originalArticleUrl: true,
      primaryEntity: { select: { canonicalName: true } },
      contractDetails: { select: { vendorRaw: true, clientRaw: true, clientDescriptor: true, clientAnonymised: true, contractEventType: true,
        tcvCommittedUsd: true, tcvOriginalValue: true, tcvOriginalCurrency: true, tcvBasis: true, tcvIsEstimate: true, acvUsd: true,
        contractLengthMonths: true, renewalPeriodMonths: true, expansionValueUsd: true, pricingModel: true, outcomePricing: true,
        feeAtRisk: true, consumptionModel: true, previousVendorRaw: true, incumbentDisplaced: true, primaryMacroServiceLine: true, scopeSummary: true } },
      sourceEvents: { select: { sourceUrl: true, publisherUrl: true, sourceName: true, sourceTitle: true, publicationDate: true, articleType: true, articleTextHash: true, modelId: true, promptPolicyVersion: true, analysedAt: true } },
    },
    orderBy: { announcementDate: "desc" },
  });

  const rows = events.map(e => {
    const cd = e.contractDetails;
    const support = e.supportingText ? JSON.parse(e.supportingText) as Record<string, string> : {};
    return {
      canonicalContractEventId: e.canonicalContractEventId,
      provider: e.primaryEntity?.canonicalName ?? cd?.vendorRaw ?? null,
      supplierNameAsPublished: cd?.vendorRaw ?? null,
      client: cd?.clientRaw ?? e.counterpartyRaw ?? null,
      clientDescriptor: cd?.clientDescriptor ?? null,
      clientAnonymised: cd?.clientAnonymised ?? false,
      buyerSector: e.buyerSector,
      eventType: e.commercialEventType,
      eventStatus: e.eventStatus,
      title: e.canonicalTitle,
      awardDate: e.announcementDate?.toISOString().slice(0, 10) ?? null,
      awardDateBasis: e.announcementDateBasis,
      startDate: e.effectiveDate?.toISOString().slice(0, 10) ?? null,
      endDate: null,                                        // no article states one; never derived from a duration
      durationMonths: cd?.contractLengthMonths ?? null,
      renewalPeriodMonths: cd?.renewalPeriodMonths ?? null,
      valueUsd: cd?.tcvCommittedUsd ?? null,
      valueDisclosed: cd?.tcvCommittedUsd != null,
      valueIsEstimate: cd?.tcvIsEstimate ?? false,
      valueOriginal: cd?.tcvOriginalValue ?? null,
      valueCurrency: cd?.tcvOriginalCurrency ?? null,
      valueBasis: cd?.tcvBasis ?? null,
      acvUsd: cd?.acvUsd ?? null,
      expansionValueUsd: cd?.expansionValueUsd ?? null,
      pricingModel: cd?.pricingModel ?? null,
      outcomePricing: cd?.outcomePricing ?? null,
      feeAtRisk: cd?.feeAtRisk ?? null,
      consumptionModel: cd?.consumptionModel ?? null,
      incumbent: cd?.previousVendorRaw ?? null,
      incumbentDisplaced: cd?.incumbentDisplaced ?? false,
      aiRelevance: e.aiRelevance,
      serviceScope: cd?.primaryMacroServiceLine ?? null,
      scopeSummary: cd?.scopeSummary ?? null,
      geography: JSON.parse(e.geography || "[]") as string[],
      industry: e.industry,
      publicationStatus: e.publicationStatus,
      supportingText: support,
      articles: e.sourceEvents.map(s => ({
        url: s.publisherUrl ?? s.sourceUrl, aggregatorUrl: s.sourceUrl, publisher: s.sourceName, title: s.sourceTitle,
        publishedAt: s.publicationDate?.toISOString().slice(0, 10) ?? null, articleType: s.articleType, articleTextHash: s.articleTextHash,
        modelId: s.modelId, promptPolicyVersion: s.promptPolicyVersion, analysedAt: s.analysedAt?.toISOString() ?? null,
      })),
      articleCount: e.sourceEvents.length,
    };
  });

  const counts = (f: (r: typeof rows[number]) => string | null) => rows.reduce((a, r) => { const k = f(r) ?? "null"; a[k] = (a[k] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const doc = {
    _about: "Article-derived commercial contract events. Candidate evidence for analyst review; not an analytical value, and not a route into the claims ledger.",
    _pairsWith: "00-programme/contract-tracker/ct_projection.py — the public-procurement projection. Same event space, different discovery route.",
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    reader: { modelId: READER_MODEL, promptPolicyVersion: PROMPT_POLICY_VERSION },
    since: since.toISOString().slice(0, 10),
    records: rows.length,
    distinctIdentities: new Set(rows.map(r => r.canonicalContractEventId)).size,
    byBuyerSector: counts(r => r.buyerSector),
    byEventType: counts(r => r.eventType),
    byEventStatus: counts(r => r.eventStatus),
    byAiRelevance: counts(r => r.aiRelevance),
    valueDisclosure: { disclosed: rows.filter(r => r.valueDisclosed).length, undisclosed: rows.filter(r => !r.valueDisclosed).length },
    knownGaps: {
      endDate: "no article states a contract end date; never derived from award date plus duration",
      priorValue: "the value of the contract a takeaway replaced is almost never published",
      aiAttribution: "no source states AI as the cause of an award; aiRelevance describes scope, not causation",
      disclosureBias: "articles over-represent large, named, announced awards; absence of an event is not evidence it did not happen",
    },
    rowsSha256: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    rows,
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`${rows.length} events (${doc.distinctIdentities} identities) → ${out}`);
  console.log(`buyer sector: ${JSON.stringify(doc.byBuyerSector)}`);
  console.log(`event type:   ${JSON.stringify(doc.byEventType)}`);
  console.log(`value:        ${JSON.stringify(doc.valueDisclosure)}`);
  await prisma.$disconnect();
})();
