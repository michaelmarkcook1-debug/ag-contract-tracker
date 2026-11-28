"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { DashboardStats, FAMILY_LABELS } from "@/lib/types";
import { FAMILY_SERIES, MAGNITUDE, TICK, TOOLTIP } from "@/lib/chart-theme";

interface Props {
  stats: DashboardStats;
}

const FAMILIES = ["CONTRACT", "FINANCIAL_RESULTS", "M_AND_A", "PARTNERSHIP", "NEW_OFFERING", "ORG_CHANGE"] as const;

/** Events per month, stacked by type. Six series: a legend is always shown (three hues are below 3:1 on white). */
export function FamilyTrendChart({ stats }: Props) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={stats.familyTrend} margin={{ top: 4, right: 0, left: -20, bottom: 0 }} barCategoryGap="18%">
        <XAxis dataKey="month" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis tick={TICK} axisLine={false} tickLine={false} />
        <Tooltip {...TOOLTIP} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          formatter={(value) => <span style={{ color: "var(--muted-foreground)" }}>{value}</span>} />
        {FAMILIES.map((f, i) => (
          // A thin surface-coloured stroke separates stacked segments; the top segment carries the rounded end.
          <Bar key={f} dataKey={f} stackId="a" fill={FAMILY_SERIES[f]} name={FAMILY_LABELS[f]} stroke="var(--card)" strokeWidth={1}
            radius={i === FAMILIES.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Events per vendor: one series, so one hue (the brand); rank is shown by length, never by colour. */
export function TopVendorsChart({ stats }: Props) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={stats.topVendors} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }} barCategoryGap="24%">
        <XAxis type="number" tick={TICK} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey="name" tick={{ ...TICK, fill: "var(--foreground)" }} axisLine={false} tickLine={false} width={96} />
        <Tooltip {...TOOLTIP} />
        <Bar dataKey="count" name="Events" fill={MAGNITUDE} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
