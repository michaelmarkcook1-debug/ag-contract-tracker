/**
 * Second opinion on flagged events (src/lib/ingestion/source-check.ts).
 * Live: three short model calls, about one cent.
 *
 * Run: npx tsx scripts/tests/source-check.ts
 */
import { confirmFlaggedSources, firstPassSupports } from "@/lib/ingestion/source-check";
import type { GroundedEvent, Reading } from "@/lib/ingestion/reader";
import type { RawArticle } from "@/lib/ingestion/crawler";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) pass++; else fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

const article = (title: string): RawArticle => ({ title, url: "https://example.invalid/source-check", publishedAt: "2026-11-20T09:00:00Z", snippet: null, sourceId: "test", provider: "test", sourceType: "wire_service", publisherUrl: null, bodyText: null });
const event = (provider: string, buyer: string, title: string, quote: string): GroundedEvent =>
  ({ family: "CONTRACT", provider, buyer, title, supporting: { event: quote }, dropped: [] } as unknown as GroundedEvent);
const reading = (events: GroundedEvent[]): Reading => ({ articleType: "NEWS_REPORT", events } as unknown as Reading);

(async () => {
  console.log("=== headline names only the vendor; the body names the buyer ===");
  {
    const a = article("IBM secures a $26 million contract to modernize Defense information software through 2029");
    const text = "IBM has been awarded a contract worth $26 million by Spain's Ministry of Defense to modernise the software licences behind the armed forces' information systems. The agreement, signed this week in Madrid, runs until the end of 2029 and covers licence consolidation, support and migration services. The ministry said the award followed an open procedure.";
    const ev = event("IBM", "Ministry of Defense (Spain)", "IBM | New Win | Ministry of Defense (Spain) | Software license modernization", "IBM has been awarded a contract worth $26 million by Spain's Ministry of Defense");
    const r = reading([ev]);
    ok("the headline rule flags it", !firstPassSupports(a, text, r, ev));
    const cost = await confirmFlaggedSources(a, text, r);
    ok("the second opinion lifts the flag", ev.sourceConfirmed === true, `${ev.sourceCheck?.verdict}: ${ev.sourceCheck?.why}`);
    ok("the check was paid for and is small", cost > 0 && cost < 0.02, `$${cost.toFixed(4)}`);
  }

  console.log("\n=== a share-price story that mentions an old deal in passing ===");
  {
    const a = article("Infosys shares rise 12.9% as AI deals build");
    const text = "Shares of Infosys climbed 12.9% over the past month as investors warmed to the company's artificial-intelligence pipeline. Analysts at two brokerages raised their price targets, citing margin resilience and a steadier demand outlook in North America. Some investors also pointed to the company's long-running relationship with Truist, which was expanded earlier this year, as evidence that large clients are consolidating work. The stock closed at a 52-week high on Friday, and volumes were nearly double the three-month average.";
    const ev = event("Infosys", "Truist", "Infosys | Expansion | Truist | AI-led cloud and ERP transformation partnership", "the company's long-running relationship with Truist, which was expanded earlier this year");
    const r = reading([ev]);
    ok("the headline rule flags it", !firstPassSupports(a, text, r, ev));
    await confirmFlaggedSources(a, text, r);
    ok("the second opinion keeps the flag", ev.sourceConfirmed !== true, `${ev.sourceCheck?.verdict}: ${ev.sourceCheck?.why}`);
  }

  console.log("\n=== an event the headline rule already accepts is never re-checked ===");
  {
    const a = article("Infosys wins five-year application services deal with Danske Bank");
    const text = "Infosys said on Monday it had won a five-year application services contract from Danske Bank covering its retail and business banking platforms.";
    const ev = event("Infosys", "Danske Bank", "Infosys | New Win | Danske Bank | Application services", "Infosys said on Monday it had won a five-year application services contract from Danske Bank");
    const r = reading([ev]);
    ok("the headline rule accepts it", firstPassSupports(a, text, r, ev));
    const cost = await confirmFlaggedSources(a, text, r);
    ok("no model call is made", cost === 0 && ev.sourceCheck === undefined);
  }

  console.log("\n=== the check fails closed ===");
  {
    const a = article("IBM secures a $26 million contract to modernize Defense information software");
    const text = "IBM has been awarded a contract worth $26 million by Spain's Ministry of Defense.";
    const ev = event("IBM", "Ministry of Defense (Spain)", "IBM | New Win | Ministry of Defense (Spain) | Software license modernization", "IBM has been awarded a contract worth $26 million by Spain's Ministry of Defense");
    const key = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try { await confirmFlaggedSources(a, text, reading([ev])); } finally { process.env.ANTHROPIC_API_KEY = key; }
    ok("with the model unavailable the event stays flagged", ev.sourceConfirmed !== true && ev.sourceCheck?.verdict === "UNAVAILABLE");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
