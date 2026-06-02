"use client";

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ComposedChart, Line, CartesianGrid, Cell, PieChart, Pie, Legend,
} from "recharts";
import type { AnalyticsData } from "@/app/api/analytics/route";
import Link from "next/link";

const CHART_COLORS = {
  primary: "#34d399",
  secondary: "#60a5fa",
  accent: "#a78bfa",
  warn: "#fbbf24",
  muted: "#71717a",
};

const TOOLTIP_STYLE = {
  contentStyle: { background: "#18181b", border: "1px solid #27272a", borderRadius: 6, fontSize: 11 },
  labelStyle: { color: "#a1a1aa" },
  cursor: { fill: "rgba(255,255,255,0.04)" },
};

const TICK = { fontSize: 10, fill: "#71717a" };
const AXIS = { axisLine: false, tickLine: false };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFormatter = (v: any, name: any) => any;

// ── Annual volume + TCV ────────────────────────────────────────────────────────
export function AnnualTrendChart({ data }: { data: AnalyticsData["byYear"] }) {
  const fmt: AnyFormatter = (v, name) =>
    name === "tcvBn" ? [`$${Number(v).toFixed(1)}bn`, "TCV"] :
    name === "deals" ? [v, "Deals"] : [v, name];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis dataKey="year" tick={TICK} {...AXIS} />
        <YAxis yAxisId="deals" tick={TICK} {...AXIS} />
        <YAxis yAxisId="tcv" orientation="right" tick={TICK} {...AXIS} tickFormatter={(v: number) => `$${Number(v).toFixed(0)}bn`} />
        <Tooltip {...TOOLTIP_STYLE} formatter={fmt} />
        <Bar yAxisId="deals" dataKey="deals" fill={CHART_COLORS.primary} radius={[3, 3, 0, 0]} name="Deals" />
        <Line yAxisId="tcv" dataKey="tcvBn" stroke={CHART_COLORS.warn} dot={false} strokeWidth={2} name="TCV" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Top vendors by TCV (horizontal bar) ──────────────────────────────────────
export function VendorTcvChart({ data }: { data: AnalyticsData["topVendorsByTcv"] }) {
  const top = data.slice(0, 12);
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={top} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }}>
        <XAxis type="number" tick={TICK} {...AXIS} tickFormatter={v => `$${v.toFixed(1)}bn`} />
        <YAxis type="category" dataKey="vendor" tick={{ fontSize: 10, fill: "#a1a1aa" }} {...AXIS} width={110} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [`$${Number(v).toFixed(2)}bn`, "TCV"]) as AnyFormatter} />
        <Bar dataKey="tcvBn" radius={[0, 3, 3, 0]} name="TCV">
          {top.map((_, i) => <Cell key={i} fill={`hsl(${160 - i * 8}, 55%, ${52 - i * 2}%)`} />)}
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
        <YAxis type="category" dataKey="vendor" tick={{ fontSize: 10, fill: "#a1a1aa" }} {...AXIS} width={110} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [v, "Deals"]) as AnyFormatter} />
        <Bar dataKey="deals" radius={[0, 3, 3, 0]} name="Deals">
          {top.map((_, i) => <Cell key={i} fill={`hsl(${220 - i * 6}, 55%, ${52 - i * 2}%)`} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Service line breakdown ────────────────────────────────────────────────────
const SL_COLORS = ["#34d399", "#60a5fa", "#a78bfa", "#fbbf24", "#fb7185", "#34d3d3", "#f97316"];
export function ServiceLineChart({ data }: { data: AnalyticsData["serviceLines"] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis dataKey="line" tick={{ ...TICK, fontSize: 9 }} {...AXIS} angle={-25} textAnchor="end" interval={0} />
        <YAxis tick={TICK} {...AXIS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown, name: unknown) =>
          name === "deals" ? [v, "Deals"] : [`$${Number(v).toFixed(1)}bn`, "TCV"]
        ) as AnyFormatter} />
        <Bar dataKey="deals" name="deals" radius={[3, 3, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={SL_COLORS[i % SL_COLORS.length]} />)}
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
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
        <XAxis dataKey="bucket" tick={{ ...TICK, fontSize: 9 }} {...AXIS} />
        <YAxis tick={TICK} {...AXIS} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [Number(v).toLocaleString(), "Deals"]) as AnyFormatter} />
        <Bar dataKey="count" radius={[3, 3, 0, 0]} name="Deals">
          {sorted.map((_, i) => <Cell key={i} fill={`hsl(${200 + i * 15}, 60%, ${45 + i * 3}%)`} />)}
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
        <YAxis type="category" dataKey="region" tick={{ fontSize: 10, fill: "#a1a1aa" }} {...AXIS} width={130} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown) => [Number(v).toLocaleString(), "Events"]) as AnyFormatter} />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} name="Events">
          {data.map((_, i) => <Cell key={i} fill={`hsl(${270 - i * 12}, 55%, ${50 - i * 2}%)`} />)}
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
const PIE_COLORS = ["#34d399", "#60a5fa", "#a78bfa", "#fbbf24", "#fb7185", "#34d3d3", "#f97316"];

export function EventTypePie({ data }: { data: AnalyticsData["eventTypes"] }) {
  const pieData = data.map(d => ({ ...d, name: TYPE_LABELS[d.type] ?? d.type }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie data={pieData} dataKey="count" cx="40%" cy="50%" outerRadius={70} innerRadius={35}>
          {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE.contentStyle} formatter={((v: unknown) => [Number(v).toLocaleString(), "Deals"]) as AnyFormatter} />
        <Legend iconSize={8} iconType="circle" formatter={(value) => <span style={{ fontSize: 10, color: "#a1a1aa" }}>{value}</span>} />
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
        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
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
        <YAxis type="category" dataKey="industry" tick={{ fontSize: 10, fill: "#a1a1aa" }} {...AXIS} width={160} />
        <Tooltip {...TOOLTIP_STYLE} formatter={((v: unknown, name: unknown) =>
          name === "deals" ? [v, "Deals"] : [`$${Number(v).toFixed(1)}bn`, "TCV"]
        ) as AnyFormatter} />
        <Bar dataKey="deals" radius={[0, 3, 3, 0]}>
          {data.map((_, i) => <Cell key={i} fill={`hsl(${30 + i * 14}, 65%, ${52 - i}%)`} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
