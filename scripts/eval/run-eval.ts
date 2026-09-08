/**
 * OLD PIPELINE vs NEW PIPELINE on the frozen evaluation set (AI Delivery
 * Mandate §31). No database writes.
 *
 * For every frozen article: fetch the whole page (stored text as fallback),
 * run the NEW reader, and obtain an independent adjudication from a separate
 * judge model with its own rubric. OLD verdicts are the stored ones. Truth is
 * the judge's — a model, not a human; the report says so and lists every
 * disagreement so a person can spot-check.
 *
 *   npx tsx scripts/eval/run-eval.ts [--set scripts/eval/frozen-set-2026-09-08.json] [--concurrency 6] [--report-only]
 */
import fs from "fs";
import { retrieveArticle, readableArticleText } from "@/lib/ingestion/article-text";
import { readArticle, READER_MODEL, PROMPT_POLICY_VERSION, type Reading, type GroundedEvent } from "@/lib/ingestion/reader";
import { matchTrackedVendorPreferring } from "@/lib/ingestion/sources";
import { orgsMatch } from "@/lib/ingestion/dedup";

const JUDGE_MODEL = "claude-opus-5";
const JUDGE_VERSION = "judge/1.0.0-2026-09-08";
const MAX_CHARS = 60_000;

interface FrozenItem {
  stratum: string; sourceEventId: string; url: string; publisherUrl: string | null; title: string; provider: string; sourceType: string; publishedAt: string | null; storedText: string | null;
  old: { processingStatus: string; exclusionReason: string | null; events: { id: string; family: string; eventType: string; publicationStatus: string; counterparty: string | null; tcvUsd: number | null; clientRaw: string | null }[] };
}
interface JudgeEvent { provider: string; buyer: string | null; buyerDescriptor: string | null; buyerSector: string; eventType: string; status: string; contractValue: number | null; currency: string | null; durationMonths: number | null; quote: string; providerTracked?: string | null }
interface Judge { articleType: string; commercialEvents: JudgeEvent[]; notes: string; model: string }
interface Result {
  sourceEventId: string; stratum: string; title: string; url: string; textChars: number; textSource: "fetched" | "stored" | "unusable";
  reading: { articleType: string; segments: number; events: GroundedEvent[]; modelId: string; promptPolicyVersion: string; costUsd: number } | null;
  readError: string | null;
  judge: Judge | null; judgeError: string | null; judgeCostUsd: number;
}

const JUDGE_SYSTEM = `You are an independent audit reader for a market-intelligence programme covering IT and business services providers. You will be given one article. Read ALL of it before answering. You are not told what any other system concluded; do not guess what is wanted.

A COMMERCIAL CONTRACT EVENT is a specific engagement between an identifiable services provider and an identifiable buyer (named, or described e.g. "a leading US insurer"): a new award/win, renewal, extension, expansion, recompete, competitive takeaway (incumbent replaced), replacement, scope reduction, termination, contract change, or a procurement opportunity (tender/RFP naming the buyer). Include events reported inside earnings calls, case studies, analyst notes and stock coverage — the article type does not matter, the presence of a concrete engagement does. Exclude: sponsorships and CSR; product launches; generic "partnerships" or alliances with no buyer engagement; industry awards; hiring; vague pipeline talk with no identifiable buyer; the provider's own IT purchases.

For each event, quote a verbatim passage (≤200 chars) that establishes it. Report values ONLY when stated in the text; never estimate. Buyer sector: a commercial company (bank, insurer, retailer, telecom, manufacturer...) is PRIVATE_SECTOR; a government, ministry, agency, NHS trust, public university, defence department is PUBLIC_SECTOR; state-owned enterprises STATE_OWNED_OR_MIXED; charities NON_PROFIT; otherwise UNKNOWN.

Answer with ONE JSON object only:
{"articleType":"COMPANY_ANNOUNCEMENT|NEWS_REPORT|EARNINGS|STOCK_ANALYST_NOTE|CASE_STUDY|TENDER_RFP|SPONSORSHIP_CSR|PRODUCT_LAUNCH|PARTNERSHIP_ALLIANCE|M_AND_A|PEOPLE_MOVE|OPINION|OTHER",
 "commercialEvents":[{"provider":"...","buyer":"... or null","buyerDescriptor":"... or null","buyerSector":"PRIVATE_SECTOR|PUBLIC_SECTOR|STATE_OWNED_OR_MIXED|NON_PROFIT|UNKNOWN","eventType":"NEW_WIN|RENEWAL|EXTENSION|EXPANSION|SCOPE_REDUCTION|RECOMPETE|COMPETITIVE_TAKEAWAY|REPLACEMENT|TERMINATION|CONTRACT_CHANGE|OTHER_COMMERCIAL_EVENT","status":"ANNOUNCED|COMPLETED|OPPORTUNITY|TERMINATED|DISPUTED|UNKNOWN","contractValue":number|null,"currency":"ISO code or null","durationMonths":number|null,"quote":"verbatim passage"}],
 "notes":"one line"}`;

