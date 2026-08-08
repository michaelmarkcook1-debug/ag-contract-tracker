import { connection } from "next/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AnnualTrendChart, VendorTcvChart, VendorCountChart,
  ServiceLineChart, DealSizeChart, GeographyChart,
  EventTypePie, MonthlyMomentumChart, IndustryChart,
} from "@/components/market/AnalyticsCharts";
import type { AnalyticsData } from "@/app/api/analytics/route";
import { TrendingUp, DollarSign, FileText, BarChart3 } from "lucide-react";

async function getAnalytics(): Promise<AnalyticsData> {
  // Direct DB call — same as API route but avoids HTTP round-trip
  const { GET } = await import("@/app/api/analytics/route");
  const res = await GET();
  return res.json();
}

function KpiCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string; sub: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Icon className={`h-3.5 w-3.5 ${color}`} />
        </div>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
      </CardContent>
    </Card>
  );
}

export default async function AnalyticsPage() {
  // Opt out of prerendering — every chart below is DB-derived.
  await connection();
  const data = await getAnalytics();

  const tcvCoverage = Math.round((data.dealsWithTcv / data.totalDeals) * 100);

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">Market Analytics</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          IT services contract market — {data.totalDeals.toLocaleString()} deals, 2020–2026
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Total Visible TCV" value={`$${data.totalTcvBn.toFixed(1)}bn`} sub={`${tcvCoverage}% of deals have TCV`} icon={DollarSign} color="text-emerald-400" />
        <KpiCard label="Total Deals" value={data.totalDeals.toLocaleString()} sub="published contract records" icon={FileText} color="text-blue-400" />
        <KpiCard label="Avg Deal Value" value={`$${data.avgTcvM.toFixed(0)}m`} sub={`median $${data.medianTcvM.toFixed(0)}m`} icon={TrendingUp} color="text-amber-400" />
        <KpiCard label="Largest Single Deal" value={`$${data.topVendorsByTcv[0]?.tcvBn.toFixed(1) ?? "—"}bn`} sub={data.topVendorsByTcv[0]?.vendor ?? "—"} icon={BarChart3} color="text-violet-400" />
      </div>

      {/* Annual trend */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Annual Deal Volume & TCV</CardTitle>
          <p className="text-xs text-muted-foreground">Bars = deal count (left axis) · Line = cumulative TCV in $bn (right axis)</p>
        </CardHeader>
        <CardContent>
          <AnnualTrendChart data={data.byYear} />
          <p className="text-[10px] text-zinc-600 mt-2">Note: 2025 TCV spike driven by a small number of large cloud/AI platform contracts (AWS, CoreWeave). Deal count trend is the more representative signal.</p>
        </CardContent>
      </Card>

      {/* Monthly momentum */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Monthly Momentum — Last 24 Months</CardTitle>
        </CardHeader>
        <CardContent>
          <MonthlyMomentumChart data={data.monthlyMomentum} />
        </CardContent>
      </Card>

      {/* Vendor league tables */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Vendors by Contract Value</CardTitle>
            <p className="text-xs text-muted-foreground">Disclosed TCV only · $bn cumulative 2020–2026</p>
          </CardHeader>
          <CardContent>
            <VendorTcvChart data={data.topVendorsByTcv} />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Vendors by Deal Count</CardTitle>
            <p className="text-xs text-muted-foreground">All published contracts 2020–2026</p>
          </CardHeader>
          <CardContent>
            <VendorCountChart data={data.topVendorsByDeals} />
          </CardContent>
        </Card>
      </div>

      {/* Service lines + Deal size */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Service Line Mix</CardTitle>
            <p className="text-xs text-muted-foreground">Deal count by primary macro service line</p>
          </CardHeader>
          <CardContent>
            <ServiceLineChart data={data.serviceLines} />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Deal Size Distribution</CardTitle>
            <p className="text-xs text-muted-foreground">Number of contracts by TCV band</p>
          </CardHeader>
          <CardContent>
            <DealSizeChart data={data.dealSizeBuckets} />
          </CardContent>
        </Card>
      </div>

      {/* Geography + Event types */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Geographic Coverage</CardTitle>
            <p className="text-xs text-muted-foreground">Events by signing region</p>
          </CardHeader>
          <CardContent>
            <GeographyChart data={data.topGeographies} />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Contract Event Types</CardTitle>
          </CardHeader>
          <CardContent>
            <EventTypePie data={data.eventTypes} />
          </CardContent>
        </Card>
      </div>

      {/* Industry breakdown */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Industry Breakdown</CardTitle>
          <p className="text-xs text-muted-foreground">Deals by buyer industry</p>
        </CardHeader>
        <CardContent>
          <IndustryChart data={data.topIndustries} />
        </CardContent>
      </Card>
    </div>
  );
}
