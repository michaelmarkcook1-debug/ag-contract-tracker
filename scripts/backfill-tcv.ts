/**
 * Backfill estimated TCV ranges onto contracts with no disclosed value.
 *
 * Policy (2026-09-08): every contract should carry a value — a disclosed
 * figure when one exists, otherwise a labelled ESTIMATE range. The disclosed
 * field is never touched.
 *
 * For each undisclosed CONTRACT in the tracked scope:
 *   1. the model (Sonnet) estimates a range from the title, parties, service
 *      line, term, summary and body text — same instruction the extractor now
 *      uses at ingestion; results are cached in TCV_CACHE so --apply does not
 *      pay again;
 *   2. the range is clamped to the segment's disclosed envelope (p2–p98);
 *   3. if the model DECLINES with a reason that says the row is not a
 *      contract (analyst recognition, research report, launch, exhibition…)
 *      the event is reclassified out of the published feed — excluded_noise
 *      with reviewReason "not_a_contract: …", logged as a ReviewAction and
 *      reversible. Measured 2026-09-08: 189 of 1,059 rows, almost all legacy
 *      vendor-newsroom items the old rules filed as CONTRACT;
 *   4. if the model declines for lack of detail, the row keeps no estimate;
 *   5. only when the model never answered (API failure) is the comparable
 *      engine's range used.
 * Writes: tcvEstimateLow/Mid/High, tcvBasis, tcvIsEstimate, tcvConfidence.
 * Older quarantined estimates are replaced.
 *
 * Dry run by default; --apply writes. --limit N caps the population.
 */
import fs from "fs";
import { prisma } from "../src/lib/db";
import { trackedEventScope } from "../src/lib/data";
import { inferTcv, clampEstimate, loadComparablePools, isApprovedEstimateBasis, MODEL_ESTIMATE_BASIS } from "../src/lib/tcv/infer";

