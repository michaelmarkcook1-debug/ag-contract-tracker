/**
 * Vendor news and incident signals — FedSpend's enrich_signals_gdelt.py, ported.
 *
 * GDELT DOC 2.0 (free, no key, ~1 request / 5 s, sticky throttling) gives each tracked vendor's recent coverage; each
 * headline is placed in one of FedSpend's categories. FedSpend matched keywords; here Haiku reads the headlines
 * (this project's rule: the model classifies, not regex), with the same weights and caps:
 *   legal          litigation, bid protests, investigations, fines, settlements, regulatory action    9 / cap 27
 *   security       breaches, ransomware, outages, compromised systems                                 10 / cap 30
 *   financial      layoffs, losses, downgrades, restructuring, profit warnings                         6 / cap 18
 *   leadership     CEO/CFO/CIO/CTO/chair departures or replacements                                    4 / cap 12
 *   ma             acquisitions, mergers, divestitures                                                 3 / cap 9
 *   contract_loss  lost re-competes, terminated or cancelled contracts                                 8 / cap 24
 *   contract_win   newly announced awards                                                             −4 / cap −12
 * signal_risk starts at 20 and is clipped to 0–100. Stored in SystemSetting "dealmaker.newsSignals".
 *
 * This module has no database access, so client components can import it; news.ts reads and writes the store.
 */
export const NEWS_KEY = "dealmaker.newsSignals";
export const NEWS_VERSION = "dealmaker-news/1.0.0-2026-11-27";
export const CATEGORIES = [
  { key: "legal", label: "Legal & litigation", weight: 9, cap: 27 },
  { key: "security", label: "Security incidents", weight: 10, cap: 30 },
  { key: "financial", label: "Financial stress", weight: 6, cap: 18 },
  { key: "leadership", label: "Leadership churn", weight: 4, cap: 12 },
  { key: "ma", label: "M&A", weight: 3, cap: 9 },
  { key: "contract_loss", label: "Contract losses", weight: 8, cap: 24 },
  { key: "contract_win", label: "Contract wins", weight: -4, cap: -12 },
] as const;
export type Category = typeof CATEGORIES[number]["key"];

export interface Headline { title: string; url: string; date: string; domain: string; category: Category }
export interface VendorNews { score: number; counts: Partial<Record<Category, number>>; examples: Headline[]; scanned: number; fetchedAt: string }
export interface NewsSignals { version: string; fetchedAt: string; months: number; vendors: Record<string, VendorNews> }

export function scoreCounts(counts: Partial<Record<Category, number>>): number {
  let s = 20;
  for (const c of CATEGORIES) { const n = counts[c.key] ?? 0; s += c.weight < 0 ? Math.max(c.cap, n * c.weight) : Math.min(c.cap, n * c.weight); }
  return Math.max(0, Math.min(100, Math.round(s)));
}

