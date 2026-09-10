-- Confidence provenance (AI Delivery Mandate §6). Additive only.
-- A hard-coded confidenceScore of 1.0 told the publication gate "certain" while
-- meaning "nobody measured this". Recording the basis is what stops an asserted
-- value being read downstream as if it were measured.
ALTER TABLE "CanonicalMarketEvent" ADD COLUMN "confidenceBasis" TEXT;
CREATE INDEX "CanonicalMarketEvent_confidenceBasis_idx" ON "CanonicalMarketEvent"("confidenceBasis");
