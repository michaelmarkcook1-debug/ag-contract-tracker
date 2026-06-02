-- CreateTable
CREATE TABLE "SourceRegistryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'tier_2_secondary',
    "fetchMethod" TEXT NOT NULL DEFAULT 'rss',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastCrawledAt" DATETIME,
    "nextDueAt" DATETIME,
    "lastItemCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReviewAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewerNote" TEXT,
    "previousValue" TEXT,
    "newValue" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceRegistryItem_url_key" ON "SourceRegistryItem"("url");

-- CreateIndex
CREATE INDEX "SourceRegistryItem_isActive_idx" ON "SourceRegistryItem"("isActive");

-- CreateIndex
CREATE INDEX "SourceRegistryItem_nextDueAt_idx" ON "SourceRegistryItem"("nextDueAt");

-- CreateIndex
CREATE INDEX "ReviewAction_eventId_idx" ON "ReviewAction"("eventId");
