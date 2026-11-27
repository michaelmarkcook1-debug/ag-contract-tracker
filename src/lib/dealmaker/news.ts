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
 */
import { prisma } from "@/lib/db";
import { NEWS_KEY, type NewsSignals } from "./news-categories";

export * from "./news-categories";

export async function getNewsSignals(): Promise<NewsSignals | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: NEWS_KEY } }).catch(() => null);
  if (!row) return null;
  try { return JSON.parse(row.value) as NewsSignals; } catch { return null; }
}

export async function saveNewsSignals(s: NewsSignals): Promise<void> {
  const value = JSON.stringify(s);
  await prisma.systemSetting.upsert({ where: { key: NEWS_KEY }, update: { value }, create: { key: NEWS_KEY, value } });
}
