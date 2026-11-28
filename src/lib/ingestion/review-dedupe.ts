/**
 * Duplicate detection shared by the catalogue/review dedupe script
 * (scripts/dedup-catalogue.ts) and the daily review job (/api/cron/review).
 *
 * Candidates are found for free (same provider and family, close in date, and
 * a shared counterparty, stated value or enough title words); a model then
 * answers one question per record — is it the same event as one of these? —
 * and says no when unsure. The better-ranked record survives.
 */
import { prisma } from "@/lib/db";

export const DEDUPE_VERSION = "dedup-catalogue/1.2.0-2026-11-27";
export const DAY = 86_400_000;
export const REMENTION_DAYS = 365;

/** USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing (read 2026-11-27). */
export const DEDUPE_MODELS: Record<string, { id: string; input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  haiku: { id: "claude-haiku-5-5", input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  sonnet: { id: "claude-sonnet-5-5", input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
};

export const SYSTEM_CONTRACTS = [
  "You compare contract records in an IT-services market tracker. Every record below is for the same provider.",
  "Decide whether RECORD describes the same contract event as one of the numbered CANDIDATES.",
  "Same event: the same award, renewal, extension, expansion or termination between this provider and the same client, as reported by different sources. Client names may be written differently (an acronym, an agency or parent name, a legal suffix). A stated value on one record and none, or an estimate, on the other does not make them different.",
  "A later record that only re-reports or refers back to a contract already recorded (same client, same stated value, no new award, renewal or change of its own) is the same event.",
  "An unnamed client matches a named one only when the date, scope and stated value together clearly identify the same deal; a similar scope alone is not enough.",
  "NOT the same: a different client; a different contract or programme with the same client; a different kind of event on the same contract (an award and its later extension, expansion, dispute or termination); a framework award and a call-off under it; stated values that clearly conflict; separate announcements that happen to fall close together.",
  "If you are not sure, answer 0.",
  "Reply with JSON only: {\"same\": <candidate number, or 0 for none>, \"why\": \"<12 words>\"}",
].join("\n");

export const SYSTEM_REVIEW = [
  "You compare records in an IT-services market tracker. Every record below is for the same provider and the same kind of event: a contract, an acquisition or stake, a partnership, a product or service launch, a leadership change, or financial results.",
  "Decide whether RECORD describes the same event as one of the numbered CANDIDATES.",
  "Same event: the same specific deal, transaction, alliance, launch, appointment or results announcement, as reported by different sources. The other party's name may be written differently (an acronym, a parent or agency name, a legal suffix). A stated value on one record and none on the other does not make them different.",
  "A later record that only re-reports or refers back to something already recorded, with no new development of its own, is the same event.",
  "An unnamed party matches a named one only when the date, scope and stated value together clearly identify the same deal.",
  "NOT the same: a different other party; a different deal, product or role with the same party; a different stage of the same thing (talks and the signed deal, an announced acquisition and its completion, an award and its later extension, dispute or termination); stated values that clearly conflict; a different reporting period.",
  "If you are not sure, answer 0.",
  "Reply with JSON only: {\"same\": <candidate number, or 0 for none>, \"why\": \"<12 words>\"}",
].join("\n");

/** How far apart two reports of one event can be dated, for review items (there are few of them, so the look is wide). */
export const REVIEW_WINDOW: Record<string, number> = { CONTRACT: 90, M_AND_A: 60, PARTNERSHIP: 60, NEW_OFFERING: 45, ORG_CHANGE: 14, FINANCIAL_RESULTS: 14 };

const STOP = new Set(("a an and the of to in on for with by at from as its it is are be via over into under up through new this that their will has have " +
  "contract deal award win wins won new_win newwin renewal extension expansion services service solutions unnamed client undisclosed").split(" "));
const SUFFIX = new Set(["inc", "incorporated", "ltd", "limited", "plc", "llc", "corp", "corporation", "co", "company", "group", "holdings", "sa", "ag", "nv", "se", "gmbh", "pvt", "private", "the", "of", "and", "for"]);
export const words = (s: string | null) => (s ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
const nameTokens = (s: string | null) => new Set(words(s).filter(w => !SUFFIX.has(w)));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}
/** One name inside the other counts as a match too ("Home Office" / "UK Home Office"). */
export function clientSim(a: string | null, b: string | null): number {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return Math.max(n / (x.size + y.size - n), n / Math.min(x.size, y.size) >= 1 ? 0.8 : 0);
}
const money = (v: number | null) => v == null ? null : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}bn` : `$${(v / 1e6).toFixed(1)}m`;
const day = (d: Date | null) => d ? d.toISOString().slice(0, 10) : "undated";

export interface Ev {
  id: string; family: string; reason: string | null; label: string;
  title: string; date: Date | null; status: string; vendorKey: string; client: string | null; anon: boolean;
  type: string | null; eventStatus: string | null; stated: number | null; estimate: number | null; origValue: number | null; origCcy: string | null;
  term: number | null; scope: string | null; sources: number; created: Date;
  /** The provider's name, for matching a deal recorded from each party's side. */
  provider: string;
}

export function line(e: Ev, withFamily: boolean): string {
  // Only a value the parties stated is shown. Our own estimate is a calculation, and two similar records get the same
  // one, which reads as evidence of identity when it is none.
  const value = e.stated != null ? `${money(e.stated)} stated` : "not stated";
  return `(${day(e.date)}) [${withFamily ? e.family.toLowerCase() + " · " : ""}${e.type ?? "?"}${e.eventStatus ? ", " + e.eventStatus.toLowerCase() : ""}] ${e.label}: ${e.client ?? (e.anon ? "unnamed" : "none given")} | value: ${value}${e.term ? ` | term: ${e.term} months` : ""} | ${e.title.slice(0, 150)}${e.scope ? ` | scope: ${e.scope.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 170)}` : ""}`;
}

export const EV_SELECT = {
  id: true, family: true, eventType: true, reviewReason: true, canonicalTitle: true, announcementDate: true, publicationStatus: true, primaryEntityId: true, counterpartyRaw: true, eventStatus: true, createdAt: true,
  primaryEntity: { select: { canonicalName: true } },
  contractDetails: { select: { vendorRaw: true, clientRaw: true, clientAnonymised: true, contractEventType: true, tcvCommittedUsd: true, tcvEstimateMidUsd: true, tcvOriginalValue: true, tcvOriginalCurrency: true, contractLengthMonths: true, scopeSummary: true } },
  maDetails: { select: { maEventType: true, acquirerRaw: true, targetRaw: true, dealValueUsd: true, statusAtAnnouncement: true, rationale: true } },
  partnershipDetails: { select: { partnershipType: true, entityARaw: true, entityBRaw: true, scopeSummary: true } },
  offeringDetails: { select: { offeringType: true, offeringName: true, scopeSummary: true } },
  orgChangeDetails: { select: { orgEventType: true, personName: true, roleName: true } },
  _count: { select: { sourceEvents: true } },
} as const;

type EvRow = NonNullable<Awaited<ReturnType<typeof loadRows>>>[number];
async function loadRows(ids: string[]) {
  return prisma.canonicalMarketEvent.findMany({ where: { id: { in: ids } }, select: EV_SELECT });
}

/** Records by id, in pages (one query returning thousands of rows is dropped by the Neon websocket). */
export async function loadEvs(ids: string[]): Promise<Ev[]> {
  const out: Ev[] = [];
  for (let i = 0; i < ids.length; i += 500) for (const r of await loadRows(ids.slice(i, i + 500))) { const e = toEv(r); if (e) out.push(e); }
  return out;
}

export function toEv(e: EvRow): Ev | null {
  const cd = e.contractDetails, ma = e.maDetails, pt = e.partnershipDetails, of = e.offeringDetails, oc = e.orgChangeDetails;
  const provider = e.primaryEntity?.canonicalName ?? cd?.vendorRaw ?? e.canonicalTitle.split("|")[0];
  const vendorKey = e.primaryEntityId ?? (provider.trim() ? "raw:" + words(provider).join(" ") : "");
  if (!vendorKey) return null;
  // The other party: whichever named side is not the provider itself.
  const other = (...names: (string | null | undefined)[]) => names.find(n => !!n && clientSim(n, provider) < 0.5) ?? null;
  const positive = (v: number | null | undefined) => v && v > 0 ? v : null;   // a stated value of exactly 0 is an empty field
  let label = "client", client: string | null = null, type: string | null = e.eventType, stated: number | null = null, scope: string | null = null;
  if (e.family === "CONTRACT") { client = cd?.clientRaw ?? e.counterpartyRaw ?? null; type = cd?.contractEventType ?? e.eventType; stated = positive(cd?.tcvCommittedUsd); scope = cd?.scopeSummary ?? null; }
  else if (e.family === "M_AND_A") { label = "other party"; client = other(ma?.targetRaw, ma?.acquirerRaw, e.counterpartyRaw); type = [ma?.maEventType ?? e.eventType, ma?.statusAtAnnouncement].filter(Boolean).join("/"); stated = positive(ma?.dealValueUsd); scope = ma?.rationale ?? null; }
  else if (e.family === "PARTNERSHIP") { label = "partner"; client = other(pt?.entityBRaw, pt?.entityARaw, e.counterpartyRaw); type = pt?.partnershipType ?? e.eventType; scope = pt?.scopeSummary ?? null; }
  else if (e.family === "NEW_OFFERING") { label = "product"; client = of?.offeringName ?? null; type = of?.offeringType ?? e.eventType; scope = of?.scopeSummary ?? null; }
  else if (e.family === "ORG_CHANGE") { label = "person"; client = [oc?.personName, oc?.roleName].filter(Boolean).join(", ") || null; type = oc?.orgEventType ?? e.eventType; }
  else { label = "period"; client = null; }
  return {
    id: e.id, family: e.family, reason: e.reviewReason, label,
    title: e.canonicalTitle, date: e.announcementDate, status: e.publicationStatus, vendorKey: vendorKey + "|" + e.family, client, anon: !!cd?.clientAnonymised,
    type, eventStatus: e.eventStatus, stated, estimate: cd?.tcvEstimateMidUsd ?? null, origValue: cd?.tcvOriginalValue ?? null, origCcy: cd?.tcvOriginalCurrency ?? null,
    term: cd?.contractLengthMonths ?? null, scope, sources: e._count.sourceEvents, created: e.createdAt, provider: provider.trim(),
  };
}

/** Lower is the better record to keep: published, a stated value, more sources, more detail, older. */
const rank = (e: Ev) => [e.status === "published" ? 0 : 1, e.stated != null ? 0 : 1, -e.sources, -(e.scope?.length ?? 0) - (e.client ? 200 : 0) - (e.term ? 100 : 0), e.created.getTime()];
export const before = (a: Ev, b: Ev) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i]; return a.id < b.id; };

/**
 * Up to six better-ranked records in the same provider+family group, within the window, that share a counterparty, a
 * stated value or enough of a title to be worth asking about.
 */
export function candidatesFor(e: Ev, group: Ev[], windowDays: (family: string) => number): Ev[] {
  if (!e.date) return [];
  const vendorWords = new Set(words(group[0]?.title.split("|")[0] ?? ""));
  const tokens = (x: Ev) => new Set(words(x.title + " " + (x.scope ?? "").slice(0, 200)).filter(w => !STOP.has(w) && !vendorWords.has(w) && w.length > 1));
  const mine = tokens(e);
  const scored: [Ev, number][] = [];
  for (const o of group) {
    if (o.id === e.id || !o.date || !before(o, e)) continue;
    const gap = Math.abs(o.date.getTime() - e.date.getTime());
    if (gap > REMENTION_DAYS * DAY) continue;
    const c = clientSim(e.client, o.client);
    const sameValue = e.stated != null && o.stated != null && Math.abs(e.stated - o.stated) <= 0.01 * Math.max(e.stated, o.stated);
    // Beyond the normal window only one case is worth asking about: the same client and the same stated value,
    // which is how a contract re-reported months later shows up (and how its value gets counted twice).
    if (gap > windowDays(e.family) * DAY && !(sameValue && c >= 0.5)) continue;
    const t = jaccard(mine, tokens(o));
    const bothNamed = !!e.client && !!o.client;
    const plausible = c >= 0.5 || sameValue || t >= 0.4 || (!bothNamed && t >= 0.25) || (bothNamed && t >= 0.3);
    if (plausible) scored.push([o, c * 1.5 + t + (sameValue ? 0.5 : 0)]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, 6).map(s => s[0]);
}

/** One question to the model. Null when it could not answer. */
export async function judgeSame(e: Ev, cands: Ev[], opts: { model: string; system: string; withFamily: boolean }): Promise<{ same: number; why: string; costUsd: number } | null> {
  const m = DEDUPE_MODELS[opts.model];
  const user = `RECORD: ${line(e, opts.withFamily)}\n\nCANDIDATES:\n` + cands.map((c, n) => `${n + 1}. ${line(c, opts.withFamily)}`).join("\n");
  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
        headers: { "x-api-key": process.env.ANTHROPIC_API_KEY ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
        // 2500: on the hard comparisons the model thinks first, and a small allowance runs out mid-thought.
        body: JSON.stringify({ model: m.id, max_tokens: 2500, system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(60_000) });
      if (res.ok || (res.status !== 429 && res.status < 500)) break;
    } catch { res = null; }
    await new Promise(r => setTimeout(r, 1500 * 2 ** attempt));
  }
  if (!res || !res.ok) return null;
  const d = await res.json() as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  const u = d.usage ?? {};
  const costUsd = ((u.input_tokens ?? 0) * m.input + (u.cache_read_input_tokens ?? 0) * m.cacheRead + (u.cache_creation_input_tokens ?? 0) * m.cacheWrite + (u.output_tokens ?? 0) * m.output) / 1e6;
  const raw = (d.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
  const v = /"same"\s*:\s*(\d+)/.exec(raw);
  if (!v) return null;
  const n = Number(v[1]);
  return { same: n >= 1 && n <= cands.length ? n : 0, why: (/"why"\s*:\s*"([^"]*)/.exec(raw)?.[1] ?? "").slice(0, 140), costUsd };
}

/**
 * Fold a duplicate into its survivor. The duplicate's sources also support the survivor; they stay linked to the
 * duplicate too, so an undo needs nothing else. An article that only mentions the event in passing does not support
 * it, so it is not handed over.
 */
export async function foldDuplicate(loser: Pick<Ev, "id" | "reason">, keepId: string, why: string, action: string, opts: { fillCounterparty?: string } = {}): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const cur = await tx.canonicalMarketEvent.findUnique({ where: { id: loser.id }, select: { publicationStatus: true, sourceEvents: { select: { id: true } } } });
    if (!cur || cur.publicationStatus === "excluded_noise") return false;
    // A deal recorded from each party's side: the duplicate's provider is the survivor's missing counterparty.
    if (opts.fillCounterparty) await fillCounterparty(tx, keepId, opts.fillCounterparty);
    const donate = !(loser.reason ?? "").includes("event_source_mismatch");
    if (donate && cur.sourceEvents.length) await tx.canonicalMarketEvent.update({ where: { id: keepId }, data: { sourceEvents: { connect: cur.sourceEvents.map(s => ({ id: s.id })) } } });
    await tx.canonicalMarketEvent.update({ where: { id: loser.id }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: `duplicate_of:${keepId}` } });
    await tx.reviewAction.create({ data: { eventId: loser.id, action, previousValue: cur.publicationStatus, newValue: "excluded_noise", reviewerNote: `${DEDUPE_VERSION} duplicate_of:${keepId} · ${why}`.slice(0, 380) + ` · was:${loser.reason ?? ""}`.slice(0, 120) } });
    return true;
  });
}

/**
 * The daily review job's first stage: each given review item against the published catalogue and the rest of the
 * queue for its provider and family. Returns the ids folded as duplicates.
 */
export async function dedupeReviewItems(ids: string[], opts: { model: string; action: string }): Promise<{ folded: string[]; judged: number; costUsd: number }> {
  const items = await loadEvs(ids);
  const folded: string[] = [];
  let judged = 0, costUsd = 0;
  const windowDays = (f: string) => REVIEW_WINDOW[f] ?? 45;
  for (const e of items) {
    if (!e.date) continue;
    const from = new Date(e.date.getTime() - REMENTION_DAYS * DAY), to = new Date(e.date.getTime() + REMENTION_DAYS * DAY);
    const providerId = e.vendorKey.startsWith("raw:") ? null : e.vendorKey.split("|")[0];
    if (!providerId) continue;
    const peerIds = (await prisma.canonicalMarketEvent.findMany({
      where: { id: { not: e.id }, primaryEntityId: providerId, family: e.family, publicationStatus: { in: ["published", "needs_review"] }, announcementDate: { gte: from, lte: to } },
      select: { id: true }, take: 400,
    })).map(r => r.id);
    const group = [e, ...await loadEvs(peerIds)];
    const cands = candidatesFor(e, group, windowDays);
    if (!cands.length) continue;
    const v = await judgeSame(e, cands, { model: opts.model, system: SYSTEM_REVIEW, withFamily: true });
    if (!v) continue;
    judged++; costUsd += v.costUsd;
    if (v.same && await foldDuplicate(e, cands[v.same - 1].id, v.why, opts.action)) folded.push(e.id);
  }
  // The same deal recorded from the other party's side (a different provider, so the check above never sees it).
  for (const e of items) {
    if (folded.includes(e.id) || !e.date || !MIRROR_FAMILIES.has(e.family)) continue;
    const party = otherParty(e);
    if (!party) continue;
    const from = new Date(e.date.getTime() - (REVIEW_WINDOW[e.family] ?? 45) * DAY), to = new Date(e.date.getTime() + (REVIEW_WINDOW[e.family] ?? 45) * DAY);
    const peers = await loadEvs((await prisma.canonicalMarketEvent.findMany({
      where: { id: { not: e.id }, family: e.family, publicationStatus: { in: ["published", "needs_review"] }, announcementDate: { gte: from, lte: to },
        primaryEntity: { canonicalName: { contains: party.split(/\s+/)[0], mode: "insensitive" } } },
      select: { id: true }, take: 200,
    })).map(r => r.id));
    const cands = mirrorCandidates(e, indexByProvider(peers), f => REVIEW_WINDOW[f] ?? 45);
    if (!cands.length) continue;
    const v = await judgeSame(e, cands, { model: opts.model, system: SYSTEM_MIRROR, withFamily: true });
    if (!v) continue;
    judged++; costUsd += v.costUsd;
    if (v.same) { const keep = cands[v.same - 1]; if (await foldDuplicate(e, keep.id, v.why, opts.action, { fillCounterparty: otherParty(keep) ? undefined : e.provider })) folded.push(e.id); }
  }
  return { folded, judged, costUsd };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Name the survivor's counterparty when it has none, and lift a no_counterparty hold that only that caused. */
async function fillCounterparty(tx: Tx, id: string, name: string): Promise<void> {
  const e = await tx.canonicalMarketEvent.findUnique({ where: { id }, select: { counterpartyRaw: true, reviewReason: true, publicationStatus: true,
    contractDetails: { select: { clientRaw: true } }, maDetails: { select: { targetRaw: true } }, partnershipDetails: { select: { entityBRaw: true } } } });
  if (!e) return;
  const reasons = (e.reviewReason ?? "").split(",").map(r => r.trim()).filter(Boolean);
  const rest = reasons.filter(r => r !== "no_counterparty");
  await tx.canonicalMarketEvent.update({ where: { id }, data: {
    counterpartyRaw: e.counterpartyRaw ?? name,
    ...(e.publicationStatus === "needs_review" && rest.length < reasons.length ? (rest.length ? { reviewReason: rest.join(",") } : { reviewReason: null, publicationStatus: "published", humanReviewRequired: false }) : {}),
  } });
  if (e.contractDetails && !e.contractDetails.clientRaw) await tx.contractDetails.update({ where: { canonicalEventId: id }, data: { clientRaw: name, clientAnonymised: false } });
  if (e.maDetails && !e.maDetails.targetRaw) await tx.maDetails.update({ where: { canonicalEventId: id }, data: { targetRaw: name } });
  if (e.partnershipDetails && !e.partnershipDetails.entityBRaw) await tx.partnershipDetails.update({ where: { canonicalEventId: id }, data: { entityBRaw: name } });
}

/** The other party as a record names it: its counterparty, else the third field of its "Provider | Type | Party | Scope" title. */
export function otherParty(e: Pick<Ev, "client" | "title">): string | null {
  if (e.client) return e.client;
  const seg = e.title.split("|").map(x => x.trim());
  return seg.length >= 3 && seg[2] && !/^(n\/a|none|internal|unnamed|undisclosed)/i.test(seg[2]) ? seg[2] : null;
}

export const SYSTEM_MIRROR = [
  "You compare records in an IT-services market tracker that tracks many providers. The same deal between two tracked providers is often recorded twice, once from each side: provider A with partner B, and provider B with partner A.",
  "Decide whether RECORD describes the same event as one of the numbered CANDIDATES, allowing for the two parties being swapped.",
  "Same event: the same specific partnership, alliance, acquisition or contract between the same two organisations, announced at about the same time, even when worded from the other party's point of view.",
  "NOT the same: a different deal between the same two organisations (an earlier alliance and a later expansion, an announced acquisition and its completion); a different scope or programme; dates far apart with no sign it is the same announcement.",
  "If you are not sure, answer 0.",
  "Reply with JSON only: {\"same\": <candidate number, or 0 for none>, \"why\": \"<12 words>\"}",
].join("\n");

/** Families where both parties can be tracked providers, so a deal can appear once per side. */
export const MIRROR_FAMILIES = new Set(["PARTNERSHIP", "M_AND_A", "CONTRACT"]);

/**
 * Records that may be this one seen from the other side: same family, close in date, the candidate's provider is this
 * record's other party and the candidate's other party (when it names one) is this record's provider. Only
 * better-ranked candidates are returned, so the better record survives.
 */
export function mirrorCandidates(e: Ev, byProvider: Map<string, Ev[]>, windowDays: (family: string) => number): Ev[] {
  if (!e.date || !MIRROR_FAMILIES.has(e.family)) return [];
  const party = otherParty(e);
  if (!party) return [];
  const out: [Ev, number][] = [];
  for (const [prov, group] of byProvider) {
    if (clientSim(party, prov) < 0.5) continue;
    for (const o of group) {
      if (o.id === e.id || o.family !== e.family || !o.date || !before(o, e)) continue;
      if (Math.abs(o.date.getTime() - e.date.getTime()) > windowDays(e.family) * DAY) continue;
      const theirs = otherParty(o);
      const back = theirs ? clientSim(theirs, e.provider) : (o.title.toLowerCase().includes(e.provider.toLowerCase()) ? 0.6 : 0);
      if (back < 0.5) continue;
      out.push([o, back - Math.abs(o.date.getTime() - e.date.getTime()) / (365 * DAY)]);
    }
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]);
}

/** Provider name -> records, for mirrorCandidates. */
export function indexByProvider(evs: Ev[]): Map<string, Ev[]> {
  const m = new Map<string, Ev[]>();
  for (const e of evs) if (e.provider && MIRROR_FAMILIES.has(e.family)) (m.get(e.provider) ?? m.set(e.provider, []).get(e.provider)!).push(e);
  return m;
}
