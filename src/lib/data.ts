import { prisma } from "./db";
import { EventSummary, EventFilters, EventsResponse, DashboardStats, VendorProfile } from "./types";

function shapeEvent(e: {
  id: string; family: string; eventType: string; canonicalTitle: string;
  announcementDate: Date | null; geography: string; industry: string | null;
  confidenceScore: number; commercialRelevanceScore: number; publicationStatus: string;
  analystInsight: string | null; originalArticleUrl: string | null;
  primaryEntity: { canonicalName: string; slug: string } | null;
  contractDetails: {
    vendorRaw: string | null; vendor: { canonicalName: string } | null;
    clientRaw: string | null; client: { canonicalName: string } | null;
    clientAnonymised: boolean; clientDescriptor: string | null;
    tcvCommittedUsd: number | null; tcvEstimateMidUsd: number | null;
    tcvIsEstimate: boolean; tcvBasis: string;
    contractEventType: string | null; primaryMacroServiceLine: string | null;
    contractLengthMonths: number | null;
  } | null;
  maDetails: {
    maEventType: string | null;
    acquirer: { canonicalName: string } | null; acquirerRaw: string | null;
    target: { canonicalName: string } | null; targetRaw: string | null;
    dealValueUsd: number | null; statusAtAnnouncement: string;
  } | null;
  partnershipDetails: {
    partnershipType: string | null;
    entityA: { canonicalName: string } | null; entityARaw: string | null;
    entityB: { canonicalName: string } | null; entityBRaw: string | null;
  } | null;
  orgChangeDetails: {
    orgEventType: string | null; personName: string | null;
  } | null;
}): EventSummary {
  const cd = e.contractDetails;
  const ma = e.maDetails;
  const pt = e.partnershipDetails;
  const oc = e.orgChangeDetails;
  return {
    id: e.id,
    family: e.family,
    eventType: e.eventType,
    canonicalTitle: e.canonicalTitle,
    announcementDate: e.announcementDate?.toISOString() ?? null,
    geography: JSON.parse(e.geography) as string[],
    industry: e.industry,
    confidenceScore: e.confidenceScore,
    commercialRelevanceScore: e.commercialRelevanceScore,
    publicationStatus: e.publicationStatus,
    analystInsight: e.analystInsight,
    primaryEntityName: e.primaryEntity?.canonicalName ?? null,
    primaryEntitySlug: e.primaryEntity?.slug ?? null,
    // contract
    vendorName: cd?.vendor?.canonicalName ?? cd?.vendorRaw ?? null,
    clientName: cd?.client?.canonicalName ?? cd?.clientRaw ?? null,
    clientAnonymised: cd?.clientAnonymised ?? false,
    clientDescriptor: cd?.clientDescriptor ?? null,
    tcvCommittedUsd: cd?.tcvCommittedUsd ?? null,
    tcvEstimateMidUsd: cd?.tcvEstimateMidUsd ?? null,
    tcvIsEstimate: cd?.tcvIsEstimate ?? false,
    tcvBasis: cd?.tcvBasis ?? null,
    contractEventType: cd?.contractEventType ?? null,
    primaryMacroServiceLine: cd?.primaryMacroServiceLine ?? null,
    contractLengthMonths: cd?.contractLengthMonths ?? null,
    // m&a
    acquirerName: ma?.acquirer?.canonicalName ?? ma?.acquirerRaw ?? null,
    targetName: ma?.target?.canonicalName ?? ma?.targetRaw ?? null,
    dealValueUsd: ma?.dealValueUsd ?? null,
    maEventType: ma?.maEventType ?? null,
    maStatus: ma?.statusAtAnnouncement ?? null,
    // partnership
    partnerAName: pt?.entityA?.canonicalName ?? pt?.entityARaw ?? null,
    partnerBName: pt?.entityB?.canonicalName ?? pt?.entityBRaw ?? null,
    partnershipType: pt?.partnershipType ?? null,
    // org
    personName: oc?.personName ?? null,
    orgEventType: oc?.orgEventType ?? null,
    // source
    originalArticleUrl: e.originalArticleUrl ?? null,
  };
}

const eventInclude = {
  primaryEntity: { select: { canonicalName: true, slug: true } },
  contractDetails: {
    select: {
      vendorRaw: true, vendor: { select: { canonicalName: true } },
      clientRaw: true, client: { select: { canonicalName: true } },
      clientAnonymised: true, clientDescriptor: true,
      tcvCommittedUsd: true, tcvEstimateMidUsd: true, tcvIsEstimate: true, tcvBasis: true,
      contractEventType: true, primaryMacroServiceLine: true, contractLengthMonths: true,
    },
  },
  maDetails: {
    select: {
      maEventType: true,
      acquirer: { select: { canonicalName: true } }, acquirerRaw: true,
      target: { select: { canonicalName: true } }, targetRaw: true,
      dealValueUsd: true, statusAtAnnouncement: true,
    },
  },
  partnershipDetails: {
    select: {
      partnershipType: true,
      entityA: { select: { canonicalName: true } }, entityARaw: true,
      entityB: { select: { canonicalName: true } }, entityBRaw: true,
    },
  },
  orgChangeDetails: { select: { orgEventType: true, personName: true } },
} as const;

