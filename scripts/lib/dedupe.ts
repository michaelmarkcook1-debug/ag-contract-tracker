// Copied from ExecGenius api/_lib/dedupe.ts (keep in step): duplicate clustering by date window, counterparty and weighted title similarity.
/**
 * Duplicate clustering for tracker events, run before anything is counted.
 *
 * One announcement carried by six outlets is one event. Within a vendor and a family, two reports are the same event
 * when they fall inside a date window and either name the same counterparty with some title overlap, or carry titles
 * that overlap strongly once the words every title in the sample shares (win, deal, numbers, the vendor's own name)
 * are discounted. The earliest report anchors the cluster; every report stays attached, so nothing is lost and the
 * clustering is auditable. Missing provenance never prevents clustering: an event with no URL or no counterparty still
 * clusters on its title and date.
 *
 * Title similarity is a weighted Dice coefficient over stemmed tokens, each token weighted by how rare it is across the sample
 * (log((N + 1) / (df + 1))), so client names and scope words carry the comparison and generic words carry little.
 * Thresholds were tuned on the Cognizant graduate-hiring story of 7–8 Sept 2026 (six outlets, one event) and checked
 * against contract samples for false merges between different clients (scripts/dedupe-check.ts).
 */
export interface DedupeEvent {
  id: string; family: string; announcementDate: string | null; canonicalTitle: string | null;
  clientName?: string | null; clientDescriptor?: string | null;
  partnerAName?: string | null; partnerBName?: string | null;
  targetName?: string | null; acquirerName?: string | null;
  tcvCommittedUsd?: number | null; originalArticleUrl?: string | null;
  contractEventType?: string | null;
}
export interface Cluster<T> { anchor: T; reports: T[]; counterparty: string | null }
export interface DedupeSummary { sampled: number; events: number; removed: number; multi: number; largest: number }
export interface DedupeResult<T> { events: T[]; clusters: Cluster<T>[]; summary: DedupeSummary }

const DEFAULT_WINDOW = 14;
const WINDOW_DAYS: Record<string, number> = { ORG_CHANGE: 3, FINANCIAL_RESULTS: 3 };
const STOP = new Set(('a an and the of to in on for with by at from as its it is are be via over into under up through ' +
  'new this that their his her will has have had after before amid').split(' '));
const SUFFIX = new Set(['inc', 'incorporated', 'ltd', 'limited', 'plc', 'llc', 'corp', 'corporation', 'co', 'company', 'group',
  'holdings', 'sa', 'ag', 'nv', 'se', 'gmbh', 'pvt', 'private', 'the']);

/** A counterparty name reduced to what identifies it: lower case, no punctuation, no corporate suffix. */
export function normaliseName(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !SUFFIX.has(w));
  return t.length ? t.join(' ') : null;
}

/** Stem a word to a short key: strip a common suffix, then keep the first four letters (three for short words). */
function stem(w: string): string {
  let s = w;
  for (const suf of ['ing', 'ed', 'es', 's']) { if (s.length - suf.length >= 3 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; } }
  return s.length >= 5 ? s.slice(0, 4) : s.slice(0, 3);
}

