import { getDashboardStats } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FamilyBadge } from "@/components/market/FamilyBadge";
import { EventCard } from "@/components/market/EventCard";
import { FamilyTrendChart, TopVendorsChart } from "@/components/market/DashboardCharts";
import { formatDate } from "@/lib/types";
import { Activity, FileText, TrendingUp, GitMerge, Handshake, Lightbulb, Users } from "lucide-react";
import Link from "next/link";

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  const familyCounts = [
    { family: "CONTRACT", count: stats.contractsCount, icon: FileText, label: "Contracts" },
    { family: "M_AND_A", count: stats.maCount, icon: GitMerge, label: "M&A" },
    { family: "PARTNERSHIP", count: stats.partnershipCount, icon: Handshake, label: "Partnerships" },
    { family: "NEW_OFFERING", count: stats.newOfferingCount, icon: Lightbulb, label: "New Offerings" },
    { family: "ORG_CHANGE", count: stats.orgChangeCount, icon: Users, label: "Org Changes" },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Market Intelligence Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {stats.totalEvents.toLocaleString()} published events
            {stats.last30DaysCount > 0
              ? ` · ${stats.last30DaysCount} in the last 30 days`
              : stats.latestEventDate
              ? ` · Latest data: ${formatDate(stats.latestEventDate)}`
              : ""}
          </p>
        </div>
        {stats.needsReviewCount > 0 && (
          <Link href="/admin" className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-full hover:bg-amber-500/15 transition-colors">
            <Activity className="h-3 w-3" />
            {stats.needsReviewCount} pending review
          </Link>
        )}
      </div>

      {/* Family stat cards */}
      <div className="grid grid-cols-5 gap-3">
        {familyCounts.map(({ family, count, icon: Icon, label }) => (
          <Card key={family} className="bg-card border-border">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center justify-between mb-2">
                <FamilyBadge family={family} className="text-[10px]" />
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="text-2xl font-bold tabular-nums">{count}</div>
              <p className="text-xs text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2 bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Event Volume by Month</CardTitle>
          </CardHeader>
          <CardContent>
            <FamilyTrendChart stats={stats} />
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Vendors by Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <TopVendorsChart stats={stats} />
          </CardContent>
        </Card>
      </div>

      {/* Bottom row: recent events + industry breakdown */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent Events</h2>
            <Link href="/events" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              View all →
            </Link>
          </div>
          <div className="space-y-2">
            {stats.recentEvents.slice(0, 6).map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </div>

        <div className="space-y-4">
          {/* Top industries */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Top Industries</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stats.topIndustries.map(({ industry, count }) => (
                <div key={industry} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{industry}</span>
                  <span className="font-mono font-medium">{count}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Top vendors list */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Most Active Vendors</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {stats.topVendors.slice(0, 6).map(({ name, slug, count }, i) => (
                <div key={slug} className="flex items-center justify-between text-xs">
                  <Link href={`/vendors/${slug}`} className="text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5">
                    <span className="text-zinc-600 w-3 tabular-nums">{i + 1}</span>
                    {name}
                  </Link>
                  <span className="font-mono font-medium">{count}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Coverage note */}
          <Card className="bg-zinc-900/50 border-zinc-800">
            <CardContent className="pt-4 pb-3">
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                All events are sourced from public announcements. No paid data sources. Every record links to its original article. Confidence scores reflect extraction and classification quality.
              </p>
              <p className="text-[10px] text-zinc-600 mt-1">Last updated: {formatDate(new Date().toISOString())}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
