/**
 * Deal Maker data: loads the published contract catalogue, fits the renewal model and the vendor signals, and
 * answers the Renewals view. Computed from the live catalogue and held in memory for an hour per server instance —
 * no tables of its own yet (persisting scores is the next step once the model settles).
 */
import { prisma } from "@/lib/db";
import { trackedEventScope } from "@/lib/data";
import { fitModel, normaliseClient, scopeTokens, sameScope, MODEL_VERSION, type ContractRow, type Scores } from "./model";
import { daysToEnd, windowOf, gradeUrgency, gradeRisk, gradeChurn, gradeAI, suggestedAction, analysis, automationTier, aiUsage, aiDeployment, tcvBucket,
  RISK_WEIGHT, URGENCY_WEIGHT, AUTOMATION_TIERS, type Grade, type Action, type WindowKey, type AutomationTier } from "./grades";
import { getNewsSignals, CATEGORIES, type VendorNews, type NewsSignals } from "./news";

const TTL_MS = 60 * 60 * 1000;
const REGIONS: Record<string, string> = {
  "North America": "NA", "United States": "NA", US: "NA", USA: "NA", Canada: "NA",
  "Latin America": "LATAM", Brazil: "LATAM", Mexico: "LATAM", "South America": "LATAM", "South & Central America": "LATAM",
  "UK & Ireland": "EMEA", "United Kingdom": "EMEA", GB: "EMEA", UK: "EMEA", Europe: "EMEA", "Western Europe": "EMEA", "Continental Europe": "EMEA",
  Germany: "EMEA", France: "EMEA", Spain: "EMEA", Netherlands: "EMEA", "Middle East": "EMEA", "Middle East & Africa": "EMEA", Africa: "EMEA",
  "Asia Pacific": "APAC", "Asia-Pacific": "APAC", APAC: "APAC", India: "APAC", "India & South Asia": "APAC", Japan: "APAC", Australia: "APAC", AU: "APAC",
  "Australia & New Zealand": "APAC", Singapore: "APAC", Asia: "APAC", Oceania: "APAC", China: "APAC",
};

/**
 * Vendor signal score, 0–100 (FedSpend's GDELT signal_risk, rebuilt from this catalogue's events over the last 12
 * months). Starts at 20; stress raises it, wins lower it; each category is capped.
 * Stress counts are scaled to a vendor's activity (as if it had at most REFERENCE_EVENTS events in the year), so a
 * large vendor's six terminations among hundreds of wins read as the low rate they are, not as a crisis.
 */
const REFERENCE_EVENTS = 40;
const SIGNALS: { key: string; label: string; weight: number; cap: number }[] = [
  { key: "lost", label: "contracts terminated or disputed", weight: 8, cap: 24 },
  { key: "departure", label: "leadership departures", weight: 4, cap: 12 },
  { key: "restructuring", label: "restructuring or layoffs", weight: 6, cap: 18 },
  { key: "ma", label: "M&A events", weight: 3, cap: 9 },
  { key: "win", label: "contract wins", weight: -4, cap: -12 },
];

export interface VendorSignal { score: number; counts: Record<string, number>; summary: string }

interface Cache { at: number; rows: ContractRow[]; scores: Map<string, Scores>; signals: Map<string, VendorSignal>; model: ReturnType<typeof fitModel>; news: NewsSignals | null; stats: ReturnType<typeof fitModel>["stats"] }
let cache: Cache | null = null;

