-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "parentId" TEXT,
    "regions" TEXT NOT NULL DEFAULT '[]',
    "logoUrl" TEXT,
    "websiteUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Entity_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EntityAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    CONSTRAINT "EntityAlias_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceUrl" TEXT NOT NULL,
    "rawTextHash" TEXT,
    "sourceTitle" TEXT,
    "sourceName" TEXT,
    "sourceType" TEXT NOT NULL,
    "publicationDate" DATETIME,
    "retrievedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawText" TEXT,
    "extractedFamily" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "extractionConfidence" REAL NOT NULL DEFAULT 0,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "processingError" TEXT,
    "ingestionRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceEvent_ingestionRunId_fkey" FOREIGN KEY ("ingestionRunId") REFERENCES "IngestionRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanonicalMarketEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "family" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "canonicalTitle" TEXT NOT NULL,
    "announcementDate" DATETIME,
    "announcementDateBasis" TEXT NOT NULL DEFAULT 'unavailable',
    "effectiveDate" DATETIME,
    "geography" TEXT NOT NULL DEFAULT '[]',
    "industry" TEXT,
    "industryBasis" TEXT NOT NULL DEFAULT 'unavailable',
    "confidenceScore" REAL NOT NULL DEFAULT 0,
    "commercialRelevanceScore" REAL NOT NULL DEFAULT 0,
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "publicationStatus" TEXT NOT NULL DEFAULT 'published',
    "analystInsight" TEXT,
    "analystInsightConfidence" REAL,
    "originalArticleUrl" TEXT,
    "primaryEntityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CanonicalMarketEvent_primaryEntityId_fkey" FOREIGN KEY ("primaryEntityId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContractDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalEventId" TEXT NOT NULL,
    "vendorId" TEXT,
    "vendorRaw" TEXT,
    "vendorConfidence" REAL NOT NULL DEFAULT 0,
    "clientId" TEXT,
    "clientRaw" TEXT,
    "clientAnonymised" BOOLEAN NOT NULL DEFAULT false,
    "clientDescriptor" TEXT,
    "clientIndustry" TEXT,
    "clientConfidence" REAL NOT NULL DEFAULT 0,
    "contractEventType" TEXT,
    "previousVendorRaw" TEXT,
    "incumbentDisplaced" BOOLEAN,
    "contractStartDate" DATETIME,
    "contractStartDatePrecision" TEXT NOT NULL DEFAULT 'unknown',
    "contractEndDate" DATETIME,
    "contractEndDatePrecision" TEXT NOT NULL DEFAULT 'unknown',
    "contractLengthMonths" INTEGER,
    "contractLengthDescriptor" TEXT,
    "tcvCommittedUsd" REAL,
    "tcvCeilingUsd" REAL,
    "tcvFrameworkUsd" REAL,
    "tcvEstimateLowUsd" REAL,
    "tcvEstimateMidUsd" REAL,
    "tcvEstimateHighUsd" REAL,
    "tcvOriginalCurrency" TEXT,
    "tcvOriginalValue" REAL,
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
    CONSTRAINT "ContractDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ContractDetails_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContractDetails_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MaDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalEventId" TEXT NOT NULL,
    "maEventType" TEXT,
    "acquirerId" TEXT,
    "acquirerRaw" TEXT,
    "targetId" TEXT,
    "targetRaw" TEXT,
    "dealValueUsd" REAL,
    "dealValueBasis" TEXT NOT NULL DEFAULT 'undisclosed',
    "stakePercent" REAL,
    "statusAtAnnouncement" TEXT NOT NULL DEFAULT 'announced',
    "rationale" TEXT,
    CONSTRAINT "MaDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MaDetails_acquirerId_fkey" FOREIGN KEY ("acquirerId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MaDetails_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PartnershipDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalEventId" TEXT NOT NULL,
    "partnershipType" TEXT,
    "entityAId" TEXT,
    "entityARaw" TEXT,
    "entityBId" TEXT,
    "entityBRaw" TEXT,
    "scopeSummary" TEXT,
    "platformFocus" TEXT,
    CONSTRAINT "PartnershipDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PartnershipDetails_entityAId_fkey" FOREIGN KEY ("entityAId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PartnershipDetails_entityBId_fkey" FOREIGN KEY ("entityBId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrgChangeDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    CONSTRAINT "OrgChangeDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrgChangeDetails_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OfferingDetails" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalEventId" TEXT NOT NULL,
    "offeringType" TEXT,
    "vendorRaw" TEXT,
    "offeringName" TEXT,
    "scopeSummary" TEXT,
    "targetMarket" TEXT,
    "platformsUsed" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "OfferingDetails_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DedupDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventAId" TEXT NOT NULL,
    "eventBId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 0,
    "mergeRecommended" BOOLEAN NOT NULL DEFAULT false,
    "linkRecommended" BOOLEAN NOT NULL DEFAULT false,
    "reasonCodes" TEXT NOT NULL DEFAULT '[]',
    "riskFlags" TEXT NOT NULL DEFAULT '[]',
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT true,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DedupDecision_eventAId_fkey" FOREIGN KEY ("eventAId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DedupDecision_eventBId_fkey" FOREIGN KEY ("eventBId") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runType" TEXT NOT NULL,
    "sourceFilter" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "articlesFound" INTEGER NOT NULL DEFAULT 0,
    "articlesDuped" INTEGER NOT NULL DEFAULT 0,
    "eventsExtracted" INTEGER NOT NULL DEFAULT 0,
    "eventsPublished" INTEGER NOT NULL DEFAULT 0,
    "eventsQueued" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "_CanonicalMarketEventToSourceEvent" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_CanonicalMarketEventToSourceEvent_A_fkey" FOREIGN KEY ("A") REFERENCES "CanonicalMarketEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_CanonicalMarketEventToSourceEvent_B_fkey" FOREIGN KEY ("B") REFERENCES "SourceEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
CREATE UNIQUE INDEX "_CanonicalMarketEventToSourceEvent_AB_unique" ON "_CanonicalMarketEventToSourceEvent"("A", "B");

-- CreateIndex
CREATE INDEX "_CanonicalMarketEventToSourceEvent_B_index" ON "_CanonicalMarketEventToSourceEvent"("B");
