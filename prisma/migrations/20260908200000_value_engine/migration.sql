-- Value engine: labelled estimate provenance and the stated sizing facts it uses
ALTER TABLE "ContractDetails" ADD COLUMN "tcvEstimateMethod" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "tcvEstimateInputs" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "tcvEstimateExplanation" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "tcvEstimateVersion" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "agentCount" INTEGER;
ALTER TABLE "ContractDetails" ADD COLUMN "agentTarget" INTEGER;
ALTER TABLE "ContractDetails" ADD COLUMN "deliveryLocations" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "workType" TEXT;
ALTER TABLE "ContractDetails" ADD COLUMN "usersServed" INTEGER;
