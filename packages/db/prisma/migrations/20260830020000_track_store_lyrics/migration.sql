-- Per-store lyric verification (Serper) + LyricFind distribution signal on each track outcome.
-- storeLyricsPerStore is a JSON map { store -> 'shown' | 'not-shown' | 'unverifiable' } populated by
-- the rewritten lyrics-verification worker; the legacy global storeLyric* columns remain and are now
-- derived from this same Serper evidence for the existing missing-lyrics comparison.
ALTER TABLE "DistributorTrackOutcome"
  ADD COLUMN "storeLyricsPerStore" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "lyricfindDistributed" BOOLEAN,
  ADD COLUMN "lyricfindUrl" TEXT;
