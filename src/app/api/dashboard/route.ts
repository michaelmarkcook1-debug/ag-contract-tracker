import { NextResponse } from "next/server";
import { getDashboardStats } from "@/lib/data";

export async function GET() {
  try {
    const stats = await getDashboardStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("GET /api/dashboard", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
