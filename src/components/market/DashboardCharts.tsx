"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { DashboardStats, FAMILY_LABELS } from "@/lib/types";

const FAMILY_CHART_COLORS: Record<string, string> = {
  CONTRACT: "#34d399",
  M_AND_A: "#a78bfa",
  PARTNERSHIP: "#60a5fa",
  NEW_OFFERING: "#fbbf24",
  ORG_CHANGE: "#fb7185",
};

interface Props {
  stats: DashboardStats;
}

export function FamilyTrendChart({ stats }: Props) {
  const families = ["CONTRACT", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE"] as const;

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={stats.familyTrend} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#71717a" }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: "#71717a" }} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: "#a1a1aa" }}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        {families.map((f) => (
          <Bar key={f} dataKey={f} stackId="a" fill={FAMILY_CHART_COLORS[f]} name={FAMILY_LABELS[f]} radius={f === "ORG_CHANGE" ? [2, 2, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TopVendorsChart({ stats }: Props) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={stats.topVendors} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={{ fontSize: 10, fill: "#71717a" }} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#a1a1aa" }} axisLine={false} tickLine={false} width={90} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #27272a", borderRadius: 6, fontSize: 12 }}
          cursor={{ fill: "rgba(255,255,255,0.04)" }}
        />
        <Bar dataKey="count" name="Events" radius={[0, 2, 2, 0]}>
          {stats.topVendors.map((_, i) => (
            <Cell key={i} fill={`hsl(${160 + i * 12}, 60%, 52%)`} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
