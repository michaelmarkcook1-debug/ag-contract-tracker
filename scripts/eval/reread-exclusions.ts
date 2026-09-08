/**
 * Re-read articles the old pipeline excluded and classify each into the four
 * buckets the mandate names (§20):
 *
 *   CORRECTLY_EXCLUDED           — no commercial event, the old verdict stands
 *   COMMERCIAL_EVENT_RECOVERED   — a contract event the old pipeline threw away
 *   RELEVANT_NON_CONTRACT_SIGNAL — real market signal, not a contract event
 *   UNREADABLE                   — no article text could be obtained; no verdict
 *
 * Read-only by default: the old exclusion records are never deleted, and
 * nothing is written unless --apply is passed (which records the re-read
 * classification and keeps the earlier reason in previousExclusionReason).
 *
 *   npx tsx scripts/eval/reread-exclusions.ts [--sample 120] [--reason model:] [--concurrency 5] [--apply]
 */
import fs from "fs";
import { prisma } from "@/lib/db";
import { retrieveArticle, readableArticleText } from "@/lib/ingestion/article-text";
import { readArticle, READER_MODEL, PROMPT_POLICY_VERSION } from "@/lib/ingestion/reader";
import { storeReading, storeNonEvent, storeUnreadable } from "@/lib/ingestion/store";
import type { RawArticle } from "@/lib/ingestion/crawler";

type Bucket = "CORRECTLY_EXCLUDED" | "COMMERCIAL_EVENT_RECOVERED" | "RELEVANT_NON_CONTRACT_SIGNAL" | "UNREADABLE";
const SIGNAL_TYPES = new Set(["EARNINGS", "STOCK_ANALYST_NOTE", "M_AND_A", "PARTNERSHIP_ALLIANCE", "PRODUCT_LAUNCH", "PEOPLE_MOVE", "RESEARCH", "TENDER_RFP", "CLIENT_ANNOUNCEMENT"]);

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };

