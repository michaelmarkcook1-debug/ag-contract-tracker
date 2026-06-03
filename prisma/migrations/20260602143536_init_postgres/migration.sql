-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "parentId" TEXT,
    "regions" TEXT NOT NULL DEFAULT '[]',
    "logoUrl" TEXT,
    "websiteUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityAlias" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,

    CONSTRAINT "EntityAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEvent" (
    "id" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "rawTextHash" TEXT,
    "sourceTitle" TEXT,
    "sourceName" TEXT,
    "sourceType" TEXT NOT NULL,
    "publicationDate" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawText" TEXT,
    "extractedFamily" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "extractionConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "processingError" TEXT,
    "ingestionRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CanonicalMarketEvent" (
    "id" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "canonicalTitle" TEXT NOT NULL,
    "announcementDate" TIMESTAMP(3),
    "announcementDateBasis" TEXT NOT NULL DEFAULT 'unavailable',
    "effectiveDate" TIMESTAMP(3),
    "geography" TEXT NOT NULL DEFAULT '[]',
    "industry" TEXT,
    "industryBasis" TEXT NOT NULL DEFAULT 'unavailable',
    "confidenceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commercialRelevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "publicationStatus" TEXT NOT NULL DEFAULT 'published',
    "analystInsight" TEXT,
    "analystInsightConfidence" DOUBLE PRECISION,
    "originalArticleUrl" TEXT,
    "primaryEntityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanonicalMarketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDetails" (
    "id" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "vendorId" TEXT,
    "vendorRaw" TEXT,
    "vendorConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "clientId" TEXT,
    "clientRaw" TEXT,
    "clientAnonymised" BOOLEAN NOT NULL DEFAULT false,
    "clientDescriptor" TEXT,
    "clientIndustry" TEXT,
    "clientConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "contractEventType" TEXT,
    "previousVendorRaw" TEXT,
    "incumbentDisplaced" BOOLEAN,
    "contractStartDate" TIMESTAMP(3),
    "contractStartDatePrecision" TEXT NOT NULL DEFAULT 'unknown',
    "contractEndDate" TIMESTAMP(3),
    "contractEndDatePrecision" TEXT NOT NULL DEFAULT 'unknown',
    "contractLengthMonths" INTEGER,
    "contractLengthDescriptor" TEXT,
    "tcvCommittedUsd" DOUBLE PRECISION,
    "tcvCeilingUsd" DOUBLE PRECISION,
    "tcvFrameworkUsd" DOUBLE PRECISION,
    "tcvEstimateLowUsd" DOUBLE PRECISION,
    "tcvEstimateMidUsd" DOUBLE PRECISION,
    "tcvEstimateHighUsd" DOUBLE PRECISION,
    "tcvOriginalCurrency" TEXT,
    "tcvOriginalValue" DOUBLE PRECISION,
    "tcvBasis" TEXT NOT NULL DEFAULT 'undisclosed',
    "tcvIsEstimate" BOOLEAN NOT NULL DEFAULT false,
    "tcvConfidence" TEXT NOT NULL DEFAULT 'do_not_estimate',
    "primaryMacroServiceLine" TEXT,
    "primaryMicroServiceLine" TEXT,
    "secondaryMacroServiceLines" TEXT NOT NULL DEFAULT '[]',
    "secondaryMicroServiceLines" TEXT NOT NULL DEFAULT '[]',
    "scopeSummary" TEXT,
    "platformsUsed" TEXT NOT NULL DEFAULT '[]',
    "signingLocation" TEXT,
    "clientServiceCoverageLocation" TEXT NOT NULL DEFAULT '[]',
    "vendorDeliveryCentreLocation" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "ContractDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaDetails" (
    "id" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "maEventType" TEXT,
    "acquirerId" TEXT,
    "acquirerRaw" TEXT,
    "targetId" TEXT,
    "targetRaw" TEXT,
    "dealValueUsd" DOUBLE PRECISION,
    "dealValueBasis" TEXT NOT NULL DEFAULT 'undisclosed',
    "stakePercent" DOUBLE PRECISION,
    "statusAtAnnouncement" TEXT NOT NULL DEFAULT 'announced',
    "rationale" TEXT,

    CONSTRAINT "MaDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnershipDetails" (
    "id" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "partnershipType" TEXT,
    "entityAId" TEXT,
    "entityARaw" TEXT,
    "entityBId" TEXT,
    "entityBRaw" TEXT,
    "scopeSummary" TEXT,
    "platformFocus" TEXT,

    CONSTRAINT "PartnershipDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgChangeDetails" (
    "id" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "orgEventType" TEXT,
    "entityId" TEXT,
    "personName" TEXT,
    "roleName" TEXT,
    "previousRole" TEXT,
    "locationCity" TEXT,
    "locationCountry" TEXT,
    "headcount" INTEGER,
    "rationale" TEXT,

    CONSTRAINT "OrgChangeDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferingDetails" (
    "id" TEXT NOT NULL,
    "canonicalEventId" TEXT NOT NULL,
    "offeringType" TEXT,
    "vendorRaw" TEXT,
    "offeringName" TEXT,
    "scopeSummary" TEXT,
    "targetMarket" TEXT,
    "platformsUsed" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "OfferingDetails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DedupDecision" (
    "id" TEXT NOT NULL,
    "eventAId" TEXT NOT NULL,
    "eventBId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mergeRecommended" BOOLEAN NOT NULL DEFAULT false,
    "linkRecommended" BOOLEAN NOT NULL DEFAULT false,
    "reasonCodes" TEXT NOT NULL DEFAULT '[]',
    "riskFlags" TEXT NOT NULL DEFAULT '[]',
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DedupDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceRegistryItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'tier_2_secondary',
    "fetchMethod" TEXT NOT NULL DEFAULT 'rss',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCrawledAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "lastItemCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceRegistryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewAction" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewerNote" TEXT,
    "previousValue" TEXT,
    "newValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL,
    "runType" TEXT NOT NULL,
    "sourceFilter" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "articlesFound" INTEGER NOT NULL DEFAULT 0,
    "articlesDuped" INTEGER NOT NULL DEFAULT 0,
    "eventsExtracted" INTEGER NOT NULL DEFAULT 0,
    "eventsPublished" INTEGER NOT NULL DEFAULT 0,
    "eventsQueued" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT NOT NULL DEFAULT '[]',

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CanonicalMarketEventToSourceEvent" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CanonicalMarketEventToSourceEvent_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_canonicalName_key" ON "Entity"("canonicalName");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_slug_key" ON "Entity"("slug");

-- CreateIndex
CREATE INDEX "EntityAlias_alias_idx" ON "EntityAlias"("alias");

-- CreateIndex
CREATE UNIQUE INDEX "EntityAlias_entityId_alias_key" ON "EntityAlias"("entityId", "alias");

-- CreateIndex
CREATE UNIQUE INDEX "SourceEvent_sourceUrl_key" ON "SourceEvent"("sourceUrl");

-- CreateIndex
CREATE INDEX "SourceEvent_processingStatus_idx" ON "SourceEvent"("processingStatus");

-- CreateIndex
CREATE INDEX "SourceEvent_publicationDate_idx" ON "SourceEvent"("publicationDate");

-- CreateIndex
CREATE INDEX "CanonicalMarketEvent_family_idx" ON "CanonicalMarketEvent"("family");

-- CreateIndex
CREATE INDEX "CanonicalMarketEvent_publicationStatus_idx" ON "CanonicalMarketEvent"("publicationStatus");

-- CreateIndex
CREATE INDEX "CanonicalMarketEvent_announcementDate_idx" ON "CanonicalMarketEvent"("announcementDate");

-- CreateIndex
CREATE INDEX "CanonicalMarketEvent_primaryEntityId_idx" ON "CanonicalMarketEvent"("primaryEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDetails_canonicalEventId_key" ON "ContractDetails"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "MaDetails_canonicalEventId_key" ON "MaDetails"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "PartnershipDetails_canonicalEventId_key" ON "PartnershipDetails"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgChangeDetails_canonicalEventId_key" ON "OrgChangeDetails"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OfferingDetails_canonicalEventId_key" ON "OfferingDetails"("canonicalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "DedupDecision_eventAId_eventBId_key" ON "DedupDecision"("eventAId", "eventBId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceRegistryItem_url_key" ON "SourceRegistryItem"("url");

-- CreateIndex
CREATE INDEX "SourceRegistryItem_isActive_idx" ON "SourceRegistryItem"("isActive");

-- CreateIndex
CREATE INDEX "SourceRegistryItem_nextDueAt_idx" ON "SourceRegistryItem"("nextDueAt");

-- CreateIndex
CREATE INDEX "ReviewAction_eventId_idx" ON "ReviewAction"("eventId");

-- CreateIndex
CREATE INDEX "_CanonicalMarketEventToSourceEvent_B_index" ON "_CanonicalMarketEventToSourceEvent"("B");

-- AddForeignKey
ALTER TABLE "Entity" ADD CONSTRAINT "Entity_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityAlias" ADD CONSTRAINT "EntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEvent" ADD CONSTRAINT "SourceEvent_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "IngestionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalMarketEvent" ADD CONSTRAINT "CanonicalMarketEvent_primaryEntityId_fkey" FOREIGN KEY ("primaryEntityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDetails" ADD CONSTRAINT "ContractDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDetails" ADD CONSTRAINT "ContractDetails_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDetails" ADD CONSTRAINT "ContractDetails_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaDetails" ADD CONSTRAINT "MaDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaDetails" ADD CONSTRAINT "MaDetails_acquirerId_fkey" FOREIGN KEY ("acquirerId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaDetails" ADD CONSTRAINT "MaDetails_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnershipDetails" ADD CONSTRAINT "PartnershipDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnershipDetails" ADD CONSTRAINT "PartnershipDetails_entityAId_fkey" FOREIGN KEY ("entityAId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnershipDetails" ADD CONSTRAINT "PartnershipDetails_entityBId_fkey" FOREIGN KEY ("entityBId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgChangeDetails" ADD CONSTRAINT "OrgChangeDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgChangeDetails" ADD CONSTRAINT "OrgChangeDetails_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferingDetails" ADD CONSTRAINT "OfferingDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DedupDecision" ADD CONSTRAINT "DedupDecision_eventAId_fkey" FOREIGN KEY ("eventAId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DedupDecision" ADD CONSTRAINT "DedupDecision_eventBId_fkey" FOREIGN KEY ("eventBId") REFERENCES "CanonicalMarketEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CanonicalMarketEventToSourceEvent" ADD CONSTRAINT "_CanonicalMarketEventToSourceEvent_A_fkey" FOREIGN KEY ("A") REFERENCES "CanonicalMarketEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CanonicalMarketEventToSourceEvent" ADD CONSTRAINT "_CanonicalMarketEventToSourceEvent_B_fkey" FOREIGN KEY ("B") REFERENCES "SourceEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
