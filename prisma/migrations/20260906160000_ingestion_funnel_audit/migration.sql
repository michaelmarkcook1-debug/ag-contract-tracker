-- Ingestion funnel audit: additive, nullable / defaulted columns only.
ALTER TABLE "SourceEvent" ADD COLUMN "exclusionReason" TEXT, ADD COLUMN "publisherUrl" TEXT;
CREATE INDEX "SourceEvent_publisherUrl_idx" ON "SourceEvent"("publisherUrl");
ALTER TABLE "CanonicalMarketEvent" ADD COLUMN "reviewReason" TEXT, ADD COLUMN "counterpartyRaw" TEXT;
ALTER TABLE "IngestionRun"
  ADD COLUMN "articlesRelevant" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "articlesStale"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "articlesTriaged"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "articlesExcluded" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "articlesDeferred" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "articlesMerged"   INTEGER NOT NULL DEFAULT 0;
