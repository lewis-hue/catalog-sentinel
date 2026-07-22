-- A numeric expected track total is not necessarily authoritative. Older snapshots derived it
-- from the extracted tracks themselves, so 42/42 could falsely imply complete track coverage.
-- Default false keeps existing rows and rolling-deploy payloads conservative.
ALTER TABLE "DistributorExtractionSnapshot"
ADD COLUMN "expectedTracksKnown" BOOLEAN NOT NULL DEFAULT false;
