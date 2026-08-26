/** §15/§16/§19 validation for the comparable TCV engine. */
import { prisma } from "../../src/lib/db";
import { inferTcv, loadComparablePools, MIN_ANCHORS, MAX_SPREAD } from "../../src/lib/tcv/infer";
import { formatTcvDisplay } from "../../src/lib/types";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

async function main() {
  const pools = await loadComparablePools();
  console.log(`comparable cells built: ${pools.size}  (gates: N>=${MIN_ANCHORS}, spread<=${MAX_SPREAD}x)\n`);

  console.log("=== §15 GATES ===");
  const disclosed = await inferTcv({ serviceLine: "ITO", sourceType: "procurement_notice", contractLengthMonths: 36, disclosedUsd: 120_000_000 });
  ok("disclosed value -> no inference attempted", disclosed.state === "NOT_RELIABLY_ESTIMABLE", disclosed.state === "NOT_RELIABLY_ESTIMABLE" ? disclosed.reason : "");

  for (const generic of ["", "unspecified", "other", "general services"]) {
    const r = await inferTcv({ serviceLine: generic, sourceType: "wire_service", contractLengthMonths: 36 });
    ok(`generic line "${generic || "(blank)"}" refused`, r.state === "NOT_RELIABLY_ESTIMABLE");
  }

  const bpo = await inferTcv({ serviceLine: "BPO", sourceType: "procurement_notice", contractLengthMonths: 36 });
  ok("over-dispersed pool (BPO 24.7x) refused", bpo.state === "NOT_RELIABLY_ESTIMABLE", bpo.state === "NOT_RELIABLY_ESTIMABLE" ? bpo.reason : "");

  const ito = await inferTcv({ serviceLine: "ITO", sourceType: "wire_service", contractLengthMonths: 60 });
  ok("ANNOUNCED/ITO (9.8x) refused", ito.state === "NOT_RELIABLY_ESTIMABLE", ito.state === "NOT_RELIABLY_ESTIMABLE" ? ito.reason : "");

  const unknownLine = await inferTcv({ serviceLine: "Underwater Basket Weaving", sourceType: "wire_service", contractLengthMonths: 12 });
  ok("unknown service line refused", unknownLine.state === "NOT_RELIABLY_ESTIMABLE");

  console.log("\n=== §15 ACCEPTED CELLS ===");
  for (const [line, st] of [["ITO", "procurement_notice"], ["AI & Analytics", "wire_service"], ["Cybersecurity", "wire_service"]] as const) {
    const r = await inferTcv({ serviceLine: line, sourceType: st, contractLengthMonths: 36 });
    if (r.state === "INFERRED") {
      const sane = r.lowUsd > 0 && r.highUsd > r.lowUsd && r.anchors >= MIN_ANCHORS;
      ok(`${line} (${st}) -> range`, sane, `${formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: r.lowUsd, tcvEstimateHighUsd: r.highUsd })} from ${r.anchors} anchors`);
    } else ok(`${line} (${st}) -> range`, false, r.reason);
  }

  console.log("\n=== §16 PRESENTATION ===");
  ok("disclosed renders as fact", formatTcvDisplay({ tcvCommittedUsd: 120_000_000, tcvEstimateLowUsd: null, tcvEstimateHighUsd: null }) === "$120m");
  const rng = formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: 18_000_000, tcvEstimateHighUsd: 27_000_000 });
  ok("inferred renders as a RANGE", rng.includes("–") && rng.startsWith("Est."), rng);
  ok("no midpoint presented as fact", !/^\$\d/.test(rng), rng);
  ok("withheld renders honestly", formatTcvDisplay({ tcvCommittedUsd: null, tcvEstimateLowUsd: null, tcvEstimateHighUsd: null }) === "Not reliably estimable");

  console.log("\n=== §19 POPULATION PATHOLOGY ===");
  const verdicts = [];
  for (const [line, st] of [["ITO","procurement_notice"],["Digital & Cloud","procurement_notice"],["AI & Analytics","wire_service"],
                            ["Engineering IT","wire_service"],["Cybersecurity","wire_service"],["Network & Telco","wire_service"]] as const) {
    const r = await inferTcv({ serviceLine: line, sourceType: st, contractLengthMonths: 36 });
    if (r.state === "INFERRED") verdicts.push({ line, low: r.lowUsd, high: r.highUsd });
  }
  const identical = new Set(verdicts.map(v => `${v.low}|${v.high}`)).size;
  ok("no identical-range clustering", identical === verdicts.length, `${verdicts.length} cells, ${identical} distinct ranges`);
  ok("ranges are bounded (high/low <= 6x)", verdicts.every(v => v.high / v.low <= MAX_SPREAD + 0.01));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error(String(e).slice(0, 300)); process.exit(1); });
