-- Distributor-side lyric availability (plain + synced) per track, captured from the DistroKid
-- album page. NOT NULL DEFAULT 'unknown' so every pre-existing row is backfilled to "unknown"
-- (we did not read its lyric state) rather than being read as "no lyrics".
ALTER TABLE "DistributorTrackOutcome"
  ADD COLUMN "plainLyricsStatus"  TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN "syncedLyricsStatus" TEXT NOT NULL DEFAULT 'unknown';