(async () => {
  const sample = Number(arg("--sample", "120"));
  const reasonLike = arg("--reason", "");
  const concurrency = Number(arg("--concurrency", "5"));
  const apply = process.argv.includes("--apply");

  const where = { processingStatus: "excluded", ...(reasonLike ? { exclusionReason: { startsWith: reasonLike } } : {}) };
  const population = await prisma.sourceEvent.count({ where });
  const byReason = await prisma.sourceEvent.groupBy({ by: ["exclusionReason"], where, _count: { _all: true }, orderBy: { _count: { id: "desc" } } });
  const ids = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "SourceEvent" WHERE "processingStatus"='excluded'${reasonLike ? ` AND "exclusionReason" LIKE '${reasonLike}%'` : ""} ORDER BY random() LIMIT ${sample}`);
  const rows = await prisma.sourceEvent.findMany({ where: { id: { in: ids.map(i => i.id) } },
    select: { id: true, sourceUrl: true, publisherUrl: true, sourceTitle: true, sourceName: true, sourceType: true, publicationDate: true, rawText: true, exclusionReason: true } });

  console.log(`population ${population} excluded rows; re-reading a sample of ${rows.length}${apply ? " (writing results)" : " (read-only)"}\n`);

  const out: { id: string; title: string; url: string; oldReason: string | null; bucket: Bucket; articleType: string | null; detail: string }[] = [];
  let cursor = 0, cost = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < rows.length) {
      const r = rows[cursor++];
      const article: RawArticle = { title: r.sourceTitle ?? "", url: r.sourceUrl, publishedAt: r.publicationDate?.toISOString() ?? null, snippet: null,
        sourceId: "reread", provider: r.sourceName ?? "", sourceType: r.sourceType ?? "wire_service", publisherUrl: r.publisherUrl, bodyText: r.rawText };
      let text = readableArticleText(r.rawText) ?? "";
      try { const f = await retrieveArticle(r.sourceUrl, 60_000); const t = readableArticleText(f.article?.text); if (t && t.length >= text.length) { text = t; article.publisherUrl = f.publisherUrl; article.bodyText = t; } } catch { /* stored text stands */ }
      if (!text) {
        out.push({ id: r.id, title: article.title, url: r.sourceUrl, oldReason: r.exclusionReason, bucket: "UNREADABLE", articleType: null, detail: "no readable article text" });
        if (apply) await storeUnreadable(article, "reread");
        continue;
      }
      const rd = await readArticle({ title: article.title, text, provider: article.provider, sourceType: article.sourceType, publishedAt: article.publishedAt });
      if (!rd.ok) { cost += rd.usage.costUsd; out.push({ id: r.id, title: article.title, url: r.sourceUrl, oldReason: r.exclusionReason, bucket: "UNREADABLE", articleType: null, detail: `read failed: ${rd.error}` }); continue; }
      cost += rd.reading.usage.costUsd;
      const contract = rd.reading.events.filter(e => e.family === "CONTRACT" && !!e.provider);
      const other = rd.reading.events.filter(e => !!e.provider && e.family !== "CONTRACT");
      const bucket: Bucket = contract.length ? "COMMERCIAL_EVENT_RECOVERED"
        : other.length || SIGNAL_TYPES.has(rd.reading.articleType) ? "RELEVANT_NON_CONTRACT_SIGNAL"
        : "CORRECTLY_EXCLUDED";
      out.push({ id: r.id, title: article.title, url: r.sourceUrl, oldReason: r.exclusionReason, bucket, articleType: rd.reading.articleType,
        detail: contract.length ? contract.map(e => `${e.provider} / ${e.buyer ?? e.buyerDescriptor ?? "?"} ${e.commercialEventType}`).join(" ; ") : other.map(e => `${e.family}`).join(",") });
      if (apply) {
        article.bodyText = text;
        if (rd.reading.events.length === 0) await storeNonEvent(article, text, rd.reading, "reread");
        else await storeReading(article, text, rd.reading, "reread");
      }
      if (out.length % 20 === 0) console.log(`  ${out.length}/${rows.length}`);
    }
  }));

  const counts = out.reduce((a, o) => { a[o.bucket] = (a[o.bucket] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const scored = out.filter(o => o.bucket !== "UNREADABLE").length;
  const L: string[] = [`# Old exclusions re-read — ${new Date().toISOString().slice(0, 16)}Z`, "",
    `Reader ${READER_MODEL} · ${PROMPT_POLICY_VERSION}. Population: ${population} excluded rows${reasonLike ? ` matching \`${reasonLike}\`` : ""}. Sample: ${rows.length}. Model spend $${cost.toFixed(2)}.`, "",
    `No old exclusion record was deleted. ${apply ? "The re-read verdict was written, and each row keeps its earlier reason in previousExclusionReason." : "This pass wrote nothing."}`, "",
    `| bucket | n | % of sample | % of readable | projected population |`, `|---|---|---|---|---|`];
  for (const b of ["CORRECTLY_EXCLUDED", "COMMERCIAL_EVENT_RECOVERED", "RELEVANT_NON_CONTRACT_SIGNAL", "UNREADABLE"] as Bucket[]) {
    const n = counts[b] ?? 0;
    L.push(`| ${b} | ${n} | ${(100 * n / out.length).toFixed(0)}% | ${b === "UNREADABLE" ? "—" : `${(100 * n / Math.max(1, scored)).toFixed(0)}%`} | ${Math.round(population * n / out.length)} |`);
  }
  L.push("", `## Old exclusion reasons in the population`, "", `| reason | n |`, `|---|---|`, ...byReason.map(b => `| ${b.exclusionReason ?? "(none)"} | ${b._count._all} |`), "");
  L.push(`## Recovered commercial events`, "", ...out.filter(o => o.bucket === "COMMERCIAL_EVENT_RECOVERED").map(o => `- **${o.title.slice(0, 110)}** (was \`${o.oldReason}\`, read as ${o.articleType}) — ${o.detail}`), "");
  L.push(`## Relevant non-contract signal`, "", ...out.filter(o => o.bucket === "RELEVANT_NON_CONTRACT_SIGNAL").slice(0, 40).map(o => `- ${o.title.slice(0, 110)} (was \`${o.oldReason}\`, read as ${o.articleType})`), "");
  const outFile = `scripts/eval/exclusions-reread-${new Date().toISOString().slice(0, 10)}.md`;
  fs.writeFileSync(outFile, L.join("\n"));
  console.log(`\n${L.slice(0, 14).join("\n")}\n\nreport → ${outFile}`);
  await prisma.$disconnect();
})();
