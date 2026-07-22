-- Durable in-flight DistroKid checkpoints. Redis remains a hot projection only: every recovery
-- fact needed to resume a 1,000+ release read is tenant/connection scoped in PostgreSQL.

CREATE TABLE "DistroKidSnapshotCheckpoint" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "indexVersion" BIGINT NOT NULL DEFAULT 0,
    "outcomesVersion" BIGINT NOT NULL DEFAULT 0,
    "progressVersion" BIGINT NOT NULL DEFAULT 0,
    "chunksVersion" BIGINT NOT NULL DEFAULT 0,
    "plansVersion" BIGINT NOT NULL DEFAULT 0,
    "terminalVersion" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DistroKidSnapshotCheckpoint_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId")
);

CREATE UNIQUE INDEX "DistroKidSnapshotCheckpoint_snapshotId_key" ON "DistroKidSnapshotCheckpoint"("snapshotId");
CREATE INDEX "DistroKidSnapshotCheckpoint_tenantId_connectionId_idx" ON "DistroKidSnapshotCheckpoint"("tenantId", "connectionId");

CREATE TABLE "DistroKidCheckpointIndex" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "dashboardUrl" TEXT NOT NULL,
    "title" TEXT,
    "artist" TEXT,
    CONSTRAINT "DistroKidCheckpointIndex_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId", "releaseId"),
    CONSTRAINT "DistroKidCheckpointIndex_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointIndex_ordinal_check" CHECK ("ordinal" >= 0)
);
CREATE UNIQUE INDEX "DistroKidCheckpointIndex_scope_ordinal_key" ON "DistroKidCheckpointIndex"("tenantId", "connectionId", "snapshotId", "ordinal");

CREATE TABLE "DistroKidCheckpointOutcome" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DistroKidCheckpointOutcome_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId", "releaseId"),
    CONSTRAINT "DistroKidCheckpointOutcome_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointOutcome_object_check" CHECK (jsonb_typeof("outcome") = 'object')
);

CREATE TABLE "DistroKidCheckpointProgress" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expectedReleases" INTEGER NOT NULL,
    "completedReleases" INTEGER NOT NULL,
    "failedReleases" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "completedChunks" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "DistroKidCheckpointProgress_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId"),
    CONSTRAINT "DistroKidCheckpointProgress_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointProgress_counts_check" CHECK ("expectedReleases" >= 0 AND "completedReleases" >= 0 AND "failedReleases" >= 0 AND "chunkCount" >= 0)
);

CREATE TABLE "DistroKidCheckpointChunk" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "pass" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DistroKidCheckpointChunk_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId", "pass", "chunkIndex"),
    CONSTRAINT "DistroKidCheckpointChunk_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointChunk_position_check" CHECK ("pass" > 0 AND "chunkIndex" >= 0)
);
CREATE INDEX "DistroKidCheckpointChunk_scope_pass_idx" ON "DistroKidCheckpointChunk"("tenantId", "connectionId", "snapshotId", "pass");

CREATE TABLE "DistroKidCheckpointPassPlanChunk" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "pass" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "releaseIds" TEXT[] NOT NULL,
    CONSTRAINT "DistroKidCheckpointPassPlanChunk_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId", "pass", "chunkIndex"),
    CONSTRAINT "DistroKidCheckpointPassPlanChunk_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointPassPlanChunk_position_check" CHECK ("pass" > 0 AND "chunkIndex" >= 0),
    CONSTRAINT "DistroKidCheckpointPassPlanChunk_nonempty_ids_check" CHECK (array_position("releaseIds", '') IS NULL)
);
CREATE INDEX "DistroKidCheckpointPassPlanChunk_scope_pass_idx" ON "DistroKidCheckpointPassPlanChunk"("tenantId", "connectionId", "snapshotId", "pass");

CREATE TABLE "DistroKidCheckpointTerminal" (
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "tombstone" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DistroKidCheckpointTerminal_pkey" PRIMARY KEY ("tenantId", "connectionId", "snapshotId"),
    CONSTRAINT "DistroKidCheckpointTerminal_checkpoint_fkey" FOREIGN KEY ("tenantId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("tenantId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DistroKidCheckpointTerminal_object_check" CHECK (jsonb_typeof("tombstone") = 'object')
);