async function judge(title: string, text: string): Promise<{ judge: Judge | null; error: string | null; costUsd: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { judge: null, error: "ANTHROPIC_API_KEY not configured", costUsd: 0 };
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 4000, system: JUDGE_SYSTEM, messages: [{ role: "user", content: `TITLE: ${title}\n\nARTICLE:\n${text.slice(0, MAX_CHARS)}` }] }),
    });
  } catch (err) { return { judge: null, error: `judge call failed: ${err instanceof Error ? err.message : String(err)}`, costUsd: 0 }; }
  if (!res.ok) return { judge: null, error: `judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, costUsd: 0 };
  const data = await res.json() as { content?: { type: string; text: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
  const costUsd = ((data.usage?.input_tokens ?? 0) * 15 + (data.usage?.output_tokens ?? 0) * 75) / 1_000_000;
  if (data.model && !data.model.startsWith(JUDGE_MODEL)) return { judge: null, error: `judge model substituted: ${data.model}`, costUsd };
  const txt = (data.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return { judge: null, error: "judge returned no JSON", costUsd };
  try {
    const j = JSON.parse(m[0]) as Judge;
    j.model = data.model ?? JUDGE_MODEL;
    j.commercialEvents = (j.commercialEvents ?? []).map(e => ({ ...e, providerTracked: matchTrackedVendorPreferring(e.provider ?? "", []) }));
    return { judge: j, error: null, costUsd };
  } catch { return { judge: null, error: "judge JSON did not parse", costUsd }; }
}

/** Fetch the page, retrying the aggregator redirect; fall back to stored text only if it is a real article. */
async function articleText(it: FrozenItem, attempts = 3): Promise<{ text: string; source: "fetched" | "stored" | "unusable" }> {
  // A resolved publisher URL skips the aggregator redirect entirely.
  for (const url of [it.publisherUrl, it.url].filter(Boolean) as string[]) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const f = await retrieveArticle(url, MAX_CHARS);
        const t = readableArticleText(f.article?.text);
        if (t) return { text: t, source: "fetched" };
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1) + Math.random() * 1500));
    }
  }
  const stored = readableArticleText(it.storedText);
  return stored ? { text: stored, source: "stored" } : { text: "", source: "unusable" };
}

// ── metrics ──────────────────────────────────────────────────────────────────
const isOpp = (s: string | null | undefined) => (s ?? "").toUpperCase() === "OPPORTUNITY";
function oldPos(it: FrozenItem, strict: boolean) {
  return it.old.events.some(e => e.family === "CONTRACT" && (e.publicationStatus === "published" || (!strict && e.publicationStatus === "needs_review")));
}
function newEvents(r: Result) { return (r.reading?.events ?? []).filter(e => e.family === "CONTRACT" && !!e.provider); }
function newPos(r: Result, strict: boolean) { return newEvents(r).some(e => !strict || !isOpp(e.eventStatus)); }
function judgeEvents(r: Result) { return (r.judge?.commercialEvents ?? []).filter(e => !!e.providerTracked); }
function truthPos(r: Result, strict: boolean) { return judgeEvents(r).some(e => !strict || !isOpp(e.status)); }

interface Conf { tp: number; fp: number; fn: number; tn: number }
const conf = (): Conf => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
function tally(c: Conf, pred: boolean, truth: boolean) { if (pred && truth) c.tp++; else if (pred && !truth) c.fp++; else if (!pred && truth) c.fn++; else c.tn++; }
const prec = (c: Conf) => c.tp + c.fp ? c.tp / (c.tp + c.fp) : NaN;
const rec = (c: Conf) => c.tp + c.fn ? c.tp / (c.tp + c.fn) : NaN;
const pct = (x: number) => Number.isNaN(x) ? "n/a" : `${(100 * x).toFixed(0)}%`;

function sameBuyer(a: { buyer: string | null; buyerDescriptor: string | null }, b: { buyer: string | null; buyerDescriptor: string | null }) {
  if (a.buyer && b.buyer) return orgsMatch(a.buyer, b.buyer);
  if (!a.buyer && !b.buyer) return true;                       // both descriptor-only (or none) under the same provider
  return orgsMatch(a.buyer ?? a.buyerDescriptor ?? "", b.buyer ?? b.buyerDescriptor ?? "");
}

function report(setFile: string, results: Result[], strata: { key: string; requested: number; population: number }[], items: FrozenItem[]) {
  const byId = new Map(items.map(i => [i.sourceEventId, i]));
  const unusable = results.filter(r => r.textSource === "unusable" || (!r.reading && r.readError === "no readable article text"));
  const judged = results.filter(r => r.judge && r.reading && r.textSource !== "unusable");
  const lines: string[] = [];
  lines.push(`# OLD vs NEW pipeline — frozen set ${setFile}`, "",
    `Items: ${items.length} frozen · ${results.length} processed · ${judged.length} scored · ${unusable.length} excluded because no readable article text could be obtained (the stored copy is feed scaffolding and the page could not be re-fetched) · ${results.filter(r => r.readError && r.readError !== "no readable article text").length} NEW read failures · ${results.filter(r => r.judgeError && r.judgeError !== "no readable article text").length} judge failures`, "",
    `NEW reader: ${READER_MODEL} · ${PROMPT_POLICY_VERSION}. Judge: ${JUDGE_MODEL} · ${JUDGE_VERSION} (independent rubric; a model, not a human — every disagreement is listed below for spot-checking).`, "",
    `Positive = the article contains ≥1 commercial contract event whose provider is a tracked vendor. STRICT excludes OPPORTUNITY (tender) events; LENIENT counts them. OLD strict = a published CONTRACT event; OLD lenient also counts needs_review.`, "");
  for (const strict of [true, false]) {
    lines.push(`## ${strict ? "STRICT" : "LENIENT"}`, "", `| stratum | n | pop | OLD prec | OLD rec | OLD FP | OLD FN | NEW prec | NEW rec | NEW FP | NEW FN | truth+ |`, `|---|---|---|---|---|---|---|---|---|---|---|---|`);
    const tot = { old: conf(), nw: conf() }, wtot = { old: conf(), nw: conf() };
    for (const st of strata) {
      const rs = judged.filter(r => r.stratum === st.key);
      const o = conf(), n = conf();
      for (const r of rs) { const t = truthPos(r, strict); tally(o, oldPos(byId.get(r.sourceEventId)!, strict), t); tally(n, newPos(r, strict), t); }
      const w = rs.length ? st.population / rs.length : 0;
      for (const k of ["tp", "fp", "fn", "tn"] as const) { tot.old[k] += o[k]; tot.nw[k] += n[k]; wtot.old[k] += o[k] * w; wtot.nw[k] += n[k] * w; }
      lines.push(`| ${st.key} | ${rs.length} | ${st.population} | ${pct(prec(o))} | ${pct(rec(o))} | ${o.fp} | ${o.fn} | ${pct(prec(n))} | ${pct(rec(n))} | ${n.fp} | ${n.fn} | ${o.tp + o.fn} |`);
    }
    lines.push(`| **all (unweighted)** | ${judged.length} | | ${pct(prec(tot.old))} | ${pct(rec(tot.old))} | ${tot.old.fp} | ${tot.old.fn} | ${pct(prec(tot.nw))} | ${pct(rec(tot.nw))} | ${tot.nw.fp} | ${tot.nw.fn} | ${tot.old.tp + tot.old.fn} |`);
    lines.push(`| **population-weighted** | | ${strata.reduce((a, s) => a + s.population, 0)} | ${pct(prec(wtot.old))} | ${pct(rec(wtot.old))} | ${wtot.old.fp.toFixed(0)} | ${wtot.old.fn.toFixed(0)} | ${pct(prec(wtot.nw))} | ${pct(rec(wtot.nw))} | ${wtot.nw.fp.toFixed(0)} | ${wtot.nw.fn.toFixed(0)} | ${(wtot.old.tp + wtot.old.fn).toFixed(0)} |`, "");
  }
  // recovered
  const recovered = judged.filter(r => truthPos(r, false) && !oldPos(byId.get(r.sourceEventId)!, false) && newPos(r, false));
  const recoveredPrivate = recovered.filter(r => judgeEvents(r).some(e => e.buyerSector === "PRIVATE_SECTOR"));
  const lost = judged.filter(r => truthPos(r, false) && oldPos(byId.get(r.sourceEventId)!, false) && !newPos(r, false));
  lines.push(`## Recovery`, "", `- Commercial events recovered (judge +, OLD −, NEW +): **${recovered.length}** articles`, `- of which private-sector buyer: **${recoveredPrivate.length}**`, `- Lost (judge +, OLD +, NEW −): **${lost.length}**`, "");
  // event level
  let jTot = 0, nTot = 0, matched = 0, typeAgree = 0, sectorAgree = 0, statusAgree = 0, valBothNull = 0, valAgree = 0, valDisagree = 0, valNewMissing = 0, valNewExtra = 0, multiJ = 0, multiN = 0;
  for (const r of judged) {
    const js = judgeEvents(r), ns = newEvents(r);
    jTot += js.length; nTot += ns.length; if (js.length > 1) multiJ++; if (ns.length > 1) multiN++;
    const used = new Set<number>();
    for (const j of js) {
      const k = ns.findIndex((n, i) => !used.has(i) && n.provider === j.providerTracked && sameBuyer(n, j));
      if (k < 0) continue;
      used.add(k); matched++;
      const n = ns[k];
      if (n.commercialEventType === j.eventType) typeAgree++;
      if (n.buyerSector === j.buyerSector) sectorAgree++;
      if (n.eventStatus === j.status) statusAgree++;
      if (n.contractValue == null && j.contractValue == null) valBothNull++;
      else if (n.contractValue != null && j.contractValue != null) { if ((n.currency ?? "").toUpperCase() === (j.currency ?? "").toUpperCase() && Math.abs(n.contractValue - j.contractValue) <= 0.05 * Math.max(n.contractValue, j.contractValue)) valAgree++; else valDisagree++; }
      else if (n.contractValue == null) valNewMissing++; else valNewExtra++;
    }
  }
  lines.push(`## Event level (tracked-provider contract events)`, "", `| | judge | NEW |`, `|---|---|---|`, `| events | ${jTot} | ${nTot} |`, `| articles with >1 event | ${multiJ} | ${multiN} |`, `| matched pairs (provider + buyer) | ${matched} | |`, "",
    `Agreement on matched pairs: type ${pct(matched ? typeAgree / matched : NaN)} · buyer sector ${pct(matched ? sectorAgree / matched : NaN)} · status ${pct(matched ? statusAgree / matched : NaN)} · value: both absent ${valBothNull}, agree ${valAgree}, disagree ${valDisagree}, NEW missing a stated value ${valNewMissing}, NEW has a value the judge did not ${valNewExtra}`, "");
  // article type
  const at = new Map<string, number>();
  for (const r of judged) { const k = `${r.judge!.articleType} → ${r.reading!.articleType}`; at.set(k, (at.get(k) ?? 0) + 1); }
  // Items neither pipeline could see: no readable text, so no verdict is possible.
  const uHosts = new Map<string, number>();
  for (const r of unusable) { const h = (() => { try { return new URL(r.url).hostname.replace(/^www\./, ""); } catch { return "?"; } })(); uHosts.set(h, (uHosts.get(h) ?? 0) + 1); }
  const uStrata = new Map<string, number>();
  for (const r of unusable) uStrata.set(r.stratum, (uStrata.get(r.stratum) ?? 0) + 1);
  lines.push(`## Items excluded for want of readable text`, "",
    `${unusable.length} of ${items.length} frozen articles could not be scored: the stored copy is the feed's link markup, and the publisher page could not be fetched now (paywalls, client-rendered finance aggregators, dead links). Neither pipeline can see these, so they are excluded from the metrics rather than counted against either.`, "",
    `| stratum | items |`, `|---|---|`, ...[...uStrata.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`), "",
    `| host | items |`, `|---|---|`, ...[...uHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `| ${k} | ${v} |`), "");
  lines.push(`## Article type (judge → NEW), top 15`, "", ...[...at.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `- ${k}: ${v}`), "");
  // disagreements
  lines.push(`## Disagreements for spot-check (judge vs NEW, lenient)`, "");
  for (const r of judged) {
    const t = truthPos(r, false), n = newPos(r, false), o = oldPos(byId.get(r.sourceEventId)!, false);
    if (t === n) continue;
    const je = judgeEvents(r)[0], ne = newEvents(r)[0];
    lines.push(`- **${r.title.slice(0, 110)}** — ${r.url}`, `  - stratum ${r.stratum} · OLD ${o ? "+" : "−"} · NEW ${n ? "+" : "−"} (${r.reading!.articleType}${ne ? `: ${ne.provider} / ${ne.buyer ?? ne.buyerDescriptor ?? "?"} ${ne.commercialEventType}` : ""}) · judge ${t ? "+" : "−"} (${r.judge!.articleType}${je ? `: ${je.provider} / ${je.buyer ?? je.buyerDescriptor ?? "?"} ${je.eventType}` : ""})`, `  - judge: ${(je?.quote ?? r.judge!.notes ?? "").slice(0, 200)}`);
  }
  const cost = results.reduce((a, r) => a + (r.reading?.costUsd ?? 0) + r.judgeCostUsd, 0);
  lines.push("", `Spend: $${cost.toFixed(2)} (reader + judge).`);
  return lines.join("\n");
}

(async () => {
  const argv = process.argv;
  const setFile = argv.includes("--set") ? argv[argv.indexOf("--set") + 1] : "scripts/eval/frozen-set-2026-09-08.json";
  const concurrency = argv.includes("--concurrency") ? Number(argv[argv.indexOf("--concurrency") + 1]) : 6;
  const resultsFile = setFile.replace("frozen-set", "results");
  const reportFile = setFile.replace("frozen-set", "eval-report").replace(/\.json$/, ".md");
  const set = JSON.parse(fs.readFileSync(setFile, "utf8")) as { strata: { key: string; requested: number; population: number }[]; items: FrozenItem[] };
  const results: Result[] = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : [];
  const done = new Set(results.map(r => r.sourceEventId));
  if (!argv.includes("--report-only")) {
    // Re-judge entries whose reading succeeded but whose judge call failed
    // (e.g. an API-shape error) — the reading is not paid for twice.
    const byId = new Map(set.items.map(i => [i.sourceEventId, i]));
    const rejudge = results.filter(r => !r.judge && r.reading && byId.has(r.sourceEventId));
    if (rejudge.length) {
      console.log(`re-judging ${rejudge.length} entries whose judge call failed`);
      let rc = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (rc < rejudge.length) {
          const res = rejudge[rc++];
          const it = byId.get(res.sourceEventId)!;
          const { text } = await articleText(it);
          const jd = await judge(it.title, text);
          res.judge = jd.judge; res.judgeError = jd.error; res.judgeCostUsd += jd.costUsd;
          if (rc % 20 === 0) fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
        }
      }));
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
      console.log(`re-judged; failures left: ${results.filter(r => !r.judge).length}`);
    }
    // --fix-unusable: items whose text could not be obtained are retried
    // patiently (the aggregator rate-limits), then read and judged.
    if (argv.includes("--fix-unusable")) {
      const byId2 = new Map(set.items.map(i => [i.sourceEventId, i]));
      const stuck = results.filter(r => r.textSource === "unusable");
      console.log(`retrying ${stuck.length} items with no readable text`);
      let fixed = 0, sc = 0;
      await Promise.all(Array.from({ length: Math.min(2, concurrency) }, async () => {
        while (sc < stuck.length) {
          const res = stuck[sc++];
          const it = byId2.get(res.sourceEventId);
          if (!it) continue;
          const { text, source } = await articleText(it, 5);
          if (!text) continue;
          res.textChars = text.length; res.textSource = source;
          const [rd, jd] = await Promise.all([readArticle({ title: it.title, text, provider: it.provider, sourceType: it.sourceType, publishedAt: it.publishedAt }), judge(it.title, text)]);
          if (rd.ok) { res.reading = { articleType: rd.reading.articleType, segments: rd.reading.segments, events: rd.reading.events, modelId: rd.reading.modelId, promptPolicyVersion: rd.reading.promptPolicyVersion, costUsd: rd.reading.usage.costUsd }; res.readError = null; }
          else { res.reading = null; res.readError = rd.error; }
          res.judge = jd.judge; res.judgeError = jd.error; res.judgeCostUsd += jd.costUsd;
          fixed++;
          if (fixed % 10 === 0) { fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1)); console.log(`  recovered ${fixed} (${sc}/${stuck.length} tried)`); }
        }
      }));
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
      console.log(`recovered ${fixed} of ${stuck.length}`);
    }
    // --reread: re-run only the reader over items already judged, so a prompt
    // change is measured against the same frozen set and the same verdicts.
    if (argv.includes("--reread")) {
      const judgedIds = new Set(results.filter(r => r.judge).map(r => r.sourceEventId));
      const items = set.items.filter(i => judgedIds.has(i.sourceEventId));
      console.log(`re-reading ${items.length} judged items with ${PROMPT_POLICY_VERSION}`);
      let rr = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (rr < items.length) {
          const it = items[rr++];
          const res = results.find(r => r.sourceEventId === it.sourceEventId)!;
          const { text, source } = await articleText(it);
          res.textChars = text.length; res.textSource = source;
          if (!text) { res.reading = null; res.readError = "no readable article text"; continue; }
          const rd = await readArticle({ title: it.title, text, provider: it.provider, sourceType: it.sourceType, publishedAt: it.publishedAt });
          if (rd.ok) { res.reading = { articleType: rd.reading.articleType, segments: rd.reading.segments, events: rd.reading.events, modelId: rd.reading.modelId, promptPolicyVersion: rd.reading.promptPolicyVersion, costUsd: rd.reading.usage.costUsd }; res.readError = null; }
          else { res.reading = null; res.readError = rd.error; }
          if (rr % 20 === 0) { fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1)); console.log(`  re-read ${rr}/${items.length}`); }
        }
      }));
      fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
      console.log(`re-read done; read failures: ${results.filter(r => !r.reading).length}`);
    }
    const todo = argv.includes("--reread") || argv.includes("--fix-unusable") ? [] : set.items.filter(i => !done.has(i.sourceEventId));
    console.log(`${todo.length} to process (${results.length} already done)`);
    let cursor = 0;
    const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1));
    async function worker() {
      while (cursor < todo.length) {
        const it = todo[cursor++];
        const t0 = Date.now();
        const { text, source: textSource } = await articleText(it);
        const res: Result = { sourceEventId: it.sourceEventId, stratum: it.stratum, title: it.title, url: it.url, textChars: text.length, textSource, reading: null, readError: null, judge: null, judgeError: null, judgeCostUsd: 0 };
        if (!text) { res.readError = "no readable article text"; res.judgeError = "no readable article text"; results.push(res); save(); continue; }
        const [rd, jd] = await Promise.all([
          readArticle({ title: it.title, text, provider: it.provider, sourceType: it.sourceType, publishedAt: it.publishedAt }),
          judge(it.title, text),
        ]);
        if (rd.ok) { const r: Reading = rd.reading; res.reading = { articleType: r.articleType, segments: r.segments, events: r.events, modelId: r.modelId, promptPolicyVersion: r.promptPolicyVersion, costUsd: r.usage.costUsd }; }
        else res.readError = rd.error;
        res.judge = jd.judge; res.judgeError = jd.error; res.judgeCostUsd = jd.costUsd;
        results.push(res); save();
        console.log(`[${results.length}/${set.items.length}] ${it.stratum} ${((Date.now() - t0) / 1000).toFixed(0)}s ${textSource} ${text.length}ch | NEW ${rd.ok ? `${rd.reading.articleType} ${newEvents(res).length}ev` : `FAIL ${rd.error}`} | judge ${jd.judge ? `${jd.judge.articleType} ${judgeEvents(res).length}ev` : `FAIL ${jd.error}`} | ${it.title.slice(0, 60)}`);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  const md = report(setFile, results, set.strata, set.items);
  fs.writeFileSync(reportFile, md);
  console.log("\n" + md.split("\n").slice(0, 60).join("\n"));
  console.log(`\nreport → ${reportFile}`);
})();