const CACHE_PATH = process.env.TCV_CACHE ?? "/tmp/tcv-estimates.json";
const MODEL = "claude-sonnet-5";
const SYSTEM = `You estimate the total contract value (TCV, USD) of IT-services contracts from their description, for a market-intelligence platform. The value was not disclosed; give a plausible range — typically a 2–4x band — from scope, term, client size, geography, service line and comparable deals you know of. Return JSON only: {"lowUsd": number, "highUsd": number, "rationale": "≤25 words"}. If the text cannot support any estimate, return {"lowUsd": null, "highUsd": null, "rationale": "why"}.`;
const NOT_CONTRACT = /not (?:a |an )?(?:client |services |commercial |it[- ]services |formal |traditional )?(?:contract|deal|award|engagement)|award announcement|analyst[- ]?(?:recognition|award|ranking|report)|recognition|research|report announcement|(?:program|product|platform|service|offering) launch|launch announcement|exhibit|employer|joint venture|preliminary|discussion|sponsorship|marketing|thought leadership/i;
const money = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${(n / 1e3).toFixed(0)}k`;

async function estimate(evidence: string): Promise<{ low: number | null; high: number | null; rationale: string | null; cost: number }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 160, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: evidence }] }),
    signal: AbortSignal.timeout(30000),
  });
  const d = await res.json() as { content?: { type: string; text: string }[]; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  const u = d.usage; const cost = u ? (u.input_tokens * 2 + (u.cache_read_input_tokens ?? 0) * 0.2 + (u.cache_creation_input_tokens ?? 0) * 2.5 + u.output_tokens * 10) / 1e6 : 0;
  const text = d.content?.find(c => c.type === "text")?.text ?? "";
  try {
    const m = /\{[\s\S]*\}/.exec(text); const p = m ? JSON.parse(m[0]) as { lowUsd?: unknown; highUsd?: unknown; rationale?: unknown } : {};
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    let low = n(p.lowUsd), high = n(p.highUsd); if (low && high && low > high) [low, high] = [high, low];
    return { low, high, rationale: typeof p.rationale === "string" ? p.rationale.slice(0, 160) : null, cost };
  } catch { return { low: null, high: null, rationale: null, cost }; }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const li = process.argv.indexOf("--limit"); const limit = li >= 0 ? Number(process.argv[li + 1]) : Infinity;
  console.log(apply ? "MODE: APPLY\n" : "MODE: dry run (no writes)\n");
  await loadComparablePools();
  const scope = await trackedEventScope();
  const rows = await prisma.contractDetails.findMany({
    where: { tcvCommittedUsd: null, canonicalEvent: { is: { family: "CONTRACT", publicationStatus: { in: ["published", "needs_review"] }, ...scope } } },
    select: { id: true, tcvBasis: true, vendorRaw: true, clientRaw: true, primaryMacroServiceLine: true, contractLengthMonths: true, scopeSummary: true,
      canonicalEvent: { select: { id: true, canonicalTitle: true, announcementDate: true, industry: true, geography: true, analystInsight: true, sourceEvents: { select: { rawText: true, sourceTitle: true, sourceType: true, sourceName: true }, take: 1 } } } },
  });
  const todo = rows.filter(r => !isApprovedEstimateBasis(r.tcvBasis)).slice(0, limit);
  console.log(`undisclosed contracts in scope: ${rows.length}; without an approved estimate: ${todo.length}`);
  const cache: Record<string, { low: number | null; high: number | null; rationale: string | null }> = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};
  const isBody = (t: string | null) => !!t && t.length > 300 && !t.trimStart().startsWith("<a ");

  // Rows never answered (API failure cached as all-null) are retried; reasoned declines are kept.
  const need = todo.filter(r => !cache[r.id] || (!cache[r.id].low && !cache[r.id].rationale));
  if (need.length && process.env.ANTHROPIC_API_KEY) {
    console.log(`estimating ${need.length} via ${MODEL} (cached to ${CACHE_PATH})…`);
    let cursor = 0, spent = 0, done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < need.length) {
        const r = need[cursor++]; const ev = r.canonicalEvent; const se = ev.sourceEvents[0];
        const evidence = [
          `Title: ${ev.canonicalTitle}`, se?.sourceTitle ? `Headline: ${se.sourceTitle}` : null,
          `Vendor: ${r.vendorRaw ?? "?"} · Client: ${r.clientRaw ?? "?"} · Service line: ${r.primaryMacroServiceLine ?? "?"} · Term: ${r.contractLengthMonths ? `${r.contractLengthMonths} months` : "unknown"}`,
          `Industry: ${ev.industry ?? "?"} · Geography: ${ev.geography} · Announced: ${ev.announcementDate?.toISOString().slice(0, 10) ?? "?"} · Source: ${se?.sourceType ?? "?"}`,
          r.scopeSummary ? `Summary: ${r.scopeSummary}` : null, ev.analystInsight ? `Analyst note: ${ev.analystInsight}` : null,
          isBody(se?.rawText ?? null) ? `Article text (truncated): ${se!.rawText!.slice(0, 2000)}` : null,
        ].filter(Boolean).join("\n");
        try { const e = await estimate(evidence); spent += e.cost; cache[r.id] = { low: e.low, high: e.high, rationale: e.rationale }; }
        catch { cache[r.id] = { low: null, high: null, rationale: null }; }
        if (++done % 100 === 0) { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); console.log(`  ${done}/${need.length} · $${spent.toFixed(2)}`); }
      }
    }));
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
    console.log(`  model spend: $${spent.toFixed(2)}`);
  } else if (need.length) console.log(`(${need.length} rows need the model; set ANTHROPIC_API_KEY)`);

  const plan: { id: string; eventId: string; low: number; high: number; basis: string; title: string }[] = [];
  const reclassify: { eventId: string; title: string; reason: string }[] = [];
  let fromModel = 0, fromComparables = 0, clamped = 0, none = 0, declined = 0;
  for (const r of todo) {
    const se = r.canonicalEvent.sourceEvents[0];
    const sourceType = se?.sourceName === "GlobalData" ? "procurement_notice" : (se?.sourceType ?? null);
    const c = cache[r.id];
    if (c && !c.low && c.rationale) {
      // The model looked and declined. Its reason is a categorisation signal.
      if (NOT_CONTRACT.test(c.rationale)) reclassify.push({ eventId: r.canonicalEvent.id, title: r.canonicalEvent.canonicalTitle, reason: c.rationale });
      else declined++;
      continue;
    }
    if (c?.low && c?.high) {
      const k = await clampEstimate(sourceType, c.low, c.high); if (k.clamped) clamped++;
      fromModel++;
      plan.push({ id: r.id, eventId: r.canonicalEvent.id, low: k.lowUsd, high: k.highUsd, basis: `${MODEL_ESTIMATE_BASIS}: ${c.rationale ?? "range from scope and term"}${k.clamped ? " (clamped)" : ""}`, title: r.canonicalEvent.canonicalTitle });
      continue;
    }
    const v = await inferTcv({ serviceLine: r.primaryMacroServiceLine, sourceType, contractLengthMonths: r.contractLengthMonths, disclosedUsd: null });
    if (v.state === "INFERRED") { fromComparables++; plan.push({ id: r.id, eventId: r.canonicalEvent.id, low: v.lowUsd, high: v.highUsd, basis: v.basis, title: r.canonicalEvent.canonicalTitle }); }
    else none++;
  }
  const mids = plan.map(p => (p.low + p.high) / 2).sort((a, b) => a - b);
  const q = (p: number) => mids.length ? mids[Math.min(mids.length - 1, Math.floor(mids.length * p))] : 0;
  console.log(`\nplan: ${plan.length} estimates — model ${fromModel} (clamped ${clamped}) · comparables ${fromComparables} · none ${none}`);
  console.log(`declined by the model: ${reclassify.length + declined} — ${reclassify.length} reclassified as not a contract (→ excluded_noise, logged) · ${declined} left without a value`);
  console.log("reclassify sample:"); reclassify.slice(0, 8).forEach(x => console.log(`  ${x.title.slice(0, 64).padEnd(66)} | ${x.reason.slice(0, 70)}`));
  console.log(`midpoint distribution: p10 ${money(q(0.1))} · median ${money(q(0.5))} · p90 ${money(q(0.9))}`);
  console.log("sample:"); plan.slice(0, 10).forEach(p => console.log(`  ${money(p.low)}–${money(p.high)}  ${p.title.slice(0, 60)}  [${p.basis.slice(0, 70)}]`));
  if (!apply) { console.log("\n(dry run — re-run with --apply to write)"); await prisma.$disconnect(); return; }
  let written = 0;
  for (let i = 0; i < plan.length; i += 25) {
    await Promise.all(plan.slice(i, i + 25).map(p => prisma.contractDetails.update({ where: { id: p.id }, data: { tcvEstimateLowUsd: p.low, tcvEstimateMidUsd: Math.round((p.low + p.high) / 2), tcvEstimateHighUsd: p.high, tcvBasis: p.basis, tcvIsEstimate: true, tcvConfidence: "estimated" } })));
    written += Math.min(25, plan.length - i);
  }
  console.log(`written ${written} estimates`);
  let moved = 0;
  for (const x of reclassify) {
    const ev = await prisma.canonicalMarketEvent.findUnique({ where: { id: x.eventId }, select: { publicationStatus: true } });
    if (!ev) continue;
    await prisma.$transaction([
      prisma.canonicalMarketEvent.update({ where: { id: x.eventId }, data: { publicationStatus: "excluded_noise", humanReviewRequired: false, reviewReason: `not_a_contract: ${x.reason.slice(0, 120)}` } }),
      prisma.reviewAction.create({ data: { eventId: x.eventId, action: "reclassified_not_contract", previousValue: ev.publicationStatus, newValue: "excluded_noise", reviewerNote: x.reason.slice(0, 200) } }),
    ]);
    moved++;
  }
  console.log(`reclassified ${moved}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });
