-- Store-side lyric availability per track, verified against the stores' lyric provider (LRCLIB).
-- Kept alongside the DistroKid-side lyric status (plain/synced) so a single track row carries BOTH
-- facts — what DistroKid submitted vs. what the stores actually expose — which is exactly the
-- comparison the Missing Lyrics module makes. Living here (not on the in-memory search record)
-- means the store-lyrics check writes a different table than the store-PRESENCE deep scan, so the
-- two runs never contend for the same record and stay fully independent.
--
-- storeLyricStatus: found | not-found | unverifiable | unknown   ('unknown' = not yet checked)
-- NOT NULL DEFAULT so every pre-existing row backfills to "unknown" rather than reading as "missing".
ALTER TABLE "DistributorTrackOutcome"
  ADD COLUMN "storeLyricStatus" TEXT    NOT NULL DEFAULT 'unknown',
  ADD COLUMN "storeHasPlain"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storeHasSynced"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "storeLyricSource" TEXT,
  ADD COLUMN "storeLyricCheckedAt" TIMESTAMP(3);

-- Snapshot-level progress for the store-lyrics check, so the run's status/progress lives on the
-- extraction snapshot (Postgres) rather than the in-memory search record. The store-presence deep
-- scan writes the search record; this check writes only Postgres — two independent runs, no shared
-- state. storeLyricsStatus: idle | queued | running | done | error.
ALTER TABLE "DistributorExtractionSnapshot"
  ADD COLUMN "storeLyricsStatus"    TEXT NOT NULL DEFAULT 'idle',
  ADD COLUMN "storeLyricsChecked"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "storeLyricsTotal"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "storeLyricsError"     TEXT,
  ADD COLUMN "storeLyricsCheckedAt" TIMESTAMP(3);
