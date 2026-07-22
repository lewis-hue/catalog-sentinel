-- Network-first extraction: durable system of record.
--
-- Redis holds operational checkpoints so a crashed catalogue read can resume. It is NOT the
-- catalog system of record and may be flushed at any time — these tables are what survive.

-- ---------------------------------------------------------------------------
-- 1. Correct the identifier model on the existing tables.
--
--    UPC identifies a RELEASE. Carrying it on the track let a track-level query report a
--    release-level fact, and made a per-track "UPC coverage" number meaningful-looking but wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE "DistributorTrack" DROP COLUMN IF EXISTS "upc";

-- ---------------------------------------------------------------------------
-- 2. Drop raw payload columns.
--
--    Policy is normalized, allowlisted fields only. A raw distributor response can contain
--    fields we never reviewed (profile, billing, account state), so a raw-payload column turns a
--    catalog table into an uncontrolled copy of the user's account. Nothing reads these.
-- ---------------------------------------------------------------------------
ALTER TABLE "DistributorRelease" DROP COLUMN IF EXISTS "rawSourceJson";
ALTER TABLE "DistributorTrack" DROP COLUMN IF EXISTS "rawSourceJson";

-- ---------------------------------------------------------------------------
-- 3. Extraction snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE "DistributorExtractionSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'NETWORK_FIRST',
    "expectedReleases" INTEGER NOT NULL DEFAULT 0,
    "completedReleases" INTEGER NOT NULL DEFAULT 0,
    "failedReleases" INTEGER NOT NULL DEFAULT 0,
    "expectedTracks" INTEGER NOT NULL DEFAULT 0,
    "extractedTracks" INTEGER NOT NULL DEFAULT 0,
    "releasesWithUpc" INTEGER NOT NULL DEFAULT 0,
    "releasesWithArtwork" INTEGER NOT NULL DEFAULT 0,
    "tracksWithIsrc" INTEGER NOT NULL DEFAULT 0,
    "releasesUpcAbsentAtSource" INTEGER NOT NULL DEFAULT 0,
    "tracksIsrcAbsentAtSource" INTEGER NOT NULL DEFAULT 0,
    "releasesUpcNotCaptured" INTEGER NOT NULL DEFAULT 0,
    "tracksIsrcNotCaptured" INTEGER NOT NULL DEFAULT 0,
    "unresolvedReleaseIds" TEXT[],
    "failureReasons" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "DistributorExtractionSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DistributorExtractionSnapshot_tenantId_snapshotId_key" ON "DistributorExtractionSnapshot"("tenantId", "snapshotId");
CREATE INDEX "DistributorExtractionSnapshot_tenantId_idx" ON "DistributorExtractionSnapshot"("tenantId");
CREATE INDEX "DistributorExtractionSnapshot_tenantId_connectionId_idx" ON "DistributorExtractionSnapshot"("tenantId", "connectionId");
CREATE INDEX "DistributorExtractionSnapshot_tenantId_distributor_status_idx" ON "DistributorExtractionSnapshot"("tenantId", "distributor", "status");

-- ---------------------------------------------------------------------------
-- 4. Release outcomes. Every indexed release gets exactly one row; a missing row is what makes
--    a snapshot PARTIAL_RETRYABLE rather than silently short.
-- ---------------------------------------------------------------------------
CREATE TABLE "DistributorReleaseOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extractionSnapshotId" TEXT NOT NULL,
    "distributorReleaseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "title" TEXT,
    "primaryArtist" TEXT,
    "label" TEXT,
    "releaseDate" TEXT,
    "uploadDate" TEXT,
    "artworkUrl" TEXT,
    "upc" TEXT,
    "upcStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "artworkStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "parserVersion" TEXT,
    "endpointFingerprint" TEXT,
    "capturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributorReleaseOutcome_pkey" PRIMARY KEY ("id")
);

