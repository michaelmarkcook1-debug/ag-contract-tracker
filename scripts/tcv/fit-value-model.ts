/**
 * Fit the contract value model from historical contracts that DISCLOSE a value.
 *
 * WHAT IT IS. A ridge regression on log10(TCV) over the things an announcement
 * states — service line, term, provider, buyer industry, region, event type,
 * the size of the client population served, whether the buyer is anonymised,
 * and which population the record comes from (procurement notice vs announced
 * deal; measured 150x apart). The interval comes from the residuals, not from
 * a formula: the 10th–90th percentile of held-out error, per population.
 *
 * WHAT IT IS NOT. It is not a value. It writes coefficients and an honest
 * cross-validated error report; the engine that uses them labels every output
 * as an estimate and never touches the disclosed field.
 *
 * Deterministic: same data, same output. Re-run after ingesting new disclosed
 * values.
 *
 *   npx tsx scripts/tcv/fit-value-model.ts [--out src/lib/tcv/value-model.json]
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { canonicalServiceLine, extractUsersServed, featureNames, featureRow, VALUE_MODEL_VERSION, type ValueModel } from "@/lib/tcv/value-model";

interface Row { id: string; tcv: number; months: number | null; line: string | null; vendor: string | null; industry: string | null; geography: string | null; eventType: string; anonymised: boolean; sourceType: string | null; sourceName: string | null; year: number | null; text: string | null }

const MIN_GROUP = 12;          // a category with fewer disclosed rows folds into "other"
const LAMBDAS = [0.3, 1, 3, 10, 30];
const FOLDS = 5;

// ── tiny linear algebra ───────────────────────────────────────────────────────
function ridge(X: number[][], y: number[], lambda: number, noPenalty: Set<number>): number[] {
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i];
    for (let j = 0; j < p; j++) {
      if (xi[j] === 0) continue;
      b[j] += xi[j] * y[i];
      for (let k = 0; k < p; k++) if (xi[k] !== 0) A[j][k] += xi[j] * xi[k];
    }
  }
  for (let j = 0; j < p; j++) if (!noPenalty.has(j)) A[j][j] += lambda;
  // Gaussian elimination with partial pivoting
  const n = p;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-9));
}
const quantile = (v: number[], q: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const median = (v: number[]) => quantile(v, 0.5);

// ── features ──────────────────────────────────────────────────────────────────
function segmentOf(r: Row): "PROCUREMENT" | "ANNOUNCED" { return r.sourceName === "GlobalData" || r.sourceType === "procurement_notice" ? "PROCUREMENT" : "ANNOUNCED"; }

function buildDesign(rows: Row[], vocab: ValueModel["vocab"], medMonths: Record<string, number>) {
  const names = featureNames(vocab);
  const stub = { vocab, medianMonths: medMonths as ValueModel["medianMonths"], features: names };
  const X = rows.map(r => featureRow({ segment: segmentOf(r), months: r.months, usersServed: r.text ? extractUsersServed(r.text) : null, anonymised: r.anonymised, year: r.year, line: r.line, vendor: r.vendor, industry: r.industry, geography: r.geography, eventType: r.eventType }, stub));
  return { names, X };
}

(async () => {
  const outArg = process.argv.indexOf("--out");
  const out = outArg > 0 ? process.argv[outArg + 1] : "src/lib/tcv/value-model.json";

  const raw = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT e.id, cd."tcvCommittedUsd" AS tcv, cd."contractLengthMonths" AS months, cd."primaryMacroServiceLine" AS line, en."canonicalName" AS vendor,
           e.industry, e.geography, e."eventType" AS "eventType", COALESCE(cd."clientAnonymised", false) AS anonymised,
           EXTRACT(YEAR FROM e."announcementDate")::int AS year,
           (SELECT se."sourceType" FROM "_CanonicalMarketEventToSourceEvent" j JOIN "SourceEvent" se ON se.id=j."B" WHERE j."A"=e.id LIMIT 1) AS "sourceType",
           (SELECT se."sourceName" FROM "_CanonicalMarketEventToSourceEvent" j JOIN "SourceEvent" se ON se.id=j."B" WHERE j."A"=e.id LIMIT 1) AS "sourceName",
           (SELECT substr(se."rawText", 1, 8000) FROM "_CanonicalMarketEventToSourceEvent" j JOIN "SourceEvent" se ON se.id=j."B" WHERE j."A"=e.id AND length(se."rawText")>=400 AND se."rawText" NOT LIKE '%<a href%' ORDER BY length(se."rawText") DESC LIMIT 1) AS text
    FROM "CanonicalMarketEvent" e JOIN "ContractDetails" cd ON cd."canonicalEventId"=e.id LEFT JOIN "Entity" en ON en.id=e."primaryEntityId"
    WHERE e.family='CONTRACT' AND e."publicationStatus" IN ('published','needs_review') AND cd."tcvCommittedUsd" > 0 AND COALESCE(cd."tcvIsEstimate", false) = false
      AND NOT EXISTS (SELECT 1 FROM "_CanonicalMarketEventToSourceEvent" j2 JOIN "SourceEvent" s2 ON s2.id=j2."B" WHERE j2."A"=e.id AND s2."rawText" ~* 'globaldata has estimated the (value|value and duration|duration and value)')`);
  // Third-party (GlobalData) estimates: never fitted on, always validated against.
  const thirdParty = await prisma.$queryRawUnsafe<Row[]>(`
    SELECT e.id, cd."tcvEstimateMidUsd" AS tcv, cd."contractLengthMonths" AS months, cd."primaryMacroServiceLine" AS line, en."canonicalName" AS vendor,
           e.industry, e.geography, e."eventType" AS "eventType", COALESCE(cd."clientAnonymised", false) AS anonymised,
           EXTRACT(YEAR FROM e."announcementDate")::int AS year, 'procurement_notice' AS "sourceType", 'GlobalData' AS "sourceName", NULL AS text
    FROM "CanonicalMarketEvent" e JOIN "ContractDetails" cd ON cd."canonicalEventId"=e.id LEFT JOIN "Entity" en ON en.id=e."primaryEntityId"
    WHERE e.family='CONTRACT' AND cd."tcvBasis"='third_party_estimated:globaldata' AND cd."tcvEstimateMidUsd" > 0`);
  // Values under $10k are data errors (a unit slip or a line item), not contracts.
  const rows = raw.filter(r => r.tcv >= 10_000 && r.tcv <= 50e9);
  console.log(`disclosed rows: ${raw.length}, fitting on ${rows.length} (after removing values <$10k or >$50bn)`);

  const count = (f: (r: Row) => string | null) => { const m = new Map<string, number>(); for (const r of rows) { const k = f(r); if (k) m.set(k, (m.get(k) ?? 0) + 1); } return m; };
  const keep = (m: Map<string, number>) => [...m.entries()].filter(([, n]) => n >= MIN_GROUP).map(([k]) => k).sort();
  const vocab: ValueModel["vocab"] = {
    lines: [...keep(count(r => canonicalServiceLine(r.line))).filter(l => l !== "other"), "other"],
    vendors: [...keep(count(r => r.vendor)), "other"],
    industries: [...keep(count(r => r.industry)), "other"],
    regions: ["NA", "UK", "EU", "INDIA", "APAC", "LATAM", "MEA", "GLOBAL", "unknown"],
    eventTypes: [...keep(count(r => r.eventType)), "other"],
  };
  const medMonths = { PROCUREMENT: median(rows.filter(r => segmentOf(r) === "PROCUREMENT" && r.months).map(r => r.months!)) || 24, ANNOUNCED: median(rows.filter(r => segmentOf(r) === "ANNOUNCED" && r.months).map(r => r.months!)) || 36 };
  const { names, X } = buildDesign(rows, vocab, medMonths);
  const y = rows.map(r => Math.log10(r.tcv));
  const noPenalty = new Set([0]);

  // ── cross-validation: choose lambda, measure honestly ──────────────────────
  const order = rows.map((_, i) => i).sort((a, b) => (rows[a].id < rows[b].id ? -1 : 1));   // deterministic folds
  const foldOf = new Map(order.map((i, k) => [i, k % FOLDS]));
  let best = { lambda: LAMBDAS[0], mdae: Infinity, resid: [] as number[], residBySeg: { PROCUREMENT: [] as number[], ANNOUNCED: [] as number[] } };
  for (const lambda of LAMBDAS) {
    const resid: number[] = []; const bySeg = { PROCUREMENT: [] as number[], ANNOUNCED: [] as number[] };
    for (let f = 0; f < FOLDS; f++) {
      const tr = rows.map((_, i) => i).filter(i => foldOf.get(i) !== f), te = rows.map((_, i) => i).filter(i => foldOf.get(i) === f);
      const beta = ridge(tr.map(i => X[i]), tr.map(i => y[i]), lambda, noPenalty);
      for (const i of te) { const pred = X[i].reduce((s, v, j) => s + v * beta[j], 0); const e = y[i] - pred; resid.push(e); bySeg[segmentOf(rows[i])].push(e); }
    }
    const mdae = median(resid.map(Math.abs));
    console.log(`lambda ${lambda}: held-out median |log10 error| ${mdae.toFixed(3)} (typical factor ${Math.pow(10, mdae).toFixed(2)}x) · within 2x ${(100 * resid.filter(e => Math.abs(e) <= Math.log10(2)).length / resid.length).toFixed(0)}% · within 3x ${(100 * resid.filter(e => Math.abs(e) <= Math.log10(3)).length / resid.length).toFixed(0)}%`);
    if (mdae < best.mdae) best = { lambda, mdae, resid, residBySeg: bySeg };
  }

  // ── baseline: the comparables pool (segment × line p25–p75 midpoint), same folds ──
  {
    const resid: number[] = [];
    for (let f = 0; f < FOLDS; f++) {
      const tr = rows.filter((_, i) => foldOf.get(i) !== f), te = rows.filter((_, i) => foldOf.get(i) === f);
      const pools = new Map<string, number[]>();
      for (const r of tr) { const k = `${segmentOf(r)}|${canonicalServiceLine(r.line)}`; if (!pools.has(k)) pools.set(k, []); pools.get(k)!.push(Math.log10(r.tcv)); const s = `${segmentOf(r)}|*`; if (!pools.has(s)) pools.set(s, []); pools.get(s)!.push(Math.log10(r.tcv)); }
      for (const r of te) { const p = pools.get(`${segmentOf(r)}|${canonicalServiceLine(r.line)}`) ?? pools.get(`${segmentOf(r)}|*`) ?? []; if (p.length < 5) continue; resid.push(Math.log10(r.tcv) - median(p)); }
    }
    console.log(`baseline (comparables pool median): median |log10 error| ${median(resid.map(Math.abs)).toFixed(3)} (typical factor ${Math.pow(10, median(resid.map(Math.abs))).toFixed(2)}x) · within 2x ${(100 * resid.filter(e => Math.abs(e) <= Math.log10(2)).length / resid.length).toFixed(0)}% · within 3x ${(100 * resid.filter(e => Math.abs(e) <= Math.log10(3)).length / resid.length).toFixed(0)}%`);
  }

  // ── final fit on everything, interval from held-out residuals ──────────────
  const beta = ridge(X, y, best.lambda, noPenalty);
  const band = (res: number[]) => ({ p10: quantile(res, 0.10), p25: quantile(res, 0.25), p50: quantile(res, 0.50), p75: quantile(res, 0.75), p90: quantile(res, 0.90), coverage80: res.length ? res.filter(e => e >= quantile(res, 0.10) && e <= quantile(res, 0.90)).length / res.length : 0, n: res.length });
  const model: ValueModel = {
    version: VALUE_MODEL_VERSION,
    fittedAt: new Date().toISOString(),
    n: rows.length,
    lambda: best.lambda,
    target: "log10(tcvCommittedUsd)",
    features: names,
    coefficients: beta,
    vocab,
    medianMonths: medMonths,
    residualBands: { PROCUREMENT: band(best.residBySeg.PROCUREMENT), ANNOUNCED: band(best.residBySeg.ANNOUNCED), ALL: band(best.resid) },
    heldOut: { medianAbsLog10Error: best.mdae, typicalFactor: Math.pow(10, best.mdae), within2x: best.resid.filter(e => Math.abs(e) <= Math.log10(2)).length / best.resid.length, within3x: best.resid.filter(e => Math.abs(e) <= Math.log10(3)).length / best.resid.length },
    envelope: { PROCUREMENT: { p2: quantile(rows.filter(r => segmentOf(r) === "PROCUREMENT").map(r => r.tcv), 0.02), p98: quantile(rows.filter(r => segmentOf(r) === "PROCUREMENT").map(r => r.tcv), 0.98) }, ANNOUNCED: { p2: quantile(rows.filter(r => segmentOf(r) === "ANNOUNCED").map(r => r.tcv), 0.02), p98: quantile(rows.filter(r => segmentOf(r) === "ANNOUNCED").map(r => r.tcv), 0.98) } },
  };
  // ── validation against an independent analyst house's estimates ───────────
  let tpLine = "No third-party estimates available for validation.";
  if (thirdParty.length) {
    const stub = { vocab, medianMonths: medMonths as ValueModel["medianMonths"], features: names };
    const res = thirdParty.filter(r => r.tcv >= 10_000).map(r => Math.log10(r.tcv) - featureRow({ segment: "PROCUREMENT", months: r.months, usersServed: null, anonymised: r.anonymised, year: r.year, line: r.line, vendor: r.vendor, industry: r.industry, geography: r.geography, eventType: r.eventType }, stub).reduce((s, v, j) => s + v * beta[j], 0));
    const md = median(res), mdae = median(res.map(Math.abs));
    tpLine = `Against ${res.length} GlobalData analyst estimates (never fitted on): median offset ${md >= 0 ? "+" : ""}${md.toFixed(2)} log10 (GlobalData ${Math.pow(10, Math.abs(md)).toFixed(2)}x ${md >= 0 ? "higher" : "lower"} than this model), median |error| ${mdae.toFixed(3)} (${Math.pow(10, mdae).toFixed(2)}x), within 2x ${(100 * res.filter(e => Math.abs(e) <= Math.log10(2)).length / res.length).toFixed(0)}%.`;
    model.thirdPartyValidation = { n: res.length, medianOffsetLog10: md, medianAbsLog10Error: mdae, within2x: res.filter(e => Math.abs(e) <= Math.log10(2)).length / res.length };
    // Only a downward, evidenced offset is applied; never an upward one.
    const adj = Math.min(0, md);
    model.undisclosedAdjustment = { PROCUREMENT: adj, ANNOUNCED: adj, basis: `PROCUREMENT: measured median offset of ${res.length} GlobalData analyst estimates of undisclosed deals against this model (${Math.pow(10, adj).toFixed(2)}x). ANNOUNCED: assumed equal — no external reference exists for undisclosed announced deals; the direction is certain (deals that state a value are the larger ones), the size is borrowed.` };
  }
  console.log(tpLine);
  fs.writeFileSync(out, JSON.stringify(model, null, 1));

  // ── report ──────────────────────────────────────────────────────────────────
  const coef = names.map((n, i) => [n, beta[i]] as const);
  const show = (prefix: string) => coef.filter(([n]) => n.startsWith(prefix)).sort((a, b) => b[1] - a[1]).map(([n, b]) => `${n.slice(prefix.length)} ${b >= 0 ? "+" : ""}${b.toFixed(2)} (×${Math.pow(10, b).toFixed(2)})`);
  const L = [`# Contract value model — fit report ${model.fittedAt.slice(0, 16)}Z`, "",
    `Version \`${model.version}\` · ${model.n} disclosed contracts · ridge λ=${model.lambda} on log10(TCV) · ${FOLDS}-fold cross-validation with deterministic folds.`, "",
    `## Held-out accuracy`, "", `| | value |`, `|---|---|`,
    `| median absolute log10 error | ${model.heldOut.medianAbsLog10Error.toFixed(3)} |`, `| typical factor error | ${model.heldOut.typicalFactor.toFixed(2)}x |`,
    `| within 2x of the disclosed value | ${(100 * model.heldOut.within2x).toFixed(0)}% |`, `| within 3x | ${(100 * model.heldOut.within3x).toFixed(0)}% |`,
    `| 80% band coverage (ANNOUNCED) | ${(100 * model.residualBands.ANNOUNCED.coverage80).toFixed(0)}% of ${model.residualBands.ANNOUNCED.n} |`, `| 80% band coverage (PROCUREMENT) | ${(100 * model.residualBands.PROCUREMENT.coverage80).toFixed(0)}% of ${model.residualBands.PROCUREMENT.n} |`, "",
    `The low–high range the engine reports is the interquartile band of held-out residuals for the record's population (half of disclosed deals fall inside it): ANNOUNCED ${Math.pow(10, model.residualBands.ANNOUNCED.p25).toFixed(2)}x–${Math.pow(10, model.residualBands.ANNOUNCED.p75).toFixed(2)}x of the point estimate, PROCUREMENT ${Math.pow(10, model.residualBands.PROCUREMENT.p25).toFixed(2)}x–${Math.pow(10, model.residualBands.PROCUREMENT.p75).toFixed(2)}x. The 80% band (ANNOUNCED ${Math.pow(10, model.residualBands.ANNOUNCED.p10).toFixed(2)}x–${Math.pow(10, model.residualBands.ANNOUNCED.p90).toFixed(2)}x) is stored beside every estimate.`, "",
    `## What moves the estimate (multiplicative effects, other things equal)`, "",
    `- intercept ${beta[0].toFixed(2)} → $${(Math.pow(10, beta[0]) / 1e6).toFixed(1)}m for an ANNOUNCED deal at the median term with every category "other"`,
    `- procurement notice vs announced deal: ×${Math.pow(10, beta[1]).toFixed(3)}`,
    `- term: TCV ∝ months^${beta[2].toFixed(2)} (unstated term: ×${Math.pow(10, beta[3]).toFixed(2)}, imputed at the population median)`,
    `- client population served: TCV ∝ users^${beta[4].toFixed(2)} where the article states one (unstated: ×${Math.pow(10, beta[5]).toFixed(2)})`,
    `- anonymised buyer: ×${Math.pow(10, beta[6]).toFixed(2)} · per year after 2024: ×${Math.pow(10, beta[7]).toFixed(2)}`, "",
    `### Service line`, ...show("line:").map(s => `- ${s}`), "", `### Provider (top and bottom 8)`, ...show("vendor:").slice(0, 8).map(s => `- ${s}`), "- …", ...show("vendor:").slice(-8).map(s => `- ${s}`), "",
    `### Industry`, ...show("industry:").map(s => `- ${s}`), "", `### Region`, ...show("region:").map(s => `- ${s}`), "", `### Event type`, ...show("event:").map(s => `- ${s}`), "",
    `## Validation against an independent analyst house`, "", tpLine, "",
    `## Undisclosed-deal adjustment`, "", model.undisclosedAdjustment ? `Point estimates for undisclosed deals are shifted ×${Math.pow(10, model.undisclosedAdjustment.PROCUREMENT).toFixed(2)}. ${model.undisclosedAdjustment.basis}` : "None (no third-party reference available).", "",
    `## Limits`, "", `- Fitted on contracts that stated a value. Stated deals skew large; the adjustment above corrects the level with the only external evidence available, and the range is wide by construction.`, `- A ${model.heldOut.typicalFactor.toFixed(1)}x typical error means the estimate orders contracts and sizes a market segment; it does not price a single deal.`, `- Every output is labelled an estimate. The disclosed field is never written by this model.`];
  fs.writeFileSync(out.replace(/\.json$/, "-fit-report.md"), L.join("\n"));
  console.log(`\nmodel → ${out} (${names.length} features)`);
  console.log(L.slice(4, 14).join("\n"));
  await prisma.$disconnect();
})();
