import { NextRequest, NextResponse } from "next/server";
import { getRenewals, type RenewalFilters } from "@/lib/dealmaker/data";
import { WINDOWS, AUTOMATION_TIERS, TCV_BUCKETS, type WindowKey, type AutomationTier } from "@/lib/dealmaker/grades";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const SORTS = ["end", "tcv", "displacement", "renewal", "risk"] as const;
const ACTIONS = ["pitch", "defend", "monitor"] as const;

// GET /api/dealmaker/renewals — Deal Maker's Upcoming Renewals: KPIs, charts, facets and the filtered table.
// ?window=0-3,3-6 &vendor= &serviceLine= &region= &country= &industry= &action=pitch|defend|monitor &risk= &automation= &tcvBucket=
//  &q= &sort=end|tcv|displacement|renewal|risk &limit=
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const windows = (sp.get("window") ?? "").split(",").filter((w): w is WindowKey => WINDOWS.some(x => x.key === w));
  const sort = SORTS.find(s => s === sp.get("sort"));
  const action = ACTIONS.find(a => a === sp.get("action"));
  const filters: RenewalFilters = {
    windows, sort, action,
    vendor: sp.get("vendor") || undefined, serviceLine: sp.get("serviceLine") || undefined, region: sp.get("region") || undefined, country: sp.get("country") || undefined,
    risk: ["critical", "urgent", "concern", "standard", "positive"].find(r => r === sp.get("risk")),
    automation: AUTOMATION_TIERS.find(t => t === sp.get("automation")) as AutomationTier | undefined,
    tcvBucket: TCV_BUCKETS.find(t => t === sp.get("tcvBucket")),
    industry: sp.get("industry") || undefined, q: sp.get("q") || undefined,
    limit: sp.has("limit") ? Math.min(500, Math.max(1, Number(sp.get("limit")) || 200)) : 200,
  };
  try {
    return NextResponse.json(await getRenewals(filters));
  } catch (err) {
    console.error("GET /api/dealmaker/renewals", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
