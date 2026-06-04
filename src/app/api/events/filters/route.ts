import { NextResponse } from "next/server";
import { getFilterOptions } from "@/lib/data";

export async function GET() {
  try {
    const options = await getFilterOptions();
    return NextResponse.json(options);
  } catch (err) {
    console.error("GET /api/events/filters", err);
    return NextResponse.json({ vendors: [], industries: [], serviceLines: [] });
  }
}
