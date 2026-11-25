import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { assembleReading, reconcile, type GroundedEvent } from "../../src/lib/ingestion/reader";
import type { RawArticle } from "../../src/lib/ingestion/crawler";
import type * as Store from "../../src/lib/ingestion/store";

// A private in-process Prisma double: no connection string, model call or network.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const events: Row[] = [], sources: Row[] = [], receipts: Row[] = [], lookups: Row[] = [], locks: string[] = [];
const related = (e: Row) => ({ ...e, sourceEvents: sources.filter(s => e.links.includes(s.id)) });
const db = {
  $executeRaw: async (_sql: TemplateStringsArray, key: string) => { locks.push(key); },
  entity: { findFirst: async ({ where }: Row) => ({ id: where.OR[0].canonicalName.equals }) },
  sourceEvent: {
    findUnique: async ({ where }: Row) => sources.find(s => s.sourceUrl === where.sourceUrl),
    findUniqueOrThrow: async ({ where }: Row) => {
      const found = sources.find(s => s.id === where.id);
      assert.ok(found); return { ...found, canonicalEvents: events.filter(e => e.links.includes(found.id)).map(related) };
    },
    create: async ({ data }: Row) => { const s = { ...data, id: "s" + sources.length }; sources.push(s); return s; },
    update: async ({ where, data }: Row) => {
      const s = sources.find(s => s.id === where.id)!;
      Object.assign(s, data);
      for (const { id } of data.canonicalEvents?.connect ?? []) events.find(e => e.id === id)!.links.push(s.id);
      return s;
    },
    findMany: async ({ where }: Row) => sources.filter(s => s.articleTextHash === where.articleTextHash &&
      s.promptPolicyVersion === where.promptPolicyVersion && where.processingStatus.in.includes(s.processingStatus))
      .map(s => ({ ...s, canonicalEvents: events.filter(e => e.links.includes(s.id)).map(related) })),
  },
  canonicalMarketEvent: {
    findMany: async ({ where }: Row) => {
      lookups.push(where); assert.deepEqual(where.publicationStatus, { in: ["published", "needs_review"] });
      assert.deepEqual(where.announcementDateBasis, { not: "unavailable" });
      return events.filter(e => e.family === where.family && e.primaryEntityId === where.primaryEntityId &&
        where.publicationStatus.in.includes(e.publicationStatus) && e.announcementDateBasis !== "unavailable" &&
        e.announcementDate >= where.announcementDate.gte && e.announcementDate <= where.announcementDate.lte).map(related);
    },
    findUnique: async ({ where }: Row) => events.find(e => where.id ? e.id === where.id : e.canonicalContractEventId === where.canonicalContractEventId),
    create: async ({ data }: Row) => {
      assert.ok(!events.some(e => e.canonicalContractEventId === data.canonicalContractEventId));
      const e = { ...data, id: "e" + events.length, links: [data.sourceEvents.connect.id], primaryEntity: { canonicalName: data.primaryEntityId } };
      events.push(e); return e;
    },
    update: async ({ where, data }: Row) => {
      const e = events.find(e => e.id === where.id)!;
      if (data.sourceEvents?.connect) e.links.push(data.sourceEvents.connect.id);
      for (const [k, v] of Object.entries(data)) if (k !== "sourceEvents" && v !== undefined) e[k] = v;
      return e;
    },
  },
  contractDetails: { create: async ({ data }: Row) => { events.find(e => e.id === data.canonicalEventId)!.contractDetails = { ...data, id: data.canonicalEventId }; },
    update: async () => ({}) },
  reviewAction: { create: async ({ data }: Row) => { receipts.push(data); } },
};
let writer: typeof Store;
before(async () => {
  Object.assign(globalThis, { prisma: { ...db, $transaction: (f: (tx: typeof db) => unknown) => f(db) } });
  writer = await import("../../src/lib/ingestion/store");
});
beforeEach(() => { events.length = sources.length = receipts.length = lookups.length = locks.length = 0; });
function article(title: string, text: string, date: string | null = "2023-10-05"): RawArticle {
  return { title, url: "https://example.invalid/story/" + sources.length, publishedAt: date, sourceType: "vendor_press_release",
    sourceId: "test", provider: "TCS", snippet: null, bodyText: text };
}
function read(family: string, buyer: string | null, quote: string, opts: Row = {}) {
  const event = { family, eventStatus: "ANNOUNCED", commercialEventType: family === "CONTRACT" ? "NEW_WIN" : "OTHER_COMMERCIAL_EVENT",
    provider: "TCS", buyer, title: "TCS | " + family + " | " + buyer, eventQuote: quote, contractValue: 50_000_000,
    currency: "USD", valueIsTcv: true, valueQuote: quote, ...opts };
  const out = assembleReading(quote, [{ parsed: { articleType: "COMPANY_ANNOUNCEMENT", events: [event] },
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }]);
  assert.ok(out.ok); return out.reading;
}
async function put(family: string, buyer: string, quote: string, opts: Row = {}, headline = quote, date: string | null = "2023-10-05") {
  const a = article(headline, quote, date);
  return writer.storeReading(a, quote, read(family, buyer, quote, opts), "test");
}
const contract = "TCS wins Porsche contract ID PO-104 for Typhoon turbine telemetry.";
test("same month's independent awards and renewal persist; confirmed duplicate retains both sources", async () => {
  assert.equal((await put("CONTRACT", "Porsche", contract)).published, 1);
  assert.equal((await put("CONTRACT", "Porsche", contract)).merged, 1);
  assert.equal((await put("CONTRACT", "Porsche", "TCS wins Porsche contract ID PO-105 for a new logistics application.")).published, 1);
  assert.equal((await put("CONTRACT", "Porsche", contract, { commercialEventType: "RENEWAL" })).published, 1);
  assert.equal(events.length, 3); assert.equal(new Set(events.map(e => e.canonicalContractEventId)).size, 3);
  assert.deepEqual(events.map(e => e.links.length), [2, 1, 1]);
});
test("buyer, date, type and amount without deal-specific evidence cannot decide a contract match", async () => {
  await put("CONTRACT", "Porsche", "TCS signs a contract with Porsche.");
  assert.equal((await put("CONTRACT", "Porsche", "Porsche selects TCS for a services agreement.")).merged, 0);
  assert.equal(events.length, 2);
});
test("historical source mismatch before existing lookup: standalone review, no enrichment or published link", async () => {
  await put("CONTRACT", "Porsche", contract);
  const n = lookups.length;
  const result = await put("CONTRACT", "Porsche", contract, {}, "TCS wins unrelated Bosch contract");
  assert.equal(result.queued, 1); assert.equal(result.merged, 0); assert.equal(lookups.length, n);
  assert.equal(events[1].publicationStatus, "needs_review"); assert.match(events[1].reviewReason, /event_source_mismatch/);
  assert.deepEqual(events[0].links, ["s0"]); assert.equal(sources[1].processingStatus, "extracted");
});
test("duplicate-content handoff cannot propagate wrong canonical links or count an unattached source", async () => {
  await put("CONTRACT", "Porsche", contract);
  const prior = { id: "s0", eventIds: ["e0"], processingStatus: "extracted", exclusionReason: null };
  const wrong = article("TCS wins other contract for Bosch", contract);
  assert.equal(await writer.storeDuplicateContent(wrong, contract, sources[0].articleTextHash, prior, "test"), 0);
  assert.deepEqual(events[0].links, ["s0"]); assert.equal(sources[1].processingStatus, "needs_review");
  const good = article(contract, contract);
  assert.ok(await writer.findReadByContent(sources[0].articleTextHash, good.title, good, contract));
  assert.equal(await writer.storeDuplicateContent(good, contract, sources[0].articleTextHash, prior, "test"), 1);
  assert.deepEqual(events[0].links, ["s0", "s2"]);
});
test("M&A evidence connection and audit receipt; no arbitrary winner if multiple rows qualify", async () => {
  const q = "TCS agrees to acquire MHP from Porsche for EUR 374 million";
  await put("M_AND_A", "MHP", q);
  assert.equal((await put("M_AND_A", "MHP", q)).merged, 1);
  assert.equal(events.length, 1); assert.deepEqual(events[0].links, ["s0", "s1"]);
  assert.equal(receipts.length, 1); assert.ok(locks.includes("mna:TCS"));
  events.push({ ...events[0], id: "another", canonicalContractEventId: "fixture", links: ["s0"] });
  assert.equal((await put("M_AND_A", "MHP", q)).queued, 1);
  assert.equal(receipts.length, 1); assert.equal(events[2].reviewReason, "possible_duplicate");
});
test("weak M&A and completion never fall through to fuzzy or monthly-key merge", async () => {
  await put("M_AND_A", "MHP", "TCS acquires MHP");
  const ambiguous = await put("M_AND_A", "MHP", "TCS announces acquisition of MHP");
  assert.equal(ambiguous.queued, 1); assert.equal(ambiguous.merged, 0);
  const completion = await put("M_AND_A", "MHP", "TCS completes acquisition of MHP", { eventStatus: "COMPLETED" });
  assert.equal(completion.published, 1); assert.equal(events.length, 3);
  assert.equal(await writer.findReadByContent(sources[0].articleTextHash, sources[0].sourceTitle), null);
});
test("other families need positive evidence; two products of the same alliance stay distinct", async () => {
  const q = "TCS and Bosch announce a technology partnership to deliver turbine diagnostics on the Nimbus platform.";
  const b = "TCS and Bosch announce a technology partnership to provide claims underwriting on Lightning.";
  await put("PARTNERSHIP", "Bosch", q);
  assert.equal((await put("PARTNERSHIP", "Bosch", b)).published, 1);
  assert.equal((await put("PARTNERSHIP", "Bosch", q)).merged, 1);
  assert.deepEqual(events.map(e => e.links.length), [2, 1]);
});
test("undated observation neither searches using admission date nor persists a made-up award date", async () => {
  for (const family of ["CONTRACT", "M_AND_A", "PARTNERSHIP"]) {
    const q = family === "M_AND_A" ? "TCS acquires Porsche for EUR 374m" : contract;
    await put(family, "Porsche", q, {}, q, null);
    assert.equal(events.at(-1)!.announcementDate, null);
    assert.equal(events.at(-1)!.announcementDateBasis, "unavailable");
  }
  assert.equal(lookups.length, 0);
});
test("segment reconciliation cannot swallow distinct deals in any family", () => {
  for (const family of ["M_AND_A", "CONTRACT", "PARTNERSHIP"]) {
    const a = read(family, "MHP", "TCS and MHP announce agreement Alpha").events[0];
    const b: GroundedEvent = { ...a, supporting: { event: "TCS and MHP announce agreement Beta" } };
    assert.equal(reconcile([a, b]).length, 2);
    assert.equal(reconcile([a, a]).length, 1);
  }
});
