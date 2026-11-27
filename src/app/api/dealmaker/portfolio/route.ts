import { NextResponse } from "next/server";
import { getPortfolio } from "@/lib/dealmaker/data";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// GET /api/dealmaker/portfolio — Deal Maker's Portfolio Assessment over every live contract that has not ended:
// risk, automation, AI and churn mix, and the 30 most critical contracts.
export async function GET() {
  try {
    return NextResponse.json(await getPortfolio());
  } catch (err) {
    console.error("GET /api/dealmaker/portfolio", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
