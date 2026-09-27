import { connection } from "next/server";
import { prisma } from "@/lib/db";
import { getEvents, trackedEventScope } from "@/lib/data";
import { syncSourceRegistry } from "@/lib/ingestion/pipeline";
import { AdminRunPanel } from "@/components/market/AdminRunPanel";
import { ReviewQueue } from "@/components/market/ReviewQueue";
import { CostPanel } from "@/components/market/CostPanel";
import { SourceHealthTable } from "@/components/market/SourceHealthTable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

export default async function AdminPage() {
  // Opt out of prerendering. Without this the whole admin page — including the
  // review queue and its counts — is baked at build time, so approvals appear
  // to do nothing and newly ingested events never show up.
  await connection();

  // Seed the registry only when empty. This used to run on every page load,
  // which meant 90+ upserts per view; the pipeline reads sources from code, so
  // the registry is only needed to populate the Sources tab.
  if ((await prisma.sourceRegistryItem.count()) === 0) {
    await syncSourceRegistry();
  }

  const [ingestionStatus, reviewData, runs, sourceItems] = await Promise.all([
    // API key + source status
    (async () => ({
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      sourcesTotal: await prisma.sourceRegistryItem.count({ where: { isActive: true } }),
      needsReview: await prisma.canonicalMarketEvent.count({ where: { publicationStatus: "needs_review", ...(await trackedEventScope()) } }),
      lastRun: await prisma.ingestionRun.findFirst({ orderBy: { startedAt: "desc" } }).then(r => r ? {
        ...r,
        errors: JSON.parse(r.errors || "[]"),
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
      } : null),
    }))(),
    // Review queue events
    getEvents({ status: "needs_review", pageSize: 50 }),
    // Recent ingestion runs
    prisma.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 15 }),
    // Source health
    prisma.sourceRegistryItem.findMany({ orderBy: [{ consecutiveErrors: "desc" }, { lastCrawledAt: "desc" }] }),
  ]);

  return (
    <div className="px-4 py-5 md:p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold">Admin</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Ingestion pipeline · Review queue · Source health
        </p>
      </div>

      <Tabs defaultValue="pipeline">
        <div className="-mx-4 px-4 md:mx-0 md:px-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsList className="bg-zinc-900 border border-border w-max">
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="review" className="relative">
            Review Queue
            {ingestionStatus.needsReview > 0 && (
              <span className="ml-1.5 bg-amber-500/20 text-amber-400 text-[10px] font-mono px-1.5 py-0.5 rounded-full">
                {ingestionStatus.needsReview}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="sources">Sources ({ingestionStatus.sourcesTotal})</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
          <TabsTrigger value="runs">Run History</TabsTrigger>
        </TabsList>
        </div>

        {/* Pipeline tab */}
        <TabsContent value="pipeline" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 lg:gap-6">
            <div className="lg:col-span-2 min-w-0">
              <AdminRunPanel initialStatus={ingestionStatus} />
            </div>
            <div className="lg:col-span-3 min-w-0 space-y-4">
              <div className="rounded-lg border border-border bg-card p-4 text-sm space-y-3">
                <h3 className="font-medium text-sm">Pipeline architecture</h3>
                <Separator />
                <div className="space-y-2 text-xs text-muted-foreground">
                  {[
                    ["1. Crawl", "Fetch RSS/API sources (Google News queries are date-bounded)."],
                    ["2. Dedup", "Skip URLs already stored — including ones previously excluded."],
                    ["3. Select", "Structural only: age cutoff (60 days) and, for market-wide wires, a tracked-vendor name. Every rejection is recorded with its reason."],
                    ["4. Read + triage", "Publisher page fetched (Google News links decoded). Haiku reads the article: article type, event status, family, vendor, counterparty. Out-of-scope articles are recorded with their type, not re-bought."],
                    ["5. Dedupe + analyse", "Re-reports attach to the stored event as extra sources (vendor, counterparty, ±14 days). Sonnet reads every in-scope article: scope, parties, value (stated or a labelled estimate), insight."],
                    ["6. Gate + store", "Publishes on the model's reading: vendor resolved, counterparty named, event type valid, event announced or completed. Tenders, terminations, disputes and low confidence go to needs_review with the reasons."],
                  ].map(([step, desc]) => (
                    <div key={step} className="flex flex-col sm:flex-row gap-0.5 sm:gap-3">
                      <span className="text-zinc-500 font-mono sm:w-28 shrink-0">{step}</span>
                      <span>{desc}</span>
                    </div>
                  ))}
                </div>
                <Separator />
                <p className="text-[10px] text-zinc-600">
                  Every published record links to its source URL. No hallucinated data.
                  Confidence scores reflect extraction quality, not commercial significance.
                </p>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Review queue tab */}
        <TabsContent value="review" className="mt-4">
          <ReviewQueue
            initialEvents={reviewData.events}
            totalCount={reviewData.total}
          />
        </TabsContent>

        {/* Cost tab */}
        <TabsContent value="costs" className="mt-4">
          <CostPanel />
        </TabsContent>

        {/* Sources tab */}
        <TabsContent value="sources" className="mt-4">
          <SourceHealthTable
            sources={sourceItems.map(s => ({
              ...s,
              lastCrawledAt: s.lastCrawledAt?.toISOString() ?? null,
              nextDueAt: s.nextDueAt?.toISOString() ?? null,
            }))}
          />
        </TabsContent>

        {/* Run history tab */}
        <TabsContent value="runs" className="mt-4">
          <div className="rounded-md border border-border overflow-x-auto">
            <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b border-border bg-zinc-900/50">
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Started</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Type</th>
                  <th className="text-left px-3 py-2 text-muted-foreground font-medium">Status</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Found</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium" title="URLs ingested on an earlier run — skipped before any model spend">Already stored</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium" title="Survived the age cutoff, rules and vendor gate">Candidates</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Triaged</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium" title="Judged out of scope by the model">Excluded</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Published</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Queued</th>
                  <th className="text-right px-3 py-2 text-muted-foreground font-medium">Deferred</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.id} className="border-b border-border/50">
                    <td className="px-3 py-2 font-mono text-muted-foreground whitespace-nowrap">
                      {run.startedAt.toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{run.runType}</td>
                    <td className="px-3 py-2">
                      <span className={`font-medium ${run.status === "completed" ? "text-emerald-400" : run.status === "running" ? "text-blue-400" : run.status === "partial" ? "text-yellow-400" : "text-red-400"}`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{run.articlesFound}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-500">{run.articlesDuped}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{run.articlesRelevant}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{run.articlesTriaged}</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-500">{run.articlesExcluded}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-400">{run.eventsPublished}</td>
                    <td className="px-3 py-2 text-right font-mono text-amber-400">{run.eventsQueued}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">{run.articlesDeferred}</td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-8 text-center text-muted-foreground">No runs yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
