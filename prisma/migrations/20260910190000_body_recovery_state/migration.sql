-- Tier 2 article recovery state (AI Delivery Mandate §4, §5). Additive only.
-- Redirect resolution and body fetch are expensive and rate-limited; without
-- persisted state every run re-attempts URLs that already failed permanently.
ALTER TABLE "SourceEvent"
  ADD COLUMN "redirectState" TEXT,      -- RESOLVED | ALREADY_RESOLVED | FAILED | BLOCKED | INVALID | NOT_APPLICABLE
  ADD COLUMN "redirectAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "bodyState" TEXT,          -- FULL_TEXT | PARTIAL_ARTICLE | SNIPPET_ONLY | UNREADABLE | FETCH_FAILED
  ADD COLUMN "bodyAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "bodyAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "bodyChars" INTEGER;
CREATE INDEX "SourceEvent_redirectState_idx" ON "SourceEvent"("redirectState");
CREATE INDEX "SourceEvent_bodyState_idx" ON "SourceEvent"("bodyState");
-- Run finalisation (§14): a run whose execution dies must not stay RUNNING.
ALTER TABLE "IngestionRun"
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "endedReason" TEXT;
CREATE INDEX "IngestionRun_status_heartbeatAt_idx" ON "IngestionRun"("status", "heartbeatAt");
