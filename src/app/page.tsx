import { connection } from "next/server";
import { getDashboardStats } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FamilyBadge } from "@/components/market/FamilyBadge";
import { EventCard } from "@/components/market/EventCard";
import { FamilyTrendChart, TopVendorsChart } from "@/components/market/DashboardCharts";
import { formatDate } from "@/lib/types";
import { Activity, FileText, TrendingUp, GitMerge, Handshake, Lightbulb, Users, ArrowRight, Zap } from "lucide-react";
import Link from "next/link";

export default async function DashboardPage() {
  // Opt out of prerendering — these KPIs are read from the DB and would
  // otherwise be frozen at build time and never reflect new ingestion.
  await connection();
  const stats = await getDashboardStats();

  const familyCounts = [
    { family: "CONTRACT", count: stats.contractsCount, icon: FileText, label: "Contracts", color: "from-blue-500/20 to-blue-500/5 border-blue-500/20" },
    { family: "M_AND_A", count: stats.maCount, icon: GitMerge, label: "M&A", color: "from-orange-500/20 to-orange-500/5 border-orange-500/20" },
    { family: "PARTNERSHIP", count: stats.partnershipCount, icon: Handshake, label: "Partnerships", color: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/20" },
    { family: "NEW_OFFERING", count: stats.newOfferingCount, icon: Lightbulb, label: "New Offerings", color: "from-violet-500/20 to-violet-500/5 border-violet-500/20" },
    { family: "ORG_CHANGE", count: stats.orgChangeCount, icon: Users, label: "Org Changes", color: "from-pink-500/20 to-pink-500/5 border-pink-500/20" },
  ];

  return (
    <div className="px-6 py-8 space-y-8">
      {/* Hero header */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Market Intelligence</h1>
          <p className="text-sm text-muted-foreground">
            Tracking {stats.totalEvents.toLocaleString()} events across 63 IT services providers
            {stats.last30DaysCount > 0 && (
              <span className="inline-flex items-center gap-1 ml-2 text-emerald-400">
                <Zap className="h-3 w-3" />
                {stats.last30DaysCount} new this month
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stats.needsReviewCount > 0 && (
            <Link href="/admin" className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-full hover:bg-amber-500/15 transition-colors">
              <Activity className="h-3 w-3" />
              {stats.needsReviewCount} pending review
            </Link>
          )}
          <Link href="/events" className="flex items-center gap-1.5 text-xs bg-foreground/[0.06] hover:bg-foreground/[0.1] px-3 py-1.5 rounded-full transition-colors font-medium">
            Open Tracker
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-5 gap-3">
        {familyCounts.map(({ family, count, icon: Icon, label, color }) => (
          <Link key={family} href={`/events?family=${family}`}>
            <Card className={`bg-gradient-to-b ${color} border hover:border-foreground/10 transition-all cursor-pointer group`}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center justify-between mb-3">
                  <FamilyBadge family={family} className="text-[10px]" />
                  <Icon className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors" />
                </div>
                <div className="text-3xl font-bold tabular-nums tracking-tight">{count.toLocaleString()}</div>
                <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="col-span-2 bg-card/50 border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Event Volume by Month</CardTitle>
          </CardHeader>
          <CardContent>
            <FamilyTrendChart stats={stats} />
          </CardContent>
        </Card>
        <Card className="bg-card/50 border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Top Vendors</CardTitle>
          </CardHeader>
          <CardContent>
            <TopVendorsChart stats={stats} />
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Latest Events</h2>
            <Link href="/events" className="text-xs text-muted-foreground/60 hover:text-foreground transition-colors flex items-center gap-1">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          <div className="space-y-2">
            {stats.recentEvents.slice(0, 8).map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </div>

        <div className="space-y-4">
          <Card className="bg-card/50 border-border/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Top Industries</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {stats.topIndustries.map(({ industry, count }, i) => (
                <div key={industry} className="flex items-center gap-3">
                  <span className="text-[10px] text-muted-foreground/40 w-3 tabular-nums">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground truncate">{industry}</span>
                      <span className="font-mono font-medium ml-2 shrink-0">{count}</span>
                    </div>
                    <div className="mt-1 h-1 rounded-full bg-foreground/[0.06] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500/40"
                        style={{ width: `${(count / (stats.topIndustries[0]?.count || 1)) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="bg-card/50 border-border/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Most Active Vendors</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {stats.topVendors.slice(0, 8).map(({ name, slug, count }, i) => (
                <Link
                  key={slug}
                  href={`/vendors/${slug}`}
                  className="flex items-center justify-between text-xs group py-0.5"
                >
                  <span className="text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/40 w-3 tabular-nums">{i + 1}</span>
                    {name}
                  </span>
                  <span className="font-mono font-medium text-muted-foreground/60">{count}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
