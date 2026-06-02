import { notFound } from "next/navigation";
import { getVendorProfile } from "@/lib/data";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FamilyBadge } from "@/components/market/FamilyBadge";
import { EventCard } from "@/components/market/EventCard";
import { FAMILY_LABELS, formatTcv } from "@/lib/types";
import { Globe, ExternalLink } from "lucide-react";

export default async function VendorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const vendor = await getVendorProfile(slug);
  if (!vendor) notFound();

  const totalTcv = vendor.recentEvents
    .filter((e) => e.family === "CONTRACT")
    .reduce((sum, e) => sum + (e.tcvCommittedUsd ?? e.tcvEstimateMidUsd ?? 0), 0);

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{vendor.displayName}</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Globe className="h-3.5 w-3.5" />
              {vendor.regions.join(", ")}
            </span>
            {vendor.websiteUrl && (
              <a href={vendor.websiteUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
                {vendor.websiteUrl.replace(/^https?:\/\//, "")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold tabular-nums">{vendor.totalEvents}</div>
          <div className="text-xs text-muted-foreground">tracked events</div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Object.entries(vendor.eventCounts).map(([family, count]) => (
          <Card key={family} className="bg-card border-border">
            <CardContent className="pt-3 pb-3">
              <FamilyBadge family={family} className="mb-2 text-[10px]" />
              <div className="text-xl font-bold tabular-nums">{count}</div>
              <p className="text-xs text-muted-foreground">{FAMILY_LABELS[family as keyof typeof FAMILY_LABELS] ?? family}</p>
            </CardContent>
          </Card>
        ))}
        {totalTcv > 0 && (
          <Card className="bg-emerald-500/5 border-emerald-500/20">
            <CardContent className="pt-3 pb-3">
              <div className="text-[10px] text-emerald-500 font-medium mb-2 uppercase tracking-wide">Contract TCV</div>
              <div className="text-xl font-bold tabular-nums text-emerald-400">{formatTcv(totalTcv, false)}</div>
              <p className="text-xs text-muted-foreground">visible value</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Event timeline */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Event Timeline</h2>
          <span className="text-xs text-muted-foreground">{vendor.recentEvents.length} recent events</span>
        </div>

        {/* Group by family */}
        {(["CONTRACT", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE"] as const).map((family) => {
          const events = vendor.recentEvents.filter((e) => e.family === family);
          if (events.length === 0) return null;
          return (
            <div key={family} className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <FamilyBadge family={family} />
                <span className="text-xs text-muted-foreground">{events.length} event{events.length !== 1 ? "s" : ""}</span>
              </div>
              <div className="space-y-2 pl-1">
                {events.map((event) => <EventCard key={event.id} event={event} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
