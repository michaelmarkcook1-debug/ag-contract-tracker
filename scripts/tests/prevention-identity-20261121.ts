import assert from "node:assert/strict";
import test from "node:test";
import { sameTransaction, sourceSupportsEvent, type TransactionRecord } from "../../src/lib/event-identity";
import { FIXTURES } from "./fixtures/regression-articles";

const deal = (title: string, patch: Partial<TransactionRecord> = {}): TransactionRecord => ({
  family: "M_AND_A", canonicalTitle: title, provider: "TCS", target: "MHP",
  announcementDate: "2026-08-24", ...patch,
});
const base = deal("TCS agrees to acquire MHP from Porsche for EUR 374 million");
for (const [label, other, expected] of [
  ["same consideration across sources", deal("TCS to buy MHP for EUR 374m", { provider: "Tata Consultancy Services", announcementDate: "2026-11-21" }), true],
  ["same consideration, other currency", deal("TCS to acquire MHP for GBP 374m"), false],
  ["different consideration", deal("TCS to acquire MHP from Porsche for EUR 390m"), false],
  ["rumour", deal("TCS in talks to acquire MHP from Porsche for EUR 374m"), false],
  ["completion", deal("TCS completes acquisition of MHP from Porsche for EUR 374m"), false],
  ["approval", deal("Commission approves TCS acquisition of MHP from Porsche for EUR 374m"), false],
  ["divestiture", deal("TCS sells MHP for EUR 374m"), false],
  ["partial stake", deal("TCS to acquire 49% stake in MHP from Porsche for EUR 374m"), false],
  ["multiple targets", deal("TCS acquires MHP and Omega from Porsche", { target: "MHP and Omega" }), false],
  ["outside time window", deal(base.canonicalTitle, { announcementDate: "2025-01-01" }), false],
  ["invalid date", deal(base.canonicalTitle, { announcementDate: "not a date" }), false],
  ["no source date", deal(base.canonicalTitle, { announcementDate: null }), false],
] as const) test(label, () => assert.equal(sameTransaction(base, other), expected));
test("parties and date (even exact date and generic headline) are not sufficient", () => {
  const weak = deal("TCS acquires MHP");
  assert.equal(sameTransaction(weak, weak), false);
});
test("shared target revenue or client/supplier names are not deal consideration or seller evidence", () => {
  const row = deal("TCS agrees to buy MHP", { evidenceText: "MHP reported EUR 374 million in annual revenue from Porsche." });
  assert.equal(sameTransaction(row, row), false);
  const scoped = deal("TCS to buy MHP", { evidenceText: "TCS agrees to buy MHP for EUR 374 million." });
  assert.equal(sameTransaction(scoped, base), true);
});
test("different stakes and follow-on tranches stay separate", () => {
  assert.equal(sameTransaction(deal("TCS buys an initial 20% stake in MHP for EUR 90m"),
    deal("TCS buys an additional 20% stake in MHP for EUR 90m")), false);
});
const ctx = { family: "CONTRACT", referenceTitle: "TCS | NEW_WIN | Porsche | Cloud", providerName: "TCS", counterpartyNames: ["Porsche"] };
test("historical mention in different client's story cannot prove a new award", () => {
  assert.equal(sourceSupportsEvent({ sourceTitle: "TCS signs Bosch cloud contract", rawText: "In August TCS signed a contract with Porsche.", sourceType: "vendor_press_release" },
    { ...ctx, eventQuote: "In August TCS signed a contract with Porsche." }), false);
});
test("a genuine older announcement is still supported", () => {
  assert.equal(sourceSupportsEvent({ sourceTitle: "In 2019 TCS signed a contract with Porsche", rawText: "In 2019 TCS signed a contract with Porsche." }, ctx), true);
});
test("feed label is not evidence for an anonymous award", () => {
  assert.equal(sourceSupportsEvent({ sourceTitle: "CGI selected by a bank", sourceName: "TCS" }, { ...ctx, counterpartyNames: [] }), false);
  assert.equal(sourceSupportsEvent({ sourceTitle: "TCS selected by a bank" }, { ...ctx, counterpartyNames: [] }), true);
});
test("named award in real regression fixture deep in official earnings; no reader or paid call", () => {
  const f = FIXTURES.find(f => f.id === "H")!;
  const s = { sourceTitle: f.title, sourceType: f.sourceType, rawText: f.text };
  const c = { ...ctx, providerName: "Wipro", referenceTitle: "Wipro | NEW_WIN | Mars", counterpartyNames: ["Mars, Incorporated"], articleType: "EARNINGS" };
  assert.equal(sourceSupportsEvent(s, c), true);
  assert.equal(sourceSupportsEvent(s, { ...c, counterpartyNames: ["Porsche"] }), false);
  assert.equal(sourceSupportsEvent({ ...s, rawText: "Porsche is a former customer. We won a contract with Bosch." }, { ...c, counterpartyNames: ["Porsche"] }), false);
});
test("both named awards in real multi-event fixture", () => {
  const f = FIXTURES.find(f => f.id === "I")!;
  for (const buyer of ["APG", "Proximus"]) assert.equal(sourceSupportsEvent({ sourceTitle: f.title, sourceType: f.sourceType, rawText: f.text },
    { ...ctx, referenceTitle: "TCS | CONTRACT | " + buyer, counterpartyNames: [buyer] }), true);
});
