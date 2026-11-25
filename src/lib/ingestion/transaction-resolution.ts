import type { Prisma } from "../../generated/prisma/client";
import { sameTransaction, sourceSupportsEvent, transactionIdentity, TRANSACTION_WINDOW_DAYS, type TransactionRecord } from "../event-identity";

export function storedEventQuote(json: string | null): string | null {
  try {
    const event = JSON.parse(json ?? "null")?.event;
    return typeof event === "string" ? event : null;
  } catch { return null; }
}

export type TransactionResolution = "attached" | "ambiguous" | "none";

/** Keep the lookup, source connection (or caller's insert), and receipt under one provider lock. */
export async function resolveTransaction(tx: Prisma.TransactionClient, incoming: TransactionRecord,
  providerId: string | null, sourceId: string): Promise<TransactionResolution> {
  if (incoming.family !== "M_AND_A" || !providerId || !incoming.announcementDate) return "none";
  const day = new Date(incoming.announcementDate);
  if (!Number.isFinite(day.getTime())) return "none";
  const fields = { sourceUrl: true, sourceTitle: true, publisherUrl: true, sourceType: true } as const;
  const current = await tx.sourceEvent.findUniqueOrThrow({ where: { id: sourceId }, select: fields });
  // Headline detail helps legacy titles such as "Provider | M&A | Target".
  // Never promote an unscoped article body to transaction evidence.
  const contextualTitle = (r: TransactionRecord, source: typeof current) =>
    source.sourceTitle && sourceSupportsEvent(source, { family: r.family, providerName: r.provider, referenceTitle: r.canonicalTitle, counterpartyNames: [r.target] })
      && r.target && !source.sourceTitle.includes("|") ? r.canonicalTitle + " | " + source.sourceTitle : r.canonicalTitle;
  const observed = { ...incoming, canonicalTitle: contextualTitle(incoming, current) };
  const identity = transactionIdentity(observed);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"mna:"+providerId}))`;
  const window = TRANSACTION_WINDOW_DAYS * 86_400_000;
  const rows = await tx.canonicalMarketEvent.findMany({
    where: { family: "M_AND_A", primaryEntityId: providerId, announcementDateBasis: { not: "unavailable" }, publicationStatus: { in: ["published", "needs_review"] },
      announcementDate: { gte: new Date(+day - window), lte: new Date(+day + window) } },
    select: { id: true, family: true, canonicalTitle: true, counterpartyRaw: true, eventType: true, eventStatus: true,
      announcementDate: true, originalArticleUrl: true, supportingText: true, reviewReason: true, sourceEvents: { select: fields },
      maDetails: { select: { targetRaw: true, stakePercent: true, maEventType: true, statusAtAnnouncement: true } } },
  });
  const matches: string[] = [];
  let possible = false;
  for (const c of rows) {
    if (c.reviewReason?.includes("event_source_mismatch")) continue;
    const row: TransactionRecord = { ...c, provider: incoming.provider, target: c.maDetails?.targetRaw ?? c.counterpartyRaw,
      eventType: c.maDetails?.maEventType ?? c.eventType, eventStatus: c.eventStatus ?? c.maDetails?.statusAtAnnouncement,
      stakePercent: c.maDetails?.stakePercent, evidenceText: storedEventQuote(c.supportingText) };
    const original = c.sourceEvents.find(s => s.sourceUrl === c.originalArticleUrl || (!!s.publisherUrl && s.publisherUrl === c.originalArticleUrl));
    if (original) row.canonicalTitle = contextualTitle(row, original);
    if (sameTransaction(observed, row)) matches.push(c.id);
    const other = transactionIdentity(row);
    if (identity && other && identity.target === other.target && identity.kind === other.kind && identity.stage === other.stage) possible = true;
  }
  if (matches.length !== 1) return matches.length || possible ? "ambiguous" : "none";
  const id = matches[0];
  await tx.canonicalMarketEvent.update({ where: { id }, data: { sourceEvents: { connect: { id: sourceId } } } });
  await tx.reviewAction.create({ data: { eventId: id, action: "transaction_evidence_attached",
    reviewerNote: "Unique transaction match on specific deal evidence with compatible parties, stage and terms.",
    newValue: JSON.stringify({ sourceId, identity }) } });
  return "attached";
}

/** Legacy writers: run the source gate first; create on false in THIS transaction, never via fuzzy/month-key matching. */
export async function attachExistingTransaction(tx: Prisma.TransactionClient, incoming: TransactionRecord,
  providerId: string | null, sourceId: string): Promise<boolean> {
  return (await resolveTransaction(tx, incoming, providerId, sourceId)) === "attached";
}
