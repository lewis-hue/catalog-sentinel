ALTER TABLE "DistroKidCheckpointIndex"
  ADD COLUMN "expectedTrackCount" INTEGER;

ALTER TABLE "DistroKidCheckpointIndex"
  ADD CONSTRAINT "DistroKidCheckpointIndex_expected_track_count_check"
  CHECK ("expectedTrackCount" IS NULL OR "expectedTrackCount" > 0);
