-- Manual per-track status override the user applies from the store-health grid to curate the
-- missing-songs list. The automated store-presence verdict stands on its own; a mark is a human
-- annotation layered on top (bulk "mark as missing" / "mark as resolved" / clear). NULL = no mark.
-- mark: 'missing' | 'resolved'.
ALTER TABLE "DistributorTrackOutcome"
  ADD COLUMN "mark"     TEXT,
  ADD COLUMN "markNote" TEXT,
  ADD COLUMN "markedAt" TIMESTAMP(3);
