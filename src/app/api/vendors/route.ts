import { NextResponse } from "next/server";
import { getAllVendors } from "@/lib/data";

export async function GET() {
  try {
    const vendors = await getAllVendors();
    return NextResponse.json(vendors);
  } catch (err) {
    console.error("GET /api/vendors", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