async function load(): Promise<Cache> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const scope = await trackedEventScope();
  const ids = (await prisma.canonicalMarketEvent.findMany({ where: { family: "CONTRACT", publicationStatus: "published", ...scope }, select: { id: true } })).map(r => r.id);
  const rows: ContractRow[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const page = await prisma.canonicalMarketEvent.findMany({
      where: { id: { in: ids.slice(i, i + 2000) } },
      select: {
        id: true, canonicalTitle: true, announcementDate: true, commercialEventType: true, eventStatus: true, buyerSector: true, aiRelevance: true, geography: true, industry: true, originalArticleUrl: true, analystInsight: true,
        primaryEntity: { select: { id: true, canonicalName: true, slug: true } },
        contractDetails: { select: { vendorId: true, vendorRaw: true, clientId: true, clientRaw: true, clientAnonymised: true, clientDescriptor: true, clientIndustry: true, previousVendorRaw: true,
          contractStartDate: true, contractEndDate: true, contractEndDatePrecision: true, contractLengthMonths: true, tcvCommittedUsd: true, tcvIsEstimate: true, tcvEstimateMidUsd: true,
          primaryMacroServiceLine: true, primaryMicroServiceLine: true, scopeSummary: true } },
      },
    });
    for (const e of page) {
      const cd = e.contractDetails;
      if (!cd) continue;
      const start = cd.contractStartDate ?? e.announcementDate;
      let end = cd.contractEndDate, endBasis: ContractRow["endBasis"] = end ? (["day", "month", "planned_day"].includes(cd.contractEndDatePrecision) ? "stated" : "estimated") : null;
      if (!end && start && cd.contractLengthMonths) { end = new Date(start); end.setMonth(end.getMonth() + cd.contractLengthMonths); endBasis = "estimated"; }
      const geo: string[] = (() => { try { return JSON.parse(e.geography) as string[]; } catch { return []; } })();
      const region = geo.map(g => REGIONS[g]).find(Boolean) ?? null;
      const tcvUsd = cd.tcvCommittedUsd && cd.tcvCommittedUsd > 0 ? cd.tcvCommittedUsd : cd.tcvIsEstimate && cd.tcvEstimateMidUsd ? cd.tcvEstimateMidUsd : null;
      rows.push({
        id: e.id, title: e.canonicalTitle, announced: e.announcementDate, start, end, endBasis, termMonths: cd.contractLengthMonths,
        vendorId: e.primaryEntity?.id ?? cd.vendorId, vendorName: e.primaryEntity?.canonicalName ?? cd.vendorRaw ?? "Unknown", vendorSlug: e.primaryEntity?.slug ?? null,
        clientKey: cd.clientId ?? normaliseClient(cd.clientRaw), clientName: cd.clientRaw ?? cd.clientDescriptor, clientAnonymised: cd.clientAnonymised || !cd.clientRaw,
        industry: cd.clientIndustry ?? e.industry, sector: e.buyerSector, region, country: geo.find(g => !REGIONS[g] || g.length <= 3) ?? null,
        serviceLine: cd.primaryMacroServiceLine, microServiceLine: cd.primaryMicroServiceLine, tcvUsd, tcvIsEstimate: !(cd.tcvCommittedUsd && cd.tcvCommittedUsd > 0),
        commercialType: e.commercialEventType, displacedVendor: cd.previousVendorRaw, eventStatus: e.eventStatus?.toUpperCase() ?? null, aiRelevance: e.aiRelevance,
        scope: cd.scopeSummary, url: e.originalArticleUrl, writeUp: e.analystInsight,
      });
    }
  }
  // Terminated, disputed and rumoured contracts are evidence for the model but are not live renewals.
  const model = fitModel(rows);
  const scores = new Map(rows.map(r => [r.id, model.score(r)]));
  cache = { at: Date.now(), rows, scores, signals: await vendorSignals(), model, news: await getNewsSignals(), stats: model.stats };
  return cache;
}

