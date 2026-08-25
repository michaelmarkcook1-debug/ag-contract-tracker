/**
 * P0 truth-integrity regression suite.
 * Covers the failure cases named in the remediation brief (A-H).
 * Deterministic cases run offline; LLM cases require ANTHROPIC_API_KEY.
 */
import { isRelevantArticle } from "../../src/lib/ingestion/sources";
import { llmExtract } from "../../src/lib/ingestion/classifier";
import type { RawArticle } from "../../src/lib/ingestion/crawler";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const art = (title: string, snippet: string, sourceType: string, publishedAt: string | null = "2026-08-20"): RawArticle =>
  ({ title, url: `https://example.com/p0-${Math.abs(title.length * 7)}-${Date.now()}`, publishedAt, snippet,
     sourceId: "t", provider: "Market Wide", sourceType });

async function main() {
  console.log("\n=== DETERMINISTIC (§5-§7 contract classification) ===");

  // Case C — procurement opportunity must NOT be CONTRACT
  const c = isRelevantArticle("Authority X has issued a tender seeking suppliers for a five-year managed-services contract", "procurement_notice");
  ok("C  tender is not CONTRACT", c.family !== "CONTRACT", `family=${c.family}`);

  // Case D — genuine award may be CONTRACT
  const d = isRelevantArticle("Authority X has awarded Provider Y a five-year managed-services contract", "procurement_notice");
  ok("D  award is CONTRACT", d.family === "CONTRACT", `family=${d.family}`);

  // Case E — procurement source with award language
  const e = isRelevantArticle("Council selects Capgemini as supplier under signed five-year agreement", "procurement_notice");
  ok("E  procurement award via evidence", e.family === "CONTRACT", `family=${e.family}`);

  // Case F — wire-service partnership must not be forced to CONTRACT
  const f = isRelevantArticle("Atento and Cresta sign strategic partnership for hybrid CX", "wire_service");
  ok("F  wire partnership not CONTRACT", f.family !== "CONTRACT", `family=${f.family}`);

  // extra: RFP / EOI / PIN
  for (const [label, t] of [["RFP","Agency issues request for proposal for IT services"],
                            ["EOI","Ministry publishes expression of interest for cloud suppliers"],
                            ["PIN","Prior information notice: upcoming managed services opportunity"]] as const) {
    const r = isRelevantArticle(t, "procurement_notice");
    ok(`   ${label} not CONTRACT`, r.family !== "CONTRACT", `family=${r.family}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) { console.log("\n(no API key — skipping LLM cases)"); return; }

  console.log("\n=== LLM (§2-§3 TCV) ===");
  // Case A — no disclosed value must NOT be estimated
  const a = await llmExtract(art("Provider X signs five-year outsourcing agreement with Client Y",
    "Infosys has signed a five-year application outsourcing agreement with Deutsche Bank covering core platforms. No financial terms were disclosed.", "wire_service"));
  ok("A  undisclosed -> tcvUsd null", !!a && a.tcvUsd === null, `tcvUsd=${a?.tcvUsd}`);
  ok("A  undisclosed -> not estimate", !!a && a.tcvIsEstimate === false, `isEstimate=${a?.tcvIsEstimate}`);

  // Case B — disclosed value must still extract
  const b = await llmExtract(art("Provider X signs five-year agreement worth $90 million",
    "Capgemini has signed a five-year managed services agreement with Lloyds Banking Group valued at $90 million.", "wire_service"));
  const bOk = !!b && b.tcvUsd !== null && b.tcvUsd >= 85_000_000 && b.tcvUsd <= 95_000_000;
  ok("B  disclosed -> value retained", bOk, `tcvUsd=${b?.tcvUsd}`);
  ok("B  disclosed -> not estimate", !!b && b.tcvIsEstimate === false, `isEstimate=${b?.tcvIsEstimate}`);

  // Large-deal temptation: benchmark bait with no stated value
  const g = await llmExtract(art("Accenture wins major global transformation programme with Fortune 500 bank",
    "Accenture has been selected by a Fortune 500 bank for a large multi-year global digital transformation covering 40 countries. Terms were not disclosed.", "wire_service"));
  ok("A2 benchmark bait -> null", !!g && g.tcvUsd === null, `tcvUsd=${g?.tcvUsd}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