-- Finalization is idempotent: a retried finalize upserts on this key rather than duplicating.
CREATE UNIQUE INDEX "DistributorReleaseOutcome_extractionSnapshotId_distributorRe_key" ON "DistributorReleaseOutcome"("extractionSnapshotId", "distributorReleaseId");
CREATE INDEX "DistributorReleaseOutcome_tenantId_idx" ON "DistributorReleaseOutcome"("tenantId");
CREATE INDEX "DistributorReleaseOutcome_extractionSnapshotId_kind_idx" ON "DistributorReleaseOutcome"("extractionSnapshotId", "kind");

ALTER TABLE "DistributorReleaseOutcome" ADD CONSTRAINT "DistributorReleaseOutcome_extractionSnapshotId_fkey" FOREIGN KEY ("extractionSnapshotId") REFERENCES "DistributorExtractionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Track outcomes. ISRC + why-absent live here; UPC deliberately does not.
-- ---------------------------------------------------------------------------
CREATE TABLE "DistributorTrackOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "releaseOutcomeId" TEXT NOT NULL,
    "distributorTrackId" TEXT,
    "trackIndex" INTEGER NOT NULL,
    "title" TEXT,
    "primaryArtist" TEXT,
    "featuredArtists" TEXT[],
    "trackNumber" INTEGER,
    "durationMs" INTEGER,
    "isExplicit" BOOLEAN,
    "isrc" TEXT,
    "isrcStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "parserVersion" TEXT,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "DistributorTrackOutcome_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DistributorTrackOutcome_releaseOutcomeId_trackIndex_key" ON "DistributorTrackOutcome"("releaseOutcomeId", "trackIndex");
CREATE INDEX "DistributorTrackOutcome_tenantId_idx" ON "DistributorTrackOutcome"("tenantId");
CREATE INDEX "DistributorTrackOutcome_isrc_idx" ON "DistributorTrackOutcome"("isrc");

ALTER TABLE "DistributorTrackOutcome" ADD CONSTRAINT "DistributorTrackOutcome_releaseOutcomeId_fkey" FOREIGN KEY ("releaseOutcomeId") REFERENCES "DistributorReleaseOutcome"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Endpoint profiles + candidates.
--
--    Previously process-local, so a restart forgot every promotion and two API replicas could
--    disagree about which endpoint was ACTIVE. Sanitized shape only: no query VALUES, cookies,
--    headers, tokens or response bodies are storable in this model.
-- ---------------------------------------------------------------------------
CREATE TABLE "DistributorEndpointProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "method" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "maskedPath" TEXT NOT NULL,
    "queryKeys" TEXT[],
    "operationName" TEXT,
    "schemaHash" TEXT,
    "schemaKeys" TEXT[],
    "parserVersion" TEXT,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "validationCount" INTEGER NOT NULL DEFAULT 0,
    "schemaDriftCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "promotedAt" TIMESTAMP(3),
    "degradedAt" TIMESTAMP(3),

    CONSTRAINT "DistributorEndpointProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DistributorEndpointProfile_tenantId_distributor_fingerprint_key" ON "DistributorEndpointProfile"("tenantId", "distributor", "fingerprint");
CREATE INDEX "DistributorEndpointProfile_tenantId_distributor_status_idx" ON "DistributorEndpointProfile"("tenantId", "distributor", "status");

CREATE TABLE "DistributorEndpointCandidate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "maskedPath" TEXT NOT NULL,
    "queryKeys" TEXT[],
    "operationName" TEXT,
    "schemaKeys" TEXT[],
    "schemaHash" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "observations" INTEGER NOT NULL DEFAULT 1,
    "distinctPayloads" INTEGER NOT NULL DEFAULT 1,
    "variesPerRelease" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" INTEGER,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributorEndpointCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DistributorEndpointCandidate_tenantId_scanId_fingerprint_key" ON "DistributorEndpointCandidate"("tenantId", "scanId", "fingerprint");
CREATE INDEX "DistributorEndpointCandidate_tenantId_scanId_idx" ON "DistributorEndpointCandidate"("tenantId", "scanId");