async function vendorSignals(): Promise<Map<string, VendorSignal>> {
  const since = new Date(Date.now() - 365 * 86_400_000);
  const rows = await prisma.canonicalMarketEvent.groupBy({
    by: ["primaryEntityId", "family", "eventType", "eventStatus"],
    where: { publicationStatus: "published", primaryEntityId: { not: null }, announcementDate: { gte: since } },
    _count: { id: true },
  });
  const counts = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = r.family === "CONTRACT" && /^(TERMINATED|DISPUTED)$/i.test(r.eventStatus ?? "") ? "lost"
      : r.family === "ORG_CHANGE" && r.eventType === "leadership_departure" ? "departure"
      : r.family === "ORG_CHANGE" && r.eventType === "restructuring" ? "restructuring"
      : r.family === "M_AND_A" ? "ma"
      : r.family === "CONTRACT" && !/^(RUMOURED|OPPORTUNITY)$/i.test(r.eventStatus ?? "") ? "win" : null;
    if (!k) continue;
    const c = counts.get(r.primaryEntityId!) ?? {};
    c[k] = (c[k] ?? 0) + r._count.id;
    counts.set(r.primaryEntityId!, c);
  }
  const out = new Map<string, VendorSignal>();
  for (const [id, c] of counts) {
    let score = 20;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const scale = Math.min(1, REFERENCE_EVENTS / Math.max(1, total));
    for (const s of SIGNALS) { const n = c[s.key] ?? 0; score += s.weight < 0 ? Math.max(s.cap, n * s.weight) : Math.min(s.cap, n * scale * s.weight); }
    score = Math.round(score);
    const summary = SIGNALS.filter(s => s.weight > 0 && c[s.key]).map(s => `${c[s.key]} ${s.label}`).join(", ");
    out.set(id, { score: Math.max(0, Math.min(100, score)), counts: c, summary: summary ? `Last 12 months: ${summary}` : "No stress signals in the last 12 months" });
  }
  return out;
}

export interface RenewalFilters {
  windows?: WindowKey[]; vendor?: string; serviceLine?: string; region?: string; country?: string; industry?: string; action?: Exclude<Action, null>;
  risk?: string; automation?: AutomationTier; tcvBucket?: string; q?: string; sort?: "end" | "tcv" | "displacement" | "renewal" | "risk"; limit?: number;
}

export interface RenewalRow {
  id: string; title: string; vendor: string; vendorSlug: string | null; client: string | null; clientAnonymised: boolean; industry: string | null; region: string | null;
  serviceLine: string | null; microServiceLine: string | null; tcvUsd: number | null; tcvIsEstimate: boolean; end: string | null; endBasis: ContractRow["endBasis"]; daysToEnd: number | null;
  window: WindowKey | null; renewalProb: number; displacementRisk: number; urgency: Grade; risk: Grade; churn: Grade; ai: Grade; action: Action; analysis: string; factors: string[];
  vendorSignal: VendorSignal | null; url: string | null; writeUp: string | null; scope: string | null;
  country: string | null; tcvBucket: string | null; automation: AutomationTier; aiUsage: { current: string; potential: string }; aiDeployment: string[];
  /** Data-driven incumbent churn intelligence (FedSpend's CHURN_INTEL was hand-written for 14 US federal primes). */
  churnIntel: string;
  /** News and incident signals for the incumbent (litigation, security, financial, leadership, contract losses). */
  news: VendorNews | null;
  /** For a contract that has just ended: who won the follow-on, if it has been seen. */
  successor: { status: "retained" | "new_vendor" | "none"; vendor: string | null; title: string | null } | null;
}

const RISK_RANK: Record<string, number> = { critical: 5, urgent: 4, concern: 2, standard: 1, positive: 0 };
const LIVE = (r: ContractRow) => !r.eventStatus || !/^(TERMINATED|DISPUTED|RUMOURED|OPPORTUNITY)$/.test(r.eventStatus);

/** The Renewals view: KPIs, two charts and the filtered table (at most `limit` rows). */
export async function getRenewals(f: RenewalFilters) {
  const { shaped, stats, news } = await shapedPipeline();
  const in18 = shaped.filter(r => r.daysToEnd != null && r.daysToEnd >= 0 && r.daysToEnd <= 548);
  return renewalsView(f, shaped, in18, stats, news);
}