export async function getEvents(filters: EventFilters = {}): Promise<EventsResponse> {
  const { family, vendor, industry, geography, status, search, dateFrom, dateTo, page = 1, pageSize = 25 } = filters;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { publicationStatus: { not: "excluded_noise" } };

  if (family && family !== "all") where.family = family;
  if (status && status !== "all") where.publicationStatus = status;
  if (industry) where.industry = { contains: industry };
  if (dateFrom || dateTo) {
    where.announcementDate = {};
    if (dateFrom) where.announcementDate.gte = new Date(dateFrom);
    if (dateTo) where.announcementDate.lte = new Date(dateTo);
  }
  if (geography) where.geography = { contains: geography };
  if (search) {
    where.OR = [
      { canonicalTitle: { contains: search } },
      { contractDetails: { vendorRaw: { contains: search } } },
      { contractDetails: { clientRaw: { contains: search } } },
    ];
  }
  if (vendor) {
    where.OR = [
      { primaryEntity: { slug: vendor } },
      { contractDetails: { vendor: { slug: vendor } } },
      { maDetails: { acquirer: { slug: vendor } } },
      { partnershipDetails: { entityA: { slug: vendor } } },
      { partnershipDetails: { entityB: { slug: vendor } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.canonicalMarketEvent.count({ where }),
    prisma.canonicalMarketEvent.findMany({
      where,
      include: eventInclude,
      orderBy: { announcementDate: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    events: rows.map(shapeEvent),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalEvents, contractsCount, maCount, partnershipCount, newOfferingCount, orgChangeCount,
    needsReviewCount, last30DaysCount, topVendorRows, topIndustryRows, recentRows, monthlyRows,
    latestEventRow,
  ] = await Promise.all([
    prisma.canonicalMarketEvent.count({ where: { publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { family: "CONTRACT", publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { family: "M_AND_A", publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { family: "PARTNERSHIP", publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { family: "NEW_OFFERING", publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { family: "ORG_CHANGE", publicationStatus: "published" } }),
    prisma.canonicalMarketEvent.count({ where: { publicationStatus: "needs_review" } }),
    prisma.canonicalMarketEvent.count({ where: { announcementDate: { gte: thirtyDaysAgo }, publicationStatus: "published" } }),
    prisma.entity.findMany({
      where: { entityType: { in: ["vendor", "both"] } },
      include: { _count: { select: { primaryEvents: true } } },
      orderBy: { primaryEvents: { _count: "desc" } },
      take: 8,
    }),
    prisma.canonicalMarketEvent.groupBy({
      by: ["industry"],
      where: { industry: { not: null }, publicationStatus: "published" },
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
      take: 8,
    }),
    prisma.canonicalMarketEvent.findMany({
      where: { publicationStatus: "published" },
      include: eventInclude,
      orderBy: { announcementDate: "desc" },
      take: 8,
    }),
    // Monthly trend - last 18 months
    prisma.canonicalMarketEvent.findMany({
      where: {
        publicationStatus: "published",
        announcementDate: { gte: new Date(Date.now() - 548 * 24 * 60 * 60 * 1000) },
      },
      select: { announcementDate: true, family: true },
    }),
    // Latest event date for freshness indicator
    prisma.canonicalMarketEvent.findFirst({
      where: { publicationStatus: "published", announcementDate: { not: null } },
      orderBy: { announcementDate: "desc" },
      select: { announcementDate: true },
    }),
  ]);

  // Build monthly trend buckets
  const trendMap = new Map<string, { CONTRACT: number; M_AND_A: number; PARTNERSHIP: number; NEW_OFFERING: number; ORG_CHANGE: number }>();
  for (const e of monthlyRows) {
    if (!e.announcementDate) continue;
    const key = e.announcementDate.toISOString().slice(0, 7); // YYYY-MM
    if (!trendMap.has(key)) trendMap.set(key, { CONTRACT: 0, M_AND_A: 0, PARTNERSHIP: 0, NEW_OFFERING: 0, ORG_CHANGE: 0 });
    const bucket = trendMap.get(key)!;
    if (e.family in bucket) bucket[e.family as keyof typeof bucket]++;
  }
  const familyTrend = Array.from(trendMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({
      month: new Date(month + "-01").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
      ...counts,
    }));

  return {
    totalEvents,
    contractsCount,
    maCount,
    partnershipCount,
    newOfferingCount,
    orgChangeCount,
    needsReviewCount,
    last30DaysCount,
    latestEventDate: latestEventRow?.announcementDate?.toISOString() ?? null,
    topVendors: topVendorRows.map((v) => ({ name: v.canonicalName, slug: v.slug, count: v._count.primaryEvents })),
    topIndustries: topIndustryRows.map((r) => ({ industry: r.industry!, count: r._count.id })),
    recentEvents: recentRows.map(shapeEvent),
    familyTrend,
  };
}

export async function getVendorProfile(slug: string): Promise<VendorProfile | null> {
  const entity = await prisma.entity.findUnique({
    where: { slug },
    include: {
      primaryEvents: {
        where: { publicationStatus: "published" },
        include: eventInclude,
        orderBy: { announcementDate: "desc" },
        take: 20,
      },
    },
  });
  if (!entity) return null;

  const eventCounts: Record<string, number> = {};
  for (const e of entity.primaryEvents) {
    eventCounts[e.family] = (eventCounts[e.family] ?? 0) + 1;
  }

  return {
    id: entity.id,
    canonicalName: entity.canonicalName,
    displayName: entity.displayName,
    slug: entity.slug,
    regions: JSON.parse(entity.regions) as string[],
    websiteUrl: entity.websiteUrl,
    eventCounts,
    totalEvents: entity.primaryEvents.length,
    recentEvents: entity.primaryEvents.map(shapeEvent),
  };
}

export async function getAllVendors() {
  return prisma.entity.findMany({
    where: { entityType: { in: ["vendor", "both"] }, isActive: true },
    select: { canonicalName: true, displayName: true, slug: true },
    orderBy: { canonicalName: "asc" },
  });
}
