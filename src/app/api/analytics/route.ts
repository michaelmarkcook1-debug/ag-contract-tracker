import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { trackedEventScope } from "@/lib/data";

// Contract value for aggregation: the disclosed figure when there is one,
// otherwise the midpoint of an APPROVED estimate range (comparable engine or the
// extraction model's labelled range — tcv/infer.ts). Older single-number guesses
// carry other bases and stay out. Every KPI that sums or averages uses this, and
// reports how many values are disclosed vs estimated.
const TCV = Prisma.raw(`COALESCE(cd."tcvCommittedUsd", CASE WHEN cd."tcvIsEstimate" AND (cd."tcvBasis" LIKE 'comparable_inferred_v%' OR cd."tcvBasis" LIKE 'model_estimated_v2%') THEN cd."tcvEstimateMidUsd" END)`);

export interface AnalyticsData {
  // Summary KPIs
  totalDeals: number;
  totalTcvBn: number;
  avgTcvM: number;
  medianTcvM: number;
  /** Contracts with a value (disclosed or approved estimate). */
  dealsWithTcv: number;
  dealsDisclosed: number;
  dealsEstimated: number;

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

/** Median, total, mean and disclosed/estimated counts over published contracts' values. */
async function getTcvSummary(): Promise<{ medianM: number; totalBn: number; avgM: number; withTcv: number; disclosed: number; estimated: number }> {
  const rows = await prisma.$queryRaw<{ v: number | null; disclosed: boolean }[]>`
    SELECT ${TCV} v, cd."tcvCommittedUsd" IS NOT NULL disclosed
    FROM "ContractDetails" cd
    JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
    WHERE cme."publicationStatus"='published'
  `;
  const vals = rows.map(r => r.v).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const disclosed = rows.filter(r => r.disclosed).length;
  const total = vals.reduce((s, v) => s + v, 0);
  return {
    medianM: vals.length ? vals[Math.floor(vals.length / 2)] / 1_000_000 : 0,
    totalBn: total / 1_000_000_000,
    avgM: vals.length ? total / vals.length / 1_000_000 : 0,
    withTcv: vals.length,
    disclosed,
    estimated: vals.length - disclosed,
  };
}

// Geography is stored as JSON array — extract with raw SQL grouping
async function getTopGeographies(): Promise<{ region: string; count: number }[]> {
  const scope = await trackedEventScope();
  // Use prisma raw to get the geography JSON arrays and count in app
  const rows = await prisma.canonicalMarketEvent.findMany({
    where: { publicationStatus: "published", NOT: { geography: "[]" }, ...scope },
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
  // Scope every metric to the tracked vendor universe.
  const scope = await trackedEventScope();
  const [
    totalDeals,
    byYearRaw, topVendorsByTcvRaw, topVendorsByDealsRaw,
    serviceLinesRaw, topIndustriesRaw, eventTypesRaw,
    monthlyRaw, tcvSummary, topGeographies,
  ] = await Promise.all([
    // Total deals
    prisma.canonicalMarketEvent.count({ where: { family: "CONTRACT", publicationStatus: "published", ...scope } }),
    // By year
    prisma.$queryRaw<{ yr: string; deals: bigint; tcv: number; avgtcv: number }[]>`
      SELECT TO_CHAR(cme."announcementDate", 'YYYY') yr,
             COUNT(*) deals,
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv,
             COALESCE(AVG(${TCV}),0)/1000000.0 avgtcv
      FROM "CanonicalMarketEvent" cme
      LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId" = cme.id
      WHERE cme.family='CONTRACT' AND cme."publicationStatus"='published'
        AND cme."announcementDate" IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `,
    // Top vendors by TCV
    prisma.$queryRaw<{ name: string; slug: string; deals: bigint; tcv: number }[]>`
      SELECT e."canonicalName" name, e.slug, COUNT(*) deals,
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv
      FROM "Entity" e
      JOIN "ContractDetails" cd ON cd."vendorId" = e.id
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published' AND ${TCV} IS NOT NULL
        AND ${TCV} < 10000000000
      GROUP BY e.id ORDER BY tcv DESC LIMIT 20
    `,
    // Top vendors by deal count
    prisma.$queryRaw<{ name: string; slug: string; deals: bigint; tcv: number }[]>`
      SELECT e."canonicalName" name, e.slug, COUNT(*) deals,
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv
      FROM "Entity" e
      JOIN "ContractDetails" cd ON cd."vendorId" = e.id
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published'
      GROUP BY e.id ORDER BY deals DESC LIMIT 20
    `,
    // Service lines
    prisma.$queryRaw<{ line: string; deals: bigint; tcv: number }[]>`
      SELECT cd."primaryMacroServiceLine" line, COUNT(*) deals,
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv
      FROM "ContractDetails" cd
      JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
      WHERE cme."publicationStatus"='published' AND cd."primaryMacroServiceLine" IS NOT NULL
      GROUP BY cd."primaryMacroServiceLine" ORDER BY deals DESC LIMIT 10
    `,
    // Top industries
    prisma.$queryRaw<{ industry: string; deals: bigint; tcv: number }[]>`
      SELECT cme.industry, COUNT(*) deals,
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv
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
             COALESCE(SUM(${TCV}),0)/1000000000.0 tcv
      FROM "CanonicalMarketEvent" cme
      LEFT JOIN "ContractDetails" cd ON cd."canonicalEventId" = cme.id
      WHERE cme.family='CONTRACT' AND cme."publicationStatus"='published'
        AND cme."announcementDate" >= NOW() - INTERVAL '24 months'
      GROUP BY 1 ORDER BY 1
    `,
    getTcvSummary(),
    getTopGeographies(),
  ]);

  const totalTcvBn = tcvSummary.totalBn;
  const avgTcvM = tcvSummary.avgM;
  const medianTcvM = tcvSummary.medianM;
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
      WHEN ${TCV} < 10000000    THEN 'Under $10m'
      WHEN ${TCV} < 50000000    THEN '$10–50m'
      WHEN ${TCV} < 100000000   THEN '$50–100m'
      WHEN ${TCV} < 500000000   THEN '$100–500m'
      WHEN ${TCV} < 1000000000  THEN '$500m–$1bn'
      ELSE 'Over $1bn'
    END bucket, COUNT(*) cnt
    FROM "ContractDetails" cd
    JOIN "CanonicalMarketEvent" cme ON cme.id = cd."canonicalEventId"
    WHERE cme."publicationStatus"='published' AND ${TCV} IS NOT NULL
    GROUP BY 1
  `;
  const sizeMap = new Map(sizeCounts.map(r => [r.bucket, Number(r.cnt)]));

  const data: AnalyticsData = {
    totalDeals,
    totalTcvBn,
    avgTcvM,
    medianTcvM,
    dealsWithTcv: tcvSummary.withTcv,
    dealsDisclosed: tcvSummary.disclosed,
    dealsEstimated: tcvSummary.estimated,
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
