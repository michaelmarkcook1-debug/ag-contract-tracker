import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  const runs = await prisma.ingestionRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return NextResponse.json(runs.map(r => ({
    ...r,
    errors: JSON.parse(r.errors || "[]"),
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  })));
}
