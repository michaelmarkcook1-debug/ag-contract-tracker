-- AI Delivery Mandate: commercial-event fields, reading provenance, commercial mechanics. Additive only.
ALTER TABLE "SourceEvent"
  ADD COLUMN "articleType" TEXT,
  ADD COLUMN "articleTextHash" TEXT,
  ADD COLUMN "articleTextChars" INTEGER,
  ADD COLUMN "modelId" TEXT,
  ADD COLUMN "promptPolicyVersion" TEXT,
  ADD COLUMN "analysedAt" TIMESTAMP(3),
  ADD COLUMN "previousExclusionReason" TEXT;
ALTER TABLE "CanonicalMarketEvent"
  ADD COLUMN "canonicalContractEventId" TEXT,
  ADD COLUMN "commercialEventType" TEXT,
  ADD COLUMN "eventStatus" TEXT,
  ADD COLUMN "buyerSector" TEXT,
  ADD COLUMN "aiRelevance" TEXT,
  ADD COLUMN "supportingText" TEXT,
  ADD COLUMN "readerVersion" TEXT;
CREATE UNIQUE INDEX "CanonicalMarketEvent_canonicalContractEventId_key" ON "CanonicalMarketEvent"("canonicalContractEventId");
CREATE INDEX "CanonicalMarketEvent_buyerSector_idx" ON "CanonicalMarketEvent"("buyerSector");
CREATE INDEX "CanonicalMarketEvent_commercialEventType_idx" ON "CanonicalMarketEvent"("commercialEventType");
ALTER TABLE "ContractDetails"
  ADD COLUMN "pricingModel" TEXT,
  ADD COLUMN "outcomePricing" BOOLEAN,
  ADD COLUMN "feeAtRisk" BOOLEAN,
  ADD COLUMN "consumptionModel" BOOLEAN,
  ADD COLUMN "renewalPeriodMonths" INTEGER,
  ADD COLUMN "expansionValueUsd" DOUBLE PRECISION,
  ADD COLUMN "acvUsd" DOUBLE PRECISION;