/** Every live contract with a known end (ended at most 30 days ago), graded. Shared by Renewals and Portfolio. */
async function shapedPipeline() {
  const { rows, scores, signals, stats, news, model } = await load();
  const today = new Date();
  // Contracts with a known end, not ended more than 30 days ago, and still live.
  const pipeline = rows.filter(r => LIVE(r) && r.end && daysToEnd(r, today)! >= -30);
  const clientVendors = new Map<string, Set<string>>();
  for (const r of pipeline) if (r.clientKey) (clientVendors.get(r.clientKey) ?? clientVendors.set(r.clientKey, new Set()).get(r.clientKey)!).add(r.vendorName);
  // Every contract (live or not) by client, for the successor of a contract that has just ended.
  const byClient = new Map<string, ContractRow[]>();
  for (const r of rows) if (r.clientKey && !r.clientAnonymised) (byClient.get(r.clientKey) ?? byClient.set(r.clientKey, []).get(r.clientKey)!).push(r);
  const vendorExpiring = new Map<string, number>();
  for (const r of pipeline) { const d = daysToEnd(r, today)!; if (d >= 0 && d <= 365) vendorExpiring.set(r.vendorName, (vendorExpiring.get(r.vendorName) ?? 0) + 1); }


  const shaped: RenewalRow[] = pipeline.map(r => {
    const s = scores.get(r.id)!, d = daysToEnd(r, today), tcv = r.tcvUsd ?? 0, sig = r.vendorId ? signals.get(r.vendorId) ?? null : null;
    const nv = news?.vendors[r.vendorName] ?? null;
    // The incumbent's stress is the worse of what the catalogue and the news say.
    const stress = Math.max(sig?.score ?? 20, nv?.score ?? 20);
    const ai = gradeAI(r, tcv);
    return {
      id: r.id, title: r.title, vendor: r.vendorName, vendorSlug: r.vendorSlug, client: r.clientName, clientAnonymised: r.clientAnonymised, industry: r.industry, region: r.region,
      serviceLine: r.serviceLine, microServiceLine: r.microServiceLine, tcvUsd: r.tcvUsd, tcvIsEstimate: r.tcvIsEstimate, end: r.end?.toISOString().slice(0, 10) ?? null, endBasis: r.endBasis,
      daysToEnd: d, window: windowOf(d), renewalProb: s.renewalProb, displacementRisk: s.displacementRisk,
      urgency: gradeUrgency(d), risk: gradeRisk(tcv, d, stress), churn: gradeChurn(tcv, d, (r.clientKey && clientVendors.get(r.clientKey)?.size === 1) || false, vendorExpiring.get(r.vendorName) ?? 0),
      ai, action: suggestedAction(s), analysis: analysis(r, s, d), factors: s.factors, vendorSignal: sig, url: r.url, writeUp: r.writeUp, scope: r.scope,
      country: r.country, tcvBucket: tcvBucket(r.tcvUsd), automation: automationTier(ai), aiUsage: aiUsage(ai), aiDeployment: aiDeployment(r.serviceLine),
      churnIntel: churnIntel(r, model.vendorRecord(r), vendorExpiring.get(r.vendorName) ?? 0, nv),
      news: nv, successor: d != null && d < 0 ? successorOf(r, byClient) : null,
    };
  });

  return { shaped, stats, news };
}

