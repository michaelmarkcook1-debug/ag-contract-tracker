/**
 * Chart colours and chrome as CSS variables (globals.css), so every chart follows the light/dark theme.
 * Categorical slots are validated (see globals.css); single-series magnitude uses the brand (--chart-1).
 */
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)"] as const;
export const SERIES_OTHER = "var(--series-other)";
export const MAGNITUDE = "var(--chart-1)";

/** Event type → its fixed slot (colour follows the entity, never its rank). */
export const FAMILY_SERIES: Record<string, string> = {
  CONTRACT: SERIES[0], FINANCIAL_RESULTS: SERIES[1], M_AND_A: SERIES[2], PARTNERSHIP: SERIES[3], NEW_OFFERING: SERIES[4], ORG_CHANGE: SERIES[5],
};

export const TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
export const TOOLTIP = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12, color: "var(--popover-foreground)", boxShadow: "0 8px 24px rgb(0 0 0 / 0.08)" },
  labelStyle: { color: "var(--muted-foreground)" },
  itemStyle: { color: "var(--popover-foreground)" },
  cursor: { fill: "var(--brand-soft)" },
};
export const GRID = "var(--border)";

/** At most six categories get a colour; the rest fold into one "Other" entry. */
export function capCategories<T extends Record<string, unknown>>(rows: T[], nameKey: keyof T, valueKey: keyof T, max = 6): T[] {
  if (rows.length <= max) return rows;
  const head = rows.slice(0, max - 1);
  const rest = rows.slice(max - 1).reduce((s, r) => s + Number(r[valueKey] ?? 0), 0);
  return [...head, { ...rows[0], [nameKey]: "Other", [valueKey]: rest } as T];
}