/** Tokens of a title: numbers and money collapse to one token, stop words and the vendor's own name drop out. */
export function titleTokens(title: string | null | undefined, vendorTokens: Set<string>): Set<string> {
  if (!title) return new Set();
  const t = title.toLowerCase().replace(/\bu\.s\.?/g, 'us').replace(/&/g, ' and ')
    .replace(/[$€£]\s?\d[\d,.]*\s?(bn|billion|m|mn|million|k)?/g, ' # ').replace(/\b\d[\d,.]*\s?(bn|billion|m|mn|million|k|%)?\b/g, ' # ');
  const out = new Set<string>();
  for (const raw of t.split(/[^a-z0-9#]+/)) {
    if (!raw || STOP.has(raw) || vendorTokens.has(raw)) continue;
    out.add(raw === '#' ? '#' : stem(raw));
  }
  return out;
}

/** Weighted Dice coefficient: 2 x shared weight over the two titles' total weight. Chosen over Jaccard because one
 *  outlet's longer headline (extra rare words) must not hide that it reports the same event as a shorter one. */
function weightedDice(a: Set<string>, b: Set<string>, w: Map<string, number>): number {
  let inter = 0, sa = 0, sb = 0;
  for (const t of a) { const x = w.get(t) ?? 1; sa += x; if (b.has(t)) inter += x; }
  for (const t of b) sb += w.get(t) ?? 1;
  return sa + sb > 0 ? (2 * inter) / (sa + sb) : 0;
}

function counterpartyOf(e: DedupeEvent, vendorTokens: Set<string>): string | null {
  const isVendor = (n: string | null | undefined) => {
    const k = normaliseName(n); if (!k) return false;
    return k.split(' ').every((w) => vendorTokens.has(w));
  };
  for (const n of [e.clientName, e.targetName, e.acquirerName, e.partnerAName, e.partnerBName]) {
    if (n && !isVendor(n)) return normaliseName(n);
  }
  // The tracker's own title format is "Vendor | Type | Counterparty | Scope"; when the counterparty fields are empty the
  // third segment names it, and two different names there must never be one event.
  const parts = (e.canonicalTitle ?? '').split('|').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3 && !isVendor(parts[2]) && !/^[A-Z_ ]+$/.test(parts[2])) return normaliseName(parts[2]);
  return null;
}

const dayOf = (d: string | null | undefined) => { const t = d ? Date.parse(d) : NaN; return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null; };

/**
 * Cluster one vendor's events of any families. Returns one canonical event per cluster (the earliest report, with a
 * committed value, URL or counterparty filled in from a later report where the anchor lacks one) plus the clusters.
 */
export function clusterEvents<T extends DedupeEvent>(events: T[], vendor: string, opts: { titleThreshold?: number; counterpartyThreshold?: number } = {}): DedupeResult<T> {
  const titleThreshold = opts.titleThreshold ?? 0.4;
  const counterpartyThreshold = opts.counterpartyThreshold ?? 0.3;
  const vendorTokens = new Set(vendor.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  // Token weights: rarity across this sample, so words every title shares count for little.
  const toks = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const e of events) {
    const s = titleTokens(e.canonicalTitle, vendorTokens); toks.set(e.id, s);
    for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = events.length;
  const w = new Map<string, number>();
  for (const [t, d] of df) w.set(t, Math.log((n + 1) / (d + 1)));

  const ordered = [...events].sort((a, b) => (dayOf(a.announcementDate) ?? 1e9) - (dayOf(b.announcementDate) ?? 1e9));
  type Work = Cluster<T> & { family: string; days: number[]; tokens: Set<string>[]; types: Set<string> };
  const clusters: Work[] = [];
  const typeOf = (e: DedupeEvent) => (e.contractEventType ?? '').toLowerCase();

  // Similarity of a report to a cluster, or null when the two can never be one event.
  const fit = (e: T, day: number, cp: string | null, s: Set<string>, c: Work): number | null => {
    if (c.family !== e.family) return null;
    const window = WINDOW_DAYS[e.family] ?? DEFAULT_WINDOW;
    if (!c.days.some((d) => Math.abs(d - day) <= window)) return null;
    if (Math.abs(day - Math.min(...c.days)) > 2 * window) return null;       // a cluster spans at most twice its window: a running topic is not one event
    if (cp && c.counterparty && cp !== c.counterparty) return null;          // two named counterparties that differ: never the same event
    const sim = Math.max(...c.tokens.map((t) => weightedDice(s, t, w)));
    const sameCounterparty = Boolean(cp && c.counterparty && cp === c.counterparty);
    // Same client, but the tracker typed them differently (a new win and an expansion on one day): only the titles can
    // say they are one announcement, so the title threshold applies.
    const t = typeOf(e); const typesDiffer = Boolean(t && c.types.size && !c.types.has(t));
    const need = sameCounterparty && !typesDiffer ? counterpartyThreshold : titleThreshold;
    return sim >= need ? sim : null;
  };

  for (const e of ordered) {
    const day = dayOf(e.announcementDate);
    const cp = counterpartyOf(e, vendorTokens);
    const s = toks.get(e.id)!;
    let home: Work | null = null; let best = -1;
    if (day !== null) for (const c of clusters) { const f = fit(e, day, cp, s, c); if (f !== null && f > best) { best = f; home = c; } }
    if (home) {
      home.reports.push(e); home.days.push(day!); home.tokens.push(s); if (typeOf(e)) home.types.add(typeOf(e));
      if (!home.counterparty && cp) home.counterparty = cp;
      const a = home.anchor as DedupeEvent;
      if (a.tcvCommittedUsd == null && e.tcvCommittedUsd != null) a.tcvCommittedUsd = e.tcvCommittedUsd;
      if (!a.originalArticleUrl && e.originalArticleUrl) a.originalArticleUrl = e.originalArticleUrl;
      if (!a.clientName && e.clientName) a.clientName = e.clientName;
    } else {
      clusters.push({ anchor: { ...e }, reports: [e], counterparty: cp, family: e.family, days: day === null ? [] : [day], tokens: [s], types: new Set(typeOf(e) ? [typeOf(e)] : []) });
    }
  }

  // Merge pass: a report seen early may have opened its own cluster before the one it belongs to had formed, so clusters
  // whose members would have joined each other are merged until none remain. Order of arrival then no longer matters.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i], b = clusters[j];
        if (a.family !== b.family) continue;
        if (a.counterparty && b.counterparty && a.counterparty !== b.counterparty) continue;
        const joins = b.reports.some((e, k) => fit(e, b.days[k], b.counterparty, b.tokens[k], a) !== null);
        if (!joins) continue;
        a.reports.push(...b.reports); a.days.push(...b.days); a.tokens.push(...b.tokens); for (const t of b.types) a.types.add(t);
        if (!a.counterparty && b.counterparty) a.counterparty = b.counterparty;
        a.reports.sort((x, y) => (dayOf(x.announcementDate) ?? 1e9) - (dayOf(y.announcementDate) ?? 1e9));
        const first = a.reports[0]; const an = a.anchor as DedupeEvent;
        if (first.id !== a.anchor.id) a.anchor = { ...first, tcvCommittedUsd: an.tcvCommittedUsd ?? first.tcvCommittedUsd, originalArticleUrl: an.originalArticleUrl ?? first.originalArticleUrl, clientName: an.clientName ?? first.clientName };
        clusters.splice(j, 1); merged = true; break outer;
      }
    }
  }
  const out = clusters.map(({ anchor, reports, counterparty }) => ({ anchor, reports, counterparty }));
  const multi = out.filter((c) => c.reports.length > 1);
  return {
    events: out.map((c) => c.anchor), clusters: out,
    summary: { sampled: n, events: out.length, removed: n - out.length, multi: multi.length, largest: Math.max(0, ...multi.map((c) => c.reports.length)) },
  };
}
