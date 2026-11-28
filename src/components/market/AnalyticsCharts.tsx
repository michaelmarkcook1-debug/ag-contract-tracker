"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, PieChart, Pie, Legend,
} from "recharts";
import type { AnalyticsData } from "@/app/api/analytics/route";
import Link from "next/link";
import { SERIES, SERIES_OTHER, MAGNITUDE, TICK as THEME_TICK, TOOLTIP, GRID, capCategories } from "@/lib/chart-theme";

// Theme-aware (globals.css): the brand for magnitude, validated categorical slots for identity.
const CHART_COLORS = {
  primary: MAGNITUDE,
  secondary: "var(--series-4)",
  accent: "var(--series-3)",
  warn: "var(--series-6)",
  muted: "var(--muted-foreground)",
};

const TOOLTIP_STYLE = TOOLTIP;

const TICK = THEME_TICK;
const AXIS = { axisLine: false, tickLine: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFormatter = (v: any, name: any) => any;

// ── Annual volume + TCV ────────────────────────────────────────────────────────
export function AnnualTrendChart({ data }: { data: AnalyticsData["byYear"] }) {
  const fmt: AnyFormatter = (v, name) =>
    name === "tcvBn" ? [`$${Number(v).toFixed(1)}bn`, "TCV"] :
    name === "deals" ? [v, "Deals"] : [v, name];
  // Two measures of different scale get two charts on the same years, never two y-axes on one.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="min-w-0">
        <p className="eyebrow mb-1">Deals per year</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="year" tick={TICK} {...AXIS} />
            <YAxis tick={TICK} {...AXIS} />
            <Tooltip {...TOOLTIP_STYLE} formatter={fmt} />
            <Bar dataKey="deals" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} name="deals" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="min-w-0">
        <p className="eyebrow mb-1">Contract value per year · $bn</p>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
            <XAxis dataKey="year" tick={TICK} {...AXIS} />
            <YAxis tick={TICK} {...AXIS} tickFormatter={(v: number) => `$${Number(v).toFixed(0)}bn`} />
            <Tooltip {...TOOLTIP_STYLE} formatter={fmt} />
            <Bar dataKey="tcvBn" fill={CHART_COLORS.primary} radius={[4, 4, 0, 0]} name="tcvBn" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Top vendors by TCV (horizontal bar) ──────────────────────────────────────
export function VendorTcvChart({ data }: { data: AnalyticsData["topVendorsByTcv"] }) {
  const top = data.slice(0, 12);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={top} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={TICK} {...AXIS} tickFormatter={v => `$${v.toFixed(1)}bn`} />
        <YAxis type="category" dataKey="vendor" tick={{ fontSize: 10, fill: "var(--foreground)" }} {...AXIS} width={110} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [`$${Number(v).toFixed(2)}bn`, "TCV"]) as AnyFormatter} />
        <Bar dataKey="tcvBn" radius={[0, 3, 3, 0]} name="TCV">
          {top.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Top vendors by deal count ─────────────────────────────────────────────────
export function VendorCountChart({ data }: { data: AnalyticsData["topVendorsByDeals"] }) {
  const top = data.slice(0, 12);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={top} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={TICK} {...AXIS} />
        <YAxis type="category" dataKey="vendor" tick={{ fontSize: 10, fill: "var(--foreground)" }} {...AXIS} width={110} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [v, "Deals"]) as AnyFormatter} />
        <Bar dataKey="deals" radius={[0, 3, 3, 0]} name="Deals">
          {top.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Service line breakdown ────────────────────────────────────────────────────
export function ServiceLineChart({ data }: { data: AnalyticsData["serviceLines"] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="line" tick={{ ...TICK, fontSize: 9 }} {...AXIS} angle={-25} textAnchor="end" interval={0} />
        <YAxis tick={TICK} {...AXIS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown, name: unknown) =>
          name === "deals" ? [v, "Deals"] : [`$${Number(v).toFixed(1)}bn`, "TCV"]
        ) as AnyFormatter} />
        <Bar dataKey="deals" name="deals" radius={[3, 3, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Deal size distribution ────────────────────────────────────────────────────
export function DealSizeChart({ data }: { data: AnalyticsData["dealSizeBuckets"] }) {
  const sorted = [...data].sort((a, b) => a.order - b.order);
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={sorted} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="bucket" tick={{ ...TICK, fontSize: 9 }} {...AXIS} />
        <YAxis tick={TICK} {...AXIS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [Number(v).toLocaleString(), "Deals"]) as AnyFormatter} />
        <Bar dataKey="count" radius={[3, 3, 0, 0]} name="Deals">
          {sorted.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Geography bar ─────────────────────────────────────────────────────────────
export function GeographyChart({ data }: { data: AnalyticsData["topGeographies"] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={TICK} {...AXIS} />
        <YAxis type="category" dataKey="region" tick={{ fontSize: 10, fill: "var(--foreground)" }} {...AXIS} width={130} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [Number(v).toLocaleString(), "Events"]) as AnyFormatter} />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} name="Events">
          {data.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Event type pie ────────────────────────────────────────────────────────────
const TYPE_LABELS: Record<string, string> = {
  new_win: "New Win", renewal: "Renewal", extension: "Extension",
  expansion: "Expansion", rebid_win: "Rebid Win",
  framework_award: "Framework", incumbent_displacement: "Displacement", unknown: "Unknown",
};

export function EventTypePie({ data }: { data: AnalyticsData["eventTypes"] }) {
  // Six coloured slots at most (validated); further types fold into Other.
  const pieData = capCategories([...data].sort((a, b) => b.count - a.count).map(d => ({ ...d, name: TYPE_LABELS[d.type] ?? d.type })), "name", "count");
  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie data={pieData} dataKey="count" cx="40%" cy="50%" outerRadius={70} innerRadius={35}>
          {pieData.map((d, i) => <Cell key={i} fill={d.name === "Other" ? SERIES_OTHER : SERIES[i]} stroke="var(--card)" strokeWidth={2} />)}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE.contentStyle} formatter={((v: unknown) => [Number(v).toLocaleString(), "Deals"]) as AnyFormatter} />
        <Legend iconSize={8} iconType="circle" formatter={(value) => <span style={{ fontSize: 11, color: "var(--muted-foreground)" }}>{value}</span>} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ── Monthly momentum ──────────────────────────────────────────────────────────
export function MonthlyMomentumChart({ data }: { data: AnalyticsData["monthlyMomentum"] }) {
  const formatted = data.map(d => ({
    ...d,
    label: new Date(d.month + "-01").toLocaleDateString("en-GB", { month: "short", year: "2-digit" }),
  }));
  return (
    <ResponsiveContainer width="100%" height={160}>
      <BarChart data={formatted} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={TICK} {...AXIS} interval={2} />
        <YAxis tick={TICK} {...AXIS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [v, "Deals"]) as AnyFormatter} />
        <Bar dataKey="deals" fill={CHART_COLORS.primary} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Industry breakdown ────────────────────────────────────────────────────────
export function IndustryChart({ data }: { data: AnalyticsData["topIndustries"] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data.slice(0, 10)} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={TICK} {...AXIS} />
        <YAxis type="category" dataKey="industry" tick={{ fontSize: 10, fill: "var(--foreground)" }} {...AXIS} width={130} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown, name: unknown) =>
          name === "deals" ? [v, "Deals"] : [`$${Number(v).toFixed(1)}bn`, "TCV"]
        ) as AnyFormatter} />
        <Bar dataKey="deals" radius={[0, 3, 3, 0]}>
          {data.map((_, i) => <Cell key={i} fill={MAGNITUDE} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
