import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export interface AnalyticsData {
  // Summary KPIs
  totalDeals: number;
  totalTcvBn: number;
  avgTcvM: number;
  medianTcvM: number;
  dealsWithTcv: number;

  // Time series: annual deal volume + TCV
  byYear: { year: string; deals: number; tcvBn: number; avgM: number }[];

  // Vendor league tables
  topVendorsByTcv: { vendor: string; slug: string; deals: number; tcvBn: number }[];
  topVendorsByDeals: { vendor: string; slug: string; deals: number; tcvBn: number }[];

  // Service line mix
  serviceLines: { line: string; deals: number; tcvBn: number; share: number }[];

  // Deal size distribution
  dealSizeBuckets: { bucket: string; count: number; order: number }[];

  // Geography
  topGeographies: { region: string; count: number }[];

  // Industry
  topIndustries: { industry: string; deals: number; tcvBn: number }[];

  // Contract event types
  eventTypes: { type: string; count: number }[];

  // Monthly momentum: last 24 months deal count
  monthlyMomentum: { month: string; deals: number; tcvBn: number }[];
}

// SQLite doesn't have PERCENTILE_CONT, so we approximate median via offset
async function getMedianTcv(): Promise<number> {
  const total = await prisma.contractDetails.count({
    where: { tcvCommittedUsd: { not: null }, canonicalEvent: { publicationStatus: "published" } },
  });
  if (total === 0) return 0;
  const mid = Math.floor(total / 2);
  const rows = await prisma.contractDetails.findMany({
    where: { tcvCommittedUsd: { not: null }, canonicalEvent: { publicationStatus: "published" } },
    orderBy: { tcvCommittedUsd: "asc" },
    skip: mid,
    take: 1,
    select: { tcvCommittedUsd: true },
  });
  return (rows[0]?.tcvCommittedUsd ?? 0) / 1_000_000;
}

// Geography is stored as JSON array — extract with raw SQL grouping
async function getTopGeographies(): Promise<{ region: string; count: number }[]> {
  // Use prisma raw to get the geography JSON arrays and count in app
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "published", NOT: { geography: "[]" } },
    select: { geography: true },
    take: 5000,
  });
  const counter: Record<string, number> = {};
  for (const { geography } of rows) {
    try {
      const geos: string[] = JSON.parse(geography);
      for (const g of geos) {
        // Normalise: collapse sub-regions
        const norm = g
          .replace("Western Europe", "Europe")
          .replace("Eastern Europe", "Europe")
          .replace("Asia-Pacific", "Asia / Pacific")
          .replace("South & Central America", "Latin America")
          .replace("Oceania", "Australia / Pacific");
        counter[norm] = (counter[norm] ?? 0) + 1;
      }
    } catch { /* skip */ }
  }
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([region, count]) => ({ region, count }));
}