function renewalsView(f: RenewalFilters, shaped: RenewalRow[], in18: RenewalRow[], stats: Cache["stats"], news: NewsSignals | null) {
  const sum = (xs: RenewalRow[]) => xs.reduce((s, r) => s + (r.tcvUsd ?? 0), 0);
  const byWindow = (k: WindowKey) => shaped.filter(r => r.window === k);
  const top = (key: (r: RenewalRow) => string | null) => {
    const m = new Map<string, number>();
    for (const r of in18) { const k = key(r); if (k) m.set(k, (m.get(k) ?? 0) + (r.tcvUsd ?? 0)); }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, tcv]) => ({ name, tcv }));
  };
  const kpis = {
    upForRenewal: in18.length, renewalTcvUsd: sum(in18),
    windows: (["0-3", "3-6", "6-12", "12-18"] as WindowKey[]).map(k => ({ key: k, count: byWindow(k).length, tcvUsd: sum(byWindow(k)) })),
    recentlyEnded: byWindow("expired30").length,
    pitch: in18.filter(r => r.action === "pitch").length, defend: in18.filter(r => r.action === "defend").length,
  };

  const q = f.q?.toLowerCase().trim();
  let table = shaped.filter(r =>
    (!f.windows?.length || (r.window && f.windows.includes(r.window))) &&
    (!f.vendor || r.vendor === f.vendor) && (!f.serviceLine || r.serviceLine === f.serviceLine) &&
    (!f.region || r.region === f.region) && (!f.country || r.country === f.country) && (!f.industry || r.industry === f.industry) && (!f.action || r.action === f.action) &&
    (!f.risk || r.risk.key === f.risk) && (!f.automation || r.automation === f.automation) && (!f.tcvBucket || r.tcvBucket === f.tcvBucket) &&
    (!q || `${r.title} ${r.vendor} ${r.client ?? ""} ${r.scope ?? ""}`.toLowerCase().includes(q)));
  const sorts: Record<string, (a: RenewalRow, b: RenewalRow) => number> = {
    end: (a, b) => (a.daysToEnd ?? 1e9) - (b.daysToEnd ?? 1e9),
    tcv: (a, b) => (b.tcvUsd ?? 0) - (a.tcvUsd ?? 0),
    displacement: (a, b) => b.displacementRisk - a.displacementRisk,
    renewal: (a, b) => b.renewalProb - a.renewalProb,
    risk: (a, b) => (RISK_RANK[b.risk.key] ?? 0) - (RISK_RANK[a.risk.key] ?? 0) || (b.tcvUsd ?? 0) - (a.tcvUsd ?? 0),
  };
  table = table.sort(sorts[f.sort ?? "end"]);
  const total = table.length;

  const facet = (key: (r: RenewalRow) => string | null) => [...new Set(in18.map(key).filter(Boolean) as string[])].sort();
  return {
    model: { version: MODEL_VERSION, ...stats, computedAt: new Date(cache!.at).toISOString() },
    kpis, charts: { byServiceLine: top(r => r.serviceLine), byIndustry: top(r => r.industry) },
    facets: { vendors: facet(r => r.vendor), serviceLines: facet(r => r.serviceLine), regions: facet(r => r.region), countries: facet(r => r.country), industries: facet(r => r.industry) },
    newsFetchedAt: news?.fetchedAt ?? null,
    total, rows: table.slice(0, Math.min(f.limit ?? 200, 500)),
  };
}

/**
 * FedSpend's findSuccessor: the next contract for the same client, starting from 180 days before this one ended, that
 * covers the same work — the same service line, or (because service-line labels vary) a materially similar scope.
 */
function successorOf(r: ContractRow, byClient: Map<string, ContractRow[]>): RenewalRow["successor"] {
  if (!r.clientKey || r.clientAnonymised || !r.end) return { status: "none", vendor: null, title: null };
  const from = r.end.getTime() - 180 * 86_400_000;
  const mine = scopeTokens(`${r.title} ${r.scope ?? ""}`);
  const startOf = (x: ContractRow) => (x.start ?? x.announced)?.getTime() ?? null;
  const next = (byClient.get(r.clientKey) ?? [])
    .filter(s => {
      const t = startOf(s);
      if (s.id === r.id || t == null || t < from || t <= (startOf(r) ?? 0)) return false;
      return (!!r.serviceLine && s.serviceLine === r.serviceLine) || sameScope(mine, scopeTokens(`${s.title} ${s.scope ?? ""}`));
    })
    .sort((a, b) => startOf(a)! - startOf(b)!)[0];
  if (!next) return { status: "none", vendor: null, title: null };
  return { status: next.vendorName === r.vendorName ? "retained" : "new_vendor", vendor: next.vendorName, title: next.title };
}

