-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'manager', 'analyst', 'viewer');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'partial');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('open', 'in_review', 'confirmed', 'remediating', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "BrowserSessionStatus" AS ENUM ('CREATED', 'READY', 'USER_ACTIVE', 'LOGIN_CONFIRMED', 'VALIDATED', 'QUEUED_SCAN', 'EXPIRED', 'TERMINATED', 'FAILED');

-- CreateEnum
CREATE TYPE "BrowserStateKind" AS ENUM ('PROVIDER_PROFILE', 'PLAYWRIGHT_STORAGE_STATE', 'REMOTE_SESSION_ID', 'LOCAL_ONLY');

-- CreateEnum
CREATE TYPE "DistributorConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'NEEDS_REAUTH', 'REVOKED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeepScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED_NEEDS_USER', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'viewer',
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "primaryArtistId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Artist" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT,
    "country" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Artist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistAlias" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'alias',

    CONSTRAINT "ArtistAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArtistProfile" (
    "id" TEXT NOT NULL,
    "artistId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "externalId" TEXT,
    "slug" TEXT,
    "url" TEXT,
    "confirmedByUser" BOOLEAN NOT NULL DEFAULT false,
    "isCanonical" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtistProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "ingestionMode" TEXT NOT NULL,
    "credentialReferenceId" TEXT,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributorAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DSPAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "displayLabel" TEXT NOT NULL,
    "ingestionMode" TEXT NOT NULL,
    "credentialReferenceId" TEXT,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DSPAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialReference" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "secretHandle" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'none',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredentialReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceMode" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "releaseCount" INTEGER NOT NULL DEFAULT 0,
    "trackCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistName" TEXT NOT NULL,
    "upc" TEXT,
    "distributorReleaseId" TEXT,
    "distributorUrl" TEXT,
    "releaseDate" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReleaseIdentifier" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "platform" TEXT,
    "value" TEXT NOT NULL,

    CONSTRAINT "ReleaseIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "primaryArtistName" TEXT NOT NULL,
    "isrc" TEXT,
    "trackNumber" INTEGER,
    "durationSec" INTEGER,
    "isExplicit" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackIdentifier" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "platform" TEXT,
    "value" TEXT NOT NULL,

    CONSTRAINT "TrackIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreSelection" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'open',
    "platform" TEXT,
    "releaseId" TEXT,
    "trackId" TEXT,
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidenceBand" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "issueId" TEXT,
    "snapshotId" TEXT,
    "sourceMode" TEXT NOT NULL,
    "sourceEndpointCategory" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL,
    "normalizedMetadata" JSONB NOT NULL,
    "matchCandidatesConsidered" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidenceBand" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "screenshotRef" TEXT,
    "remediation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportPacket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "targetProvider" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "issueIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportPacket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportPacketArtifact" (
    "id" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,

    CONSTRAINT "SupportPacketArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'on-demand',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'queued',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "stats" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" TEXT NOT NULL,
    "periodEnd" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoyaltyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoyaltyLineItem" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "isrc" TEXT,
    "streams" INTEGER,
    "earnings" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',

    CONSTRAINT "RoyaltyLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "scopes" TEXT[],
    "purpose" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserLinkSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "artistWorkspaceId" TEXT,
    "provider" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "status" "BrowserSessionStatus" NOT NULL DEFAULT 'CREATED',
    "userAccessUrlHash" TEXT,
    "providerSessionIdEncrypted" TEXT NOT NULL,
    "providerAdminTokenEncrypted" TEXT,
    "providerConnectUrlEncrypted" TEXT,
    "browserStateRefId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "terminatedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "metadataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserLinkSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserStateRef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" "BrowserStateKind" NOT NULL,
    "encryptedRef" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserStateRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "artistWorkspaceId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "status" "DistributorConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "connectionMode" TEXT NOT NULL,
    "browserStateRefId" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastScanAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepScanRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "artistWorkspaceId" TEXT NOT NULL,
    "distributorConnectionId" TEXT NOT NULL,
    "status" "DeepScanStatus" NOT NULL DEFAULT 'QUEUED',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "pagesScanned" INTEGER NOT NULL DEFAULT 0,
    "releasesFound" INTEGER NOT NULL DEFAULT 0,
    "tracksFound" INTEGER NOT NULL DEFAULT 0,
    "warningsCount" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "snapshotId" TEXT,
    "idempotencyKey" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeepScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeepScanCheckpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deepScanRunId" TEXT NOT NULL,
    "currentReleaseIndex" INTEGER NOT NULL DEFAULT 0,
    "scannedReleaseIds" TEXT[],
    "scannedTrackIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeepScanCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorCatalogSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "artistWorkspaceId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "deepScanRunId" TEXT,
    "releaseCount" INTEGER NOT NULL DEFAULT 0,
    "trackCount" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributorCatalogSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorRelease" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "distributorReleaseId" TEXT,
    "distributorReleaseUrl" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "primaryArtist" TEXT NOT NULL,
    "upc" TEXT,
    "releaseDate" TEXT,
    "rawSourceJson" JSONB,
    "scanSource" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributorRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorTrack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "artistWorkspaceId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "distributorTrackId" TEXT,
    "distributorTrackUrl" TEXT,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "primaryArtist" TEXT NOT NULL,
    "normalizedPrimaryArtist" TEXT NOT NULL,
    "featuredArtists" TEXT[],
    "isrc" TEXT,
    "releaseTitle" TEXT NOT NULL,
    "upc" TEXT,
    "trackNumber" INTEGER,
    "durationMs" INTEGER,
    "releaseDate" TEXT,
    "lyricsStatus" TEXT NOT NULL,
    "syncedLyricsStatus" TEXT NOT NULL,
    "creditsStatus" TEXT NOT NULL,
    "rawSourceJson" JSONB,
    "scanSource" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributorTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deepScanRunId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataJson" JSONB,

    CONSTRAINT "ScanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectStorageArtifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectStorageArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorLinkRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dataJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributorLinkRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Workspace_tenantId_idx" ON "Workspace"("tenantId");

-- CreateIndex
CREATE INDEX "Artist_workspaceId_idx" ON "Artist"("workspaceId");

-- CreateIndex
CREATE INDEX "ArtistAlias_artistId_idx" ON "ArtistAlias"("artistId");

-- CreateIndex
CREATE INDEX "ArtistProfile_artistId_platform_idx" ON "ArtistProfile"("artistId", "platform");

-- CreateIndex
CREATE INDEX "DistributorAccount_workspaceId_idx" ON "DistributorAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "DSPAccount_workspaceId_idx" ON "DSPAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "CredentialReference_workspaceId_idx" ON "CredentialReference"("workspaceId");

-- CreateIndex
CREATE INDEX "CatalogSnapshot_workspaceId_source_idx" ON "CatalogSnapshot"("workspaceId", "source");

-- CreateIndex
CREATE INDEX "Release_workspaceId_idx" ON "Release"("workspaceId");

-- CreateIndex
CREATE INDEX "Release_upc_idx" ON "Release"("upc");

-- CreateIndex
CREATE INDEX "ReleaseIdentifier_releaseId_idx" ON "ReleaseIdentifier"("releaseId");

-- CreateIndex
CREATE INDEX "ReleaseIdentifier_type_value_idx" ON "ReleaseIdentifier"("type", "value");

-- CreateIndex
CREATE INDEX "Track_workspaceId_idx" ON "Track"("workspaceId");

-- CreateIndex
CREATE INDEX "Track_isrc_idx" ON "Track"("isrc");

-- CreateIndex
CREATE INDEX "TrackIdentifier_trackId_idx" ON "TrackIdentifier"("trackId");

-- CreateIndex
CREATE INDEX "TrackIdentifier_type_value_idx" ON "TrackIdentifier"("type", "value");

-- CreateIndex
CREATE INDEX "StoreSelection_releaseId_platform_idx" ON "StoreSelection"("releaseId", "platform");

-- CreateIndex
CREATE INDEX "Issue_workspaceId_reasonCode_idx" ON "Issue"("workspaceId", "reasonCode");

-- CreateIndex
CREATE INDEX "Issue_workspaceId_severity_idx" ON "Issue"("workspaceId", "severity");

-- CreateIndex
CREATE INDEX "IssueEvidence_issueId_idx" ON "IssueEvidence"("issueId");

-- CreateIndex
CREATE INDEX "SupportPacket_workspaceId_idx" ON "SupportPacket"("workspaceId");

-- CreateIndex
CREATE INDEX "SupportPacketArtifact_packetId_idx" ON "SupportPacketArtifact"("packetId");

-- CreateIndex
CREATE INDEX "ScanJob_workspaceId_idx" ON "ScanJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ScanRun_workspaceId_idx" ON "ScanRun"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanRun_scanJobId_idempotencyKey_key" ON "ScanRun"("scanJobId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "RoyaltyReport_workspaceId_idx" ON "RoyaltyReport"("workspaceId");

-- CreateIndex
CREATE INDEX "RoyaltyLineItem_reportId_idx" ON "RoyaltyLineItem"("reportId");

-- CreateIndex
CREATE INDEX "ConsentGrant_workspaceId_idx" ON "ConsentGrant"("workspaceId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_idx" ON "AuditLog"("workspaceId");

-- CreateIndex
CREATE INDEX "BrowserLinkSession_tenantId_idx" ON "BrowserLinkSession"("tenantId");

-- CreateIndex
CREATE INDEX "BrowserLinkSession_tenantId_status_idx" ON "BrowserLinkSession"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BrowserLinkSession_expiresAt_idx" ON "BrowserLinkSession"("expiresAt");

-- CreateIndex
CREATE INDEX "BrowserStateRef_tenantId_idx" ON "BrowserStateRef"("tenantId");

-- CreateIndex
CREATE INDEX "BrowserStateRef_expiresAt_idx" ON "BrowserStateRef"("expiresAt");

-- CreateIndex
CREATE INDEX "DistributorConnection_tenantId_idx" ON "DistributorConnection"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorConnection_tenantId_artistWorkspaceId_distributo_key" ON "DistributorConnection"("tenantId", "artistWorkspaceId", "distributor");

-- CreateIndex
CREATE INDEX "DeepScanRun_tenantId_status_idx" ON "DeepScanRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DeepScanRun_distributorConnectionId_idx" ON "DeepScanRun"("distributorConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "DeepScanRun_distributorConnectionId_idempotencyKey_key" ON "DeepScanRun"("distributorConnectionId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeepScanCheckpoint_deepScanRunId_key" ON "DeepScanCheckpoint"("deepScanRunId");

-- CreateIndex
CREATE INDEX "DeepScanCheckpoint_tenantId_idx" ON "DeepScanCheckpoint"("tenantId");

-- CreateIndex
CREATE INDEX "DistributorCatalogSnapshot_tenantId_idx" ON "DistributorCatalogSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "DistributorCatalogSnapshot_tenantId_distributor_idx" ON "DistributorCatalogSnapshot"("tenantId", "distributor");

-- CreateIndex
CREATE INDEX "DistributorRelease_tenantId_idx" ON "DistributorRelease"("tenantId");

-- CreateIndex
CREATE INDEX "DistributorRelease_snapshotId_idx" ON "DistributorRelease"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorRelease_snapshotId_distributorReleaseId_key" ON "DistributorRelease"("snapshotId", "distributorReleaseId");

-- CreateIndex
CREATE INDEX "DistributorTrack_tenantId_idx" ON "DistributorTrack"("tenantId");

-- CreateIndex
CREATE INDEX "DistributorTrack_snapshotId_idx" ON "DistributorTrack"("snapshotId");

-- CreateIndex
CREATE INDEX "DistributorTrack_isrc_idx" ON "DistributorTrack"("isrc");

-- CreateIndex
CREATE INDEX "ScanEvent_deepScanRunId_at_idx" ON "ScanEvent"("deepScanRunId", "at");

-- CreateIndex
CREATE INDEX "ScanEvent_tenantId_idx" ON "ScanEvent"("tenantId");

-- CreateIndex
CREATE INDEX "ObjectStorageArtifact_tenantId_idx" ON "ObjectStorageArtifact"("tenantId");

-- CreateIndex
CREATE INDEX "DistributorLinkRecord_tenantId_kind_idx" ON "DistributorLinkRecord"("tenantId", "kind");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artist" ADD CONSTRAINT "Artist_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistAlias" ADD CONSTRAINT "ArtistAlias_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtistProfile" ADD CONSTRAINT "ArtistProfile_artistId_fkey" FOREIGN KEY ("artistId") REFERENCES "Artist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorAccount" ADD CONSTRAINT "DistributorAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DSPAccount" ADD CONSTRAINT "DSPAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialReference" ADD CONSTRAINT "CredentialReference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogSnapshot" ADD CONSTRAINT "CatalogSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Release" ADD CONSTRAINT "Release_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CatalogSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseIdentifier" ADD CONSTRAINT "ReleaseIdentifier_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Track" ADD CONSTRAINT "Track_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackIdentifier" ADD CONSTRAINT "TrackIdentifier_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreSelection" ADD CONSTRAINT "StoreSelection_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueEvidence" ADD CONSTRAINT "IssueEvidence_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPacket" ADD CONSTRAINT "SupportPacket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportPacketArtifact" ADD CONSTRAINT "SupportPacketArtifact_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "SupportPacket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanJob" ADD CONSTRAINT "ScanJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "ScanJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyReport" ADD CONSTRAINT "RoyaltyReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyaltyLineItem" ADD CONSTRAINT "RoyaltyLineItem_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "RoyaltyReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentGrant" ADD CONSTRAINT "ConsentGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorRelease" ADD CONSTRAINT "DistributorRelease_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "DistributorCatalogSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorTrack" ADD CONSTRAINT "DistributorTrack_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "DistributorRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
