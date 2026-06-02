import { NextRequest, NextResponse } from "next/server";
import { getEvents } from "@/lib/data";
import { EventFilters, MarketEventFamily, PublicationStatus } from "@/lib/types";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const filters: EventFilters = {
    family: (sp.get("family") ?? "all") as MarketEventFamily | "all",
    vendor: sp.get("vendor") ?? undefined,
    industry: sp.get("industry") ?? undefined,
    geography: sp.get("geography") ?? undefined,
    status: (sp.get("status") ?? "all") as PublicationStatus | "all",
    search: sp.get("search") ?? undefined,
    dateFrom: sp.get("dateFrom") ?? undefined,
    dateTo: sp.get("dateTo") ?? undefined,
    page: sp.has("page") ? parseInt(sp.get("page")!) : 1,
    pageSize: sp.has("pageSize") ? Math.min(parseInt(sp.get("pageSize")!), 100) : 25,
  };

  try {
    const result = await getEvents(filters);
    return NextResponse.json(result);
  } catch (err) {
    console.error("GET /api/events", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
