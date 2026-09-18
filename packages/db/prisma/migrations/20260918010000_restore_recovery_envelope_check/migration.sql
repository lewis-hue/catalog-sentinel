-- Restore the all-or-none recovery-envelope CHECK constraint on DistroKidSnapshotCheckpoint.
--
-- 20260723060000_distrokid_recovery_envelope added
-- "DistroKidSnapshotCheckpoint_recovery_all_or_none_check", but it referenced the column
-- "recoveryArtistWorkspaceId". 20260830000000_per_user_isolation then did
--   DROP COLUMN "recoveryArtistWorkspaceId", ADD COLUMN "recoveryUserId"
-- and PostgreSQL silently drops any CHECK constraint that depends on a dropped column -- so the
-- guarantee was lost, while the renamed "recoveryUserId" column carried none of it (the write path
-- in distrokid-recovery.ts never populates it: prepare() writes the six columns below and clear()
-- nulls the same six atomically; "recoveryUserId" is a vestigial leftover of the rename).
--
-- Without this database backstop a partially populated recovery envelope (e.g. a consent id with no
-- encrypted Steel handle) commits at the database boundary -- exactly what the durable-recovery
-- integration test asserts must be rejected with a check_violation (23514). Re-add the identical
-- guarantee over the six columns the application actually writes, excluding the vestigial
-- "recoveryUserId".
ALTER TABLE "DistroKidSnapshotCheckpoint"
  ADD CONSTRAINT "DistroKidSnapshotCheckpoint_recovery_all_or_none_check" CHECK (
    (
      "recoveryArtists" IS NULL
      AND "recoveryConsentId" IS NULL
      AND "recoverySteelSessionIdEncrypted" IS NULL
      AND "recoverySessionExpiresAt" IS NULL
      AND "recoveryDeadlineAt" IS NULL
      AND "recoverySchemaVersion" IS NULL
    ) OR (
      -- PostgreSQL CHECK constraints accept UNKNOWN, so explicitly require every populated
      -- member to be non-null before validating its value.
      "recoveryArtists" IS NOT NULL
      AND "recoveryConsentId" IS NOT NULL
      AND "recoverySteelSessionIdEncrypted" IS NOT NULL
      AND "recoverySessionExpiresAt" IS NOT NULL
      AND "recoveryDeadlineAt" IS NOT NULL
      AND "recoverySchemaVersion" IS NOT NULL
      AND jsonb_typeof("recoveryArtists") = 'array'
      AND jsonb_array_length("recoveryArtists") > 0
      AND NOT jsonb_path_exists("recoveryArtists", '$[*] ? (@ == "")')
      AND "recoveryConsentId" <> ''
      -- EnvelopeEncryptor values are versioned. A provider id or CDP URL cannot satisfy this.
      AND "recoverySteelSessionIdEncrypted" ~ '^v[12]\.'
      AND octet_length("recoverySteelSessionIdEncrypted") <= 16384
      -- Preserve the same immutable cleanup reserve enforced at both producer and repository.
      AND "recoveryDeadlineAt" <= "recoverySessionExpiresAt" - INTERVAL '60 seconds'
      AND "recoverySchemaVersion" > 0
    )
  );