export async function GET() {
  const [
    totalDeals, dealsWithTcv, tcvAgg,
    byYearRaw, topVendorsByTcvRaw, topVendorsByDealsRaw,
    serviceLinesRaw, topIndustriesRaw, eventTypesRaw,
    monthlyRaw, medianTcvM, topGeographies,
  ] = await Promise.all([
    // Total deals
    prisma.canonicalMarketEvent.count({ where: { family: "CONTRACT", publicationStatus: "published" } }),
    // Deals with TCV
    prisma.contractDetails.count({ where: { tcvCommittedUsd: { not: null }, canonicalEvent: { publicationStatus: "published" } } }),
    // TCV aggregate
    prisma.contractDetails.aggregate({
      where: { tcvCommittedUsd: { not: null }, canonicalEvent: { publicationStatus: "published" } },
      _sum: { tcvCommittedUsd: true },
      _avg: { tcvCommittedUsd: true },
    }),
    // By year
    prisma.$queryRaw<{ yr: string; deals: bigint; tcv: number; avgtcv: number }[]>`
      SELECT TO_CHAR(cme."announcementDate", 'YYYY') yr,
             COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv,
             COALESCE(AVG(cd."tcvCommittedUsd"),0)/1000000.0 avgtcv
      FROM "CanonicalMarketEvent" cme
      LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId" = cme.id
      WHERE cme.family='CONTRACT' AND cme."publicationStatus"='published'
        AND cme."announcementDate" IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `,
    // Top vendors by TCV
    prisma.$queryRaw<{ name: string; slug: string; deals: bigint; tcv: number }[]>`
      SELECT e."canonicalName" name, e.slug, COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv
      FROM "Entity" e
      JOIN "ContractDetails" cd ON cd."vendorId" = e.id
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published' AND cd."tcvCommittedUsd" IS NOT NULL
        AND cd."tcvCommittedUsd" < 10000000000
      GROUP BY e.id ORDER BY tcv DESC LIMIT 20
    `,
    // Top vendors by deal count
    prisma.$queryRaw<{ name: string; slug: string; deals: bigint; tcv: number }[]>`
      SELECT e."canonicalName" name, e.slug, COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv
      FROM "Entity" e
      JOIN "ContractDetails" cd ON cd."vendorId" = e.id
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published'
      GROUP BY e.id ORDER BY deals DESC LIMIT 20
    `,
    // Service lines
    prisma.$queryRaw<{ line: string; deals: bigint; tcv: number }[]>`
      SELECT cd."primaryMacroServiceLine" line, COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv
      FROM "ContractDetails" cd
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published' AND cd."primaryMacroServiceLine" IS NOT NULL
      GROUP BY cd."primaryMacroServiceLine" ORDER BY deals DESC LIMIT 10
    `,
    // Top industries
    prisma.$queryRaw<{ industry: string; deals: bigint; tcv: number }[]>`
      SELECT cme.industry, COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv
      FROM "CanonicalMarketEvent" cme
      LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId" = cme.id
      WHERE cme."publicationStatus"='published' AND cme.family='CONTRACT'
        AND cme.industry IS NOT NULL
      GROUP BY cme.industry ORDER BY deals DESC LIMIT 12
    `,
    // Event types
    prisma.$queryRaw<{ etype: string; cnt: bigint }[]>`
      SELECT COALESCE(cd."contractEventType",'unknown') etype, COUNT(*) cnt
      FROM "ContractDetails" cd
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published'
      GROUP BY cd."contractEventType" ORDER BY cnt DESC
    `,
    // Monthly momentum — last 24 months
    prisma.$queryRaw<{ ym: string; deals: bigint; tcv: number }[]>`
      SELECT TO_CHAR(cme."announcementDate", 'YYYY-MM') ym,
             COUNT(*) deals,
             COALESCE(SUM(cd."tcvCommittedUsd"),0)/1000000000.0 tcv
      FROM "CanonicalMarketEvent" cme
      LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId" = cme.id
      WHERE cme.family='CONTRACT' AND cme."publicationStatus"='published'
        AND cme."announcementDate" >= NOW() - INTERVAL '24 months'
      GROUP BY 1 ORDER BY 1
    `,
    getMedianTcv(),
    getTopGeographies(),
  ]);

  const totalTcvBn = (tcvAgg._sum.tcvCommittedUsd ?? 0) / 1_000_000_000;
  const avgTcvM = (tcvAgg._avg.tcvCommittedUsd ?? 0) / 1_000_000;
  const totalDealLines = serviceLinesRaw.reduce((s, r) => s + Number(r.deals), 0);

  const dealSizeBuckets = [
    { bucket: "Under $10m",   order: 1 },
    { bucket: "$10–50m",      order: 2 },
    { bucket: "$50–100m",     order: 3 },
    { bucket: "$100–500m",    order: 4 },
    { bucket: "$500m–$1bn",   order: 5 },
    { bucket: "Over $1bn",    order: 6 },
  ];
  const sizeCounts = await prisma.$queryRaw<{ bucket: string; cnt: bigint }[]>`
    SELECT CASE
      WHEN cd."tcvCommittedUsd" < 10000000    THEN 'Under $10m'
      WHEN cd."tcvCommittedUsd" < 50000000    THEN '$10–50m'
      WHEN cd."tcvCommittedUsd" < 100000000   THEN '$50–100m'
      WHEN cd."tcvCommittedUsd" < 500000000   THEN '$100–500m'
      WHEN cd."tcvCommittedUsd" < 1000000000  THEN '$500m–$1bn'
      ELSE 'Over $1bn'
    END bucket, COUNT(*) cnt
    FROM "ContractDetails" cd
    JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
    WHERE cme."publicationStatus"='published' AND cd."tcvCommittedUsd" IS NOT NULL
    GROUP BY 1
  `;
  const sizeMap = new Map(sizeCounts.map(r => [r.bucket, Number(r.cnt)]));

  const data: AnalyticsData = {
    totalDeals,
    totalTcvBn,
    avgTcvM,
    medianTcvM,
    dealsWithTcv,
    byYear: byYearRaw.map(r => ({ year: r.yr, deals: Number(r.deals), tcvBn: r.tcv, avgM: r.avgtcv })),
    topVendorsByTcv: topVendorsByTcvRaw.map(r => ({ vendor: r.name, slug: r.slug, deals: Number(r.deals), tcvBn: r.tcv })),
    topVendorsByDeals: topVendorsByDealsRaw.map(r => ({ vendor: r.name, slug: r.slug, deals: Number(r.deals), tcvBn: r.tcv })),
    serviceLines: serviceLinesRaw.map(r => ({ line: r.line, deals: Number(r.deals), tcvBn: r.tcv, share: Number(r.deals) / totalDealLines })),
    dealSizeBuckets: dealSizeBuckets.map(b => ({ ...b, count: sizeMap.get(b.bucket) ?? 0 })),
    topGeographies,
    topIndustries: topIndustriesRaw.map(r => ({ industry: r.industry, deals: Number(r.deals), tcvBn: r.tcv })),
    eventTypes: eventTypesRaw.map(r => ({ type: r.etype, count: Number(r.cnt) })),
    monthlyMomentum: monthlyRaw.map(r => ({ month: r.ym, deals: Number(r.deals), tcvBn: r.tcv })),
  };

  return NextResponse.json(data);
}
