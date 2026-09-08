/** §15/§16/§19 validation for the comparable TCV engine. */
import { prisma } from "../../src/lib/db";
import { inferTcv, loadComparablePools, clampEstimate, isApprovedEstimateBasis, MIN_ANCHORS } from "../../src/lib/tcv/infer";
import { formatTcvDisplay } from "../../src/lib/types";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

async function main() {
  const pools = await loadComparablePools();
  console.log(`comparable cells built: ${pools.size}  (min anchors ${MIN_ANCHORS}; line → segment → global fallback)\n`);

  console.log("=== INFERENCE (2026-09-08 policy: estimate, label, never mix with disclosed) ===");
  const disclosed = await inferTcv({ serviceLine: "ITO", sourceType: "procurement_notice", contractLengthMonths: 36, disclosedUsd: 120_000_000 });
  ok("disclosed value -> no inference attempted", disclosed.state === "NOT_RELIABLY_ESTIMABLE");
  for (const generic of ["", "unspecified", "other"]) {
    const r = await inferTcv({ serviceLine: generic, sourceType: "wire_service", contractLengthMonths: 36 });
    ok(`generic line "${generic || "(blank)"}" falls back to a wider pool`, r.state === "INFERRED" && r.tier !== "line", r.state === "INFERRED" ? r.basis : r.reason);
  }
  const bpo = await inferTcv({ serviceLine: "BPO", sourceType: "procurement_notice", contractLengthMonths: 36 });
  ok("dispersed pool still answers with a range", bpo.state === "INFERRED" && bpo.lowUsd > 0 && bpo.highUsd > bpo.lowUsd, bpo.state === "INFERRED" ? `${formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: bpo.lowUsd, tcvEstimateHighUsd: bpo.highUsd })} (${bpo.anchors} anchors, ${bpo.tier})` : bpo.reason);
  const unknownLine = await inferTcv({ serviceLine: "Underwater Basket Weaving", sourceType: "wire_service", contractLengthMonths: 12 });
  ok("unknown service line falls back to the segment", unknownLine.state === "INFERRED" && unknownLine.tier === "segment");
  const ito = await inferTcv({ serviceLine: "ITO", sourceType: "wire_service", contractLengthMonths: 60 });
  ok("specific line uses its own cell", ito.state === "INFERRED" && ito.tier === "line" && ito.basis.startsWith("comparable_inferred_v2:line"), ito.state === "INFERRED" ? ito.basis : ito.reason);
  const c = await clampEstimate("wire_service", 1_000, 5_000_000_000_000);
  ok("absurd model range is clamped to the segment envelope", c.clamped && c.lowUsd >= 1_000 && c.highUsd < 5_000_000_000_000, `${c.lowUsd}–${c.highUsd}`);
  const c2 = await clampEstimate("wire_service", 20_000_000, 60_000_000);
  ok("plausible model range passes untouched", !c2.clamped && c2.lowUsd === 20_000_000 && c2.highUsd === 60_000_000);
  ok("basis helper accepts v1, v2 and model estimates only", isApprovedEstimateBasis("comparable_inferred_v1") && isApprovedEstimateBasis("comparable_inferred_v2:segment") && isApprovedEstimateBasis("model_estimated_v2: five-year global deal") && !isApprovedEstimateBasis("model_estimated") && !isApprovedEstimateBasis("general IT-services benchmark; term and geography adjusted"));

  console.log("\n=== §16 PRESENTATION ===");
  ok("disclosed renders as fact", formatTcvDisplay({ tcvCommittedUsd: 120_000_000, tcvEstimateLowUsd: null, tcvEstimateHighUsd: null }) === "$120m");
  const rng = formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: 18_000_000, tcvEstimateHighUsd: 27_000_000 });
  ok("inferred renders as a RANGE", rng.includes("–") && rng.startsWith("Est."), rng);
  ok("no midpoint presented as fact", !/^\$\d/.test(rng), rng);
  ok("withheld renders honestly", formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: null, tcvEstimateHighUsd: null }) === "Not reliably estimable");

  console.log("\n=== POPULATION SANITY ===");
  const verdicts = [];
  for (const [line, st] of [["ITO","procurement_notice"],["Digital & Cloud","procurement_notice"],["AI & Analytics","wire_service"],
                            ["Engineering IT","wire_service"],["Cybersecurity","wire_service"],["Network & Telco","wire_service"]] as const) {
    const r = await inferTcv({ serviceLine: line, sourceType: st, contractLengthMonths: 36 });
    if (r.state === "INFERRED") verdicts.push({ line, low: r.lowUsd, high: r.highUsd, tier: r.tier });
  }
  ok("every populated line answers", verdicts.length === 6, `${verdicts.length}/6`);
  ok("line-level cells give distinct ranges", new Set(verdicts.filter(v => v.tier === "line").map(v => `${v.low}|${v.high}`)).size === verdicts.filter(v => v.tier === "line").length);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