/** Churn intelligence from the record, not from hand-written notes. */
function churnIntel(r: ContractRow, rec: { judged: number; retained: number }, expiring12: number, nv: VendorNews | null): string {
  const parts: string[] = [];
  if (rec.judged >= 3) {
    const pct = Math.round((rec.retained / rec.judged) * 100);
    parts.push(`${r.vendorName} kept ${rec.retained} of ${rec.judged} scopes that came back to market (${pct}%)${pct >= 70 ? ", a strong incumbent" : pct < 50 ? ", below the market's 68% retention" : ""}.`);
  } else parts.push(`Too few observed re-awards to judge ${r.vendorName}'s retention record.`);
  if (expiring12 > 20) parts.push(`${expiring12} of its contracts end in the next 12 months, which stretches renewal bandwidth.`);
  else if (expiring12 > 1) parts.push(`${expiring12} of its contracts end in the next 12 months.`);
  if (nv) {
    const bad = CATEGORIES.filter(c => c.weight > 0 && c.key !== "ma" && (nv.counts[c.key] ?? 0) > 0).map(c => `${nv.counts[c.key]} ${c.label.toLowerCase()}`);
    if (bad.length) parts.push(`In the news over the last six months: ${bad.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * FedSpend's Portfolio Assessment over every live contract that has not ended: risk, automation, AI and churn mix,
 * and the most critical contracts ranked by risk weight × urgency weight × log10(value).
 */
export async function getPortfolio() {
  const { shaped, stats } = await shapedPipeline();
  const live = shaped.filter(r => r.daysToEnd != null && r.daysToEnd >= 0);
  // As in FedSpend's value charts, a single contract over $10bn (the AI-infrastructure mega-deals) is reported apart
  // rather than summed: one of them outweighs every other contract together.
  const MEGA = 10e9;
  const val = (r: RenewalRow) => r.tcvUsd != null && r.tcvUsd <= MEGA ? r.tcvUsd : 0;
  const mega = live.filter(r => (r.tcvUsd ?? 0) > MEGA);
  const count = <K extends string>(keys: readonly K[], f: (r: RenewalRow) => K | null) => keys.map(k => ({ key: k, count: live.filter(r => f(r) === k).length }));
  const RISKS = ["critical", "urgent", "concern", "standard", "positive"] as const;
  const riskMix = count(RISKS, r => r.risk.key as typeof RISKS[number]);
  // Risk by service line: the ten service lines with the most critical or urgent contracts.
  const bySl = new Map<string, Record<string, number>>();
  for (const r of live) { const k = r.serviceLine ?? "Unclassified"; const m = bySl.get(k) ?? {}; m[r.risk.key] = (m[r.risk.key] ?? 0) + 1; bySl.set(k, m); }
  const riskByServiceLine = [...bySl].map(([name, m]) => ({ name, ...m, hot: (m.critical ?? 0) + (m.urgent ?? 0) }))
    .sort((a, b) => b.hot - a.hot || Object.values(b).length - Object.values(a).length).slice(0, 10);
  const automationByTcv = AUTOMATION_TIERS.map(t => ({ key: t, tcvUsd: live.filter(r => r.automation === t).reduce((s, r) => s + val(r), 0), count: live.filter(r => r.automation === t).length }));
  const AI_KEYS = ["active", "high", "moderate", "low", "limited"] as const;
  const aiByAutomation = AI_KEYS.map(a => ({ ai: a, ...Object.fromEntries(AUTOMATION_TIERS.map(t => [t, live.filter(r => r.ai.key === a && r.automation === t).length])) }));
  const weight = (r: RenewalRow) => (RISK_WEIGHT[r.risk.key] ?? 0) * (URGENCY_WEIGHT[r.urgency.key] ?? 0) * Math.log10(Math.max(10, r.tcvUsd ?? 10));
  const critical = live.map(r => ({ r, w: weight(r) })).filter(x => x.w > 0).sort((a, b) => b.w - a.w).slice(0, 30).map(x => ({ ...x.r, priority: Math.round(x.w * 10) / 10 }));
  return {
    model: { version: MODEL_VERSION, ...stats },
    kpis: {
      contracts: live.length, tcvUsd: live.reduce((s, r) => s + val(r), 0),
      megaDeals: { count: mega.length, tcvUsd: mega.reduce((s, r) => s + (r.tcvUsd ?? 0), 0), names: mega.sort((a, b) => (b.tcvUsd ?? 0) - (a.tcvUsd ?? 0)).slice(0, 5).map(r => `${r.vendor} · ${r.client ?? "undisclosed"}`) },
      criticalOrUrgent: live.filter(r => r.risk.key === "critical" || r.risk.key === "urgent").length,
      highAutomation: live.filter(r => r.automation === "high-potential").length,
      usingAI: live.filter(r => r.ai.key === "active").length,
      highChurn: live.filter(r => r.churn.key === "critical" || r.churn.key === "elevated").length,
    },
    riskMix, riskByServiceLine, automationByTcv, aiByAutomation, critical,
  };
}
