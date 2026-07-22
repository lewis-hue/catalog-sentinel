-- Endpoint profile: give the candidate score its own column.
--
-- The repository was writing the candidate score into `validationCount` and reading it back out
-- of the same field, so neither number meant what its name said: you could not tell "ranked 20 by
-- discovery" from "validated 20 times". Two facts, one column, both untrustworthy.
--
-- Existing rows carry the overloaded value, so copy it across rather than resetting to 0 — the
-- score is the better reading of what was actually stored there.
ALTER TABLE "DistributorEndpointProfile" ADD COLUMN IF NOT EXISTS "candidateScore" INTEGER NOT NULL DEFAULT 0;
UPDATE "DistributorEndpointProfile" SET "candidateScore" = "validationCount" WHERE "candidateScore" = 0;
