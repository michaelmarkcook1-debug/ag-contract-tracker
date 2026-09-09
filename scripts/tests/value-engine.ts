/**
 * Contract value engine — deterministic tests. No model calls; the comparables
 * fallback reads the database once.
 *
 *   npx tsx scripts/tests/value-engine.ts
 */
import { estimateBpo, estimateFromModel, estimateContractValue, VALUE_ENGINE_BASIS } from "@/lib/tcv/engine";
import { canonicalServiceLine, regionOf, extractUsersServed } from "@/lib/tcv/value-model";
import { isApprovedEstimateBasis } from "@/lib/tcv/infer";
import model from "@/lib/tcv/value-model.json";
import card from "@/lib/tcv/bpo-rate-card.json";
import { prisma } from "@/lib/db";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (cond) { passed++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ""}`); } else { failed++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`); } };
const m = (n: number) => `$${(n / 1e6).toFixed(2)}m`;
const base = { serviceLine: "BPO", sourceType: "wire_service", contractLengthMonths: 36, provider: "Teleperformance", industry: "Retail", geography: ["United States"], eventType: "new_win", anonymised: false };

(async () => {
  console.log("=== BPO rate card ===");
  const atento = estimateBpo({ ...base, provider: "Atento S.A.", agentCount: 260, deliveryLocations: ["Brazil"], buyerCountry: "Brazil", workType: "VOICE", contractLengthMonths: 36, geography: ["Brazil"] })!;
  ok("Atento 260 agents, Brazil domestic, 36 months brackets the disclosed $6.3m", !!atento && atento.lowUsd <= 6.3e6 && atento.highUsd >= 6.3e6, `${m(atento.lowUsd)}–${m(atento.highUsd)}`);
  const opo = estimateBpo({ ...base, agentCount: 20, agentTarget: 100, deliveryLocations: ["India"], buyerCountry: "India", workType: "VOICE", contractLengthMonths: 36 })!;
  ok("20 seats scaling to 100, India domestic, 36 months brackets the disclosed $1.8m", !!opo && opo.lowUsd <= 1.8e6 && opo.highUsd >= 1.8e6, `${m(opo.lowUsd)}–${m(opo.highUsd)}`);
  const off = estimateBpo({ ...base, agentCount: 500, deliveryLocations: ["Philippines"], workType: "VOICE" })!;
  const on = estimateBpo({ ...base, agentCount: 500, deliveryLocations: ["United States"], workType: "VOICE" })!;
  ok("onshore costs more than offshore for the same agents", on.lowUsd > off.highUsd, `${m(off.lowUsd)}–${m(off.highUsd)} offshore vs ${m(on.lowUsd)}–${m(on.highUsd)} onshore`);
  const spec = estimateBpo({ ...base, agentCount: 500, deliveryLocations: ["Philippines"], workType: "SPECIALISED" })!;
  ok("specialised work carries the premium", Math.abs(spec.midUsd / off.midUsd - card.workTypeMultipliers.SPECIALISED) < 0.02, `×${(spec.midUsd / off.midUsd).toFixed(2)}`);
  const target = estimateBpo({ ...base, agentTarget: 1000, deliveryLocations: ["India"], workType: "NON_VOICE" })!;
  ok("a target-only headcount is ramped, and says so", target.inputs.agents === 750 && /agents/.test(target.explanation), `${target.inputs.agents} agents`);
  const noTerm = estimateBpo({ ...base, agentCount: 100, deliveryLocations: ["Mexico"], workType: "VOICE", contractLengthMonths: null })!;
  ok("an unstated term is assumed and flagged", noTerm.inputs.termAssumed === true && /term assumed/.test(noTerm.explanation));
  ok("agents stated on a non-BPO deal are not priced by the rate card", estimateBpo({ ...base, serviceLine: "ITO", workType: null, agentCount: 300, deliveryLocations: ["India"] }) === null);
  ok("no agents → no rate-card estimate", estimateBpo({ ...base, agentCount: null }) === null);
  ok("rate-card outputs are labelled", atento.basis === `${VALUE_ENGINE_BASIS}:bpo_rate_card` && atento.method === "bpo_rate_card" && atento.version === card.version);

  console.log("\n=== fitted value model ===");
  ok("model is fitted on contracts that STATED a value (third-party estimates excluded)", model.n > 1000 && model.coefficients.length === model.features.length, `n=${model.n}, ${model.features.length} features`);
  ok("the fit was validated against an independent analyst house", !!(model as { thirdPartyValidation?: { n: number } }).thirdPartyValidation && (model as { thirdPartyValidation?: { n: number } }).thirdPartyValidation!.n > 1000, JSON.stringify((model as { thirdPartyValidation?: unknown }).thirdPartyValidation));
  ok("held-out typical error is reported and under 3x", model.heldOut.typicalFactor > 1 && model.heldOut.typicalFactor < 3, `${model.heldOut.typicalFactor.toFixed(2)}x`);
  ok("80% band covers about 80% of held-out cases", Math.abs(model.residualBands.ALL.coverage80 - 0.8) < 0.05, `${(100 * model.residualBands.ALL.coverage80).toFixed(0)}%`);
  const ito = estimateFromModel({ ...base, serviceLine: "ITO", provider: "Infosys", industry: "Banking", contractLengthMonths: 60, geography: ["United Kingdom"] })!;
  ok("an announced ITO deal gets a range", !!ito && ito.lowUsd > 0 && ito.highUsd > ito.lowUsd, `${m(ito.lowUsd)}–${m(ito.highUsd)}`);
  const ito24 = estimateFromModel({ ...base, serviceLine: "ITO", provider: "Infosys", industry: "Banking", contractLengthMonths: 24, geography: ["United Kingdom"] })!;
  ok("a longer term raises the estimate", ito.midUsd > ito24.midUsd, `${m(ito24.midUsd)} at 24m → ${m(ito.midUsd)} at 60m`);
  const big = estimateFromModel({ ...base, serviceLine: "ITO", provider: "Infosys", industry: "Banking", contractLengthMonths: 60, geography: ["United Kingdom"], usersServed: 100_000 })!;
  ok("a stated client population served raises the estimate", big.midUsd > ito.midUsd, `${m(ito.midUsd)} → ${m(big.midUsd)} with 100,000 users`);
  const proc = estimateFromModel({ ...base, serviceLine: "ITO", sourceType: "procurement_notice", provider: "Capgemini", industry: null, contractLengthMonths: 36, geography: ["United Kingdom"] })!;
  ok("a procurement notice is priced from the procurement population", proc.inputs.segment === "PROCUREMENT" && proc.midUsd < ito.midUsd, `${m(proc.midUsd)} vs ${m(ito.midUsd)}`);
  const bare = estimateFromModel({ serviceLine: null, sourceType: null, contractLengthMonths: null, provider: null, industry: null, geography: null, eventType: null, anonymised: true })!;
  ok("nothing known still yields a (wide) range rather than nothing", !!bare && bare.highUsd / bare.lowUsd > 3, `${m(bare.lowUsd)}–${m(bare.highUsd)}`);
  ok("ranges stay inside the disclosed envelope", [ito, big, proc, bare].every(e => e.lowUsd >= Math.min(model.envelope.ANNOUNCED.p2, model.envelope.PROCUREMENT.p2) && e.highUsd <= Math.max(model.envelope.ANNOUNCED.p98, model.envelope.PROCUREMENT.p98)));
  ok("model outputs are labelled with the fitted version", ito.basis === `${VALUE_ENGINE_BASIS}:value_model` && ito.version === model.version);
  ok("the explanation names the fit and the typical error", /fitted on \d+ contracts that stated a value/.test(ito.explanation) && /typical error/.test(ito.explanation), ito.explanation);

  console.log("\n=== routing and safety ===");
  const routed = await estimateContractValue({ ...base, agentCount: 260, deliveryLocations: ["Brazil"], workType: "VOICE" });
  ok("agents stated → rate card wins", routed?.method === "bpo_rate_card");
  const routed2 = await estimateContractValue({ ...base, serviceLine: "ITO" });
  ok("no agents → fitted model", routed2?.method === "value_model");
  ok("engine output carries no publication verdict", routed != null && !("publicationStatus" in routed) && !("isContract" in routed));
  ok("the engine basis is an approved estimate basis", isApprovedEstimateBasis(routed!.basis) && isApprovedEstimateBasis(routed2!.basis));
  ok("a legacy guess basis is not approved", !isApprovedEstimateBasis("model_estimated") && !isApprovedEstimateBasis("general IT-services benchmark; term and geography adjusted"));

  console.log("\n=== feature helpers ===");
  ok("service lines fold to one vocabulary", canonicalServiceLine("Cloud and Infrastructure Management") === "ITO" && canonicalServiceLine("Applications & Digital Engineering") === "Application Services" && canonicalServiceLine("Analytics & AI") === "AI & Analytics" && canonicalServiceLine("contact centre") === "BPO");
  ok("regions resolve from stored geography", regionOf('["United Kingdom"]') === "UK" && regionOf("Germany, France") === "EU" && regionOf("Bengaluru, India") === "INDIA" && regionOf(null) === "unknown");
  ok("users served is read from prose", extractUsersServed("services which support the 35,000 employees across Premier Inn and Beefeater") === 35_000);
  ok("a small team is not a population", extractUsersServed("a team of 12 people will deliver the work") === null);
  ok("the largest stated population wins", extractUsersServed("used by 8,800 employees in 45 countries and 2,000,000 customers") === 2_000_000);

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})();
