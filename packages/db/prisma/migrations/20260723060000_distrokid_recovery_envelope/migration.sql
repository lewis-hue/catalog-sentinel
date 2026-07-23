-- Keep the minimum encrypted authority needed to reconstruct a lost BullMQ DistroKid job after
-- complete Redis loss. These columns live on the already tenant/connection-bound checkpoint root,
-- so a snapshot id can never be rebound to another principal. All recovery columns are either
-- present together or absent together; terminal cleanup clears them atomically.
ALTER TABLE "DistroKidSnapshotCheckpoint"
  ADD COLUMN "recoveryArtists" JSONB,
  ADD COLUMN "recoveryConsentId" TEXT,
  ADD COLUMN "recoveryArtistWorkspaceId" TEXT,
  ADD COLUMN "recoverySteelSessionIdEncrypted" TEXT,
  ADD COLUMN "recoverySessionExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "recoveryDeadlineAt" TIMESTAMPTZ(3),
  ADD COLUMN "recoverySchemaVersion" INTEGER;

ALTER TABLE "DistroKidSnapshotCheckpoint"
  ADD CONSTRAINT "DistroKidSnapshotCheckpoint_recovery_all_or_none_check" CHECK (
    (
      "recoveryArtists" IS NULL
      AND "recoveryConsentId" IS NULL
      AND "recoveryArtistWorkspaceId" IS NULL
      AND "recoverySteelSessionIdEncrypted" IS NULL
      AND "recoverySessionExpiresAt" IS NULL
      AND "recoveryDeadlineAt" IS NULL
      AND "recoverySchemaVersion" IS NULL
    ) OR (
      -- PostgreSQL CHECK constraints accept UNKNOWN, so explicitly require every populated
      -- member to be non-null before validating its value.
      "recoveryArtists" IS NOT NULL
      AND "recoveryConsentId" IS NOT NULL
      AND "recoveryArtistWorkspaceId" IS NOT NULL
      AND "recoverySteelSessionIdEncrypted" IS NOT NULL
      AND "recoverySessionExpiresAt" IS NOT NULL
      AND "recoveryDeadlineAt" IS NOT NULL
      AND "recoverySchemaVersion" IS NOT NULL
      AND jsonb_typeof("recoveryArtists") = 'array'
      AND jsonb_array_length("recoveryArtists") > 0
      AND NOT jsonb_path_exists("recoveryArtists", '$[*] ? (@ == "")')
      AND "recoveryConsentId" <> ''
      AND "recoveryArtistWorkspaceId" <> ''
      -- EnvelopeEncryptor values are versioned. A provider id or CDP URL cannot satisfy this.
      AND "recoverySteelSessionIdEncrypted" ~ '^v[12]\.'
      AND octet_length("recoverySteelSessionIdEncrypted") <= 16384
      -- Preserve the same immutable cleanup reserve enforced at both producer and repository.
      AND "recoveryDeadlineAt" <= "recoverySessionExpiresAt" - INTERVAL '60 seconds'
      AND "recoverySchemaVersion" > 0
    )
  );

CREATE INDEX "DistroKidSnapshotCheckpoint_recoveryDeadlineAt_idx"
  ON "DistroKidSnapshotCheckpoint"("recoveryDeadlineAt")
  WHERE "recoveryDeadlineAt" IS NOT NULL;

-- The API may establish immutable recovery authority before it submits to Redis, but it cannot
-- read or mutate extraction outcomes/progress. The worker retains its existing table capability.
GRANT SELECT (
  "tenantId", "connectionId", "snapshotId", "distributor",
  "recoveryArtists", "recoveryConsentId", "recoveryArtistWorkspaceId",
  "recoverySteelSessionIdEncrypted", "recoverySessionExpiresAt",
  "recoveryDeadlineAt", "recoverySchemaVersion"
) ON "DistroKidSnapshotCheckpoint" TO sentinel_api_runtime;
GRANT INSERT (
  "tenantId", "connectionId", "snapshotId", "distributor",
  "recoveryArtists", "recoveryConsentId", "recoveryArtistWorkspaceId",
  "recoverySteelSessionIdEncrypted", "recoverySessionExpiresAt",
  "recoveryDeadlineAt", "recoverySchemaVersion"
) ON "DistroKidSnapshotCheckpoint" TO sentinel_api_runtime;
GRANT UPDATE (
  "recoveryArtists", "recoveryConsentId", "recoveryArtistWorkspaceId",
  "recoverySteelSessionIdEncrypted", "recoverySessionExpiresAt",
  "recoveryDeadlineAt", "recoverySchemaVersion"
) ON "DistroKidSnapshotCheckpoint" TO sentinel_api_runtime;
-- Existence-only terminal inspection prevents a delayed API confirmation from repopulating a
-- released Steel authority. The tombstone payload itself remains worker-only.
GRANT SELECT ("tenantId", "connectionId", "snapshotId")
  ON "DistroKidCheckpointTerminal" TO sentinel_api_runtime;
