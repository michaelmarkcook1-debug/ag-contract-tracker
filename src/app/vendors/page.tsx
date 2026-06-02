import { getAllVendors } from "@/lib/data";
import { prisma } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";
import { FamilyBadge } from "@/components/market/FamilyBadge";
import Link from "next/link";
import { Globe, ArrowRight } from "lucide-react";

export default async function VendorsPage() {
  const vendors = await getAllVendors();

  // Get event counts per vendor
  const counts = await prisma.canonicalMarketEvent.groupBy({
    by: ["primaryEntityId"],
    where: { publicationStatus: "published", primaryEntityId: { not: null } },
    _count: { id: true },
  });
  const countMap = new Map(counts.map((c) => [c.primaryEntityId, c._count.id]));

  // Per-family counts
  const familyCounts = await prisma.canonicalMarketEvent.groupBy({
    by: ["primaryEntityId", "family"],
    where: { publicationStatus: "published", primaryEntityId: { not: null } },
    _count: { id: true },
  });
  const familyMap = new Map<string, Record<string, number>>();
  for (const fc of familyCounts) {
    if (!fc.primaryEntityId) continue;
    const existing = familyMap.get(fc.primaryEntityId) ?? {};
    existing[fc.family] = fc._count.id;
    familyMap.set(fc.primaryEntityId, existing);
  }

  const vendorDetails = await prisma.entity.findMany({
    where: { slug: { in: vendors.map((v) => v.slug) } },
    select: { id: true, slug: true, regions: true },
  });
  const regionMap = new Map(vendorDetails.map((v) => [v.slug, JSON.parse(v.regions) as string[]]));
  const idMap = new Map(vendorDetails.map((v) => [v.slug, v.id]));

  const sorted = [...vendors].sort((a, b) => (countMap.get(idMap.get(b.slug) ?? "") ?? 0) - (countMap.get(idMap.get(a.slug) ?? "") ?? 0));

  return (
    <div className="p-6 space-y-5 max-w-7xl">
      <div>
        <h1 className="text-xl font-semibold">Vendors</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{vendors.length} tracked IT services vendors</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((vendor) => {
          const entityId = idMap.get(vendor.slug);
          const total = entityId ? (countMap.get(entityId) ?? 0) : 0;
          const families = entityId ? (familyMap.get(entityId) ?? {}) : {};
          const regions = regionMap.get(vendor.slug) ?? [];

          return (
            <Link key={vendor.slug} href={`/vendors/${vendor.slug}`}>
              <Card className="bg-card border-border hover:border-zinc-600 transition-colors group h-full">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold group-hover:text-foreground transition-colors">{vendor.displayName}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Globe className="h-3 w-3" />
                        {regions.slice(0, 2).join(", ")}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground group-hover:text-foreground transition-colors">
                      <span className="text-lg font-bold tabular-nums">{total}</span>
                      <ArrowRight className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(families).map(([family, count]) => (
                      <div key={family} className="flex items-center gap-1">
                        <FamilyBadge family={family} className="text-[10px] py-0" />
                        <span className="text-[10px] text-muted-foreground">{count}</span>
                      </div>
                    ))}
                    {total === 0 && <span className="text-xs text-zinc-600">No events yet</span>}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
