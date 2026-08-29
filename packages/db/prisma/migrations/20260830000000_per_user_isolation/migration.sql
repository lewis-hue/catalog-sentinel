-- Per-user isolation: drop the org/workspace/invitation hierarchy and re-point every
-- remaining tenant/workspace-scoped table to a single userId column.
--
-- Fresh start: this migration is destructive and does not backfill data. The database is
-- wiped before this is applied in production (a later rollout task); it only needs to
-- produce the correct final schema when applied to an empty/dev database.

-- DropForeignKey
ALTER TABLE "Artist" DROP CONSTRAINT "Artist_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "CatalogSnapshot" DROP CONSTRAINT "CatalogSnapshot_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ConsentGrant" DROP CONSTRAINT "ConsentGrant_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "CredentialReference" DROP CONSTRAINT "CredentialReference_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "DSPAccount" DROP CONSTRAINT "DSPAccount_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "DistributorAccount" DROP CONSTRAINT "DistributorAccount_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointChunk" DROP CONSTRAINT "DistroKidCheckpointChunk_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointIndex" DROP CONSTRAINT "DistroKidCheckpointIndex_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointOutcome" DROP CONSTRAINT "DistroKidCheckpointOutcome_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointPassPlanChunk" DROP CONSTRAINT "DistroKidCheckpointPassPlanChunk_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointProgress" DROP CONSTRAINT "DistroKidCheckpointProgress_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "DistroKidCheckpointTerminal" DROP CONSTRAINT "DistroKidCheckpointTerminal_checkpoint_fkey";

-- DropForeignKey
ALTER TABLE "InvitationWorkspaceGrant" DROP CONSTRAINT "InvitationWorkspaceGrant_invitation_fkey";

-- DropForeignKey
ALTER TABLE "InvitationWorkspaceGrant" DROP CONSTRAINT "InvitationWorkspaceGrant_workspace_fkey";

-- DropForeignKey
ALTER TABLE "Issue" DROP CONSTRAINT "Issue_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationInvitation" DROP CONSTRAINT "OrganizationInvitation_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Release" DROP CONSTRAINT "Release_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "RoyaltyReport" DROP CONSTRAINT "RoyaltyReport_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ScanJob" DROP CONSTRAINT "ScanJob_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "ScanRun" DROP CONSTRAINT "ScanRun_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "SupportPacket" DROP CONSTRAINT "SupportPacket_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Track" DROP CONSTRAINT "Track_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceMembership" DROP CONSTRAINT "WorkspaceMembership_organization_member_fkey";

-- DropForeignKey
ALTER TABLE "WorkspaceMembership" DROP CONSTRAINT "WorkspaceMembership_workspace_fkey";

-- DropIndex
DROP INDEX "Artist_workspaceId_idx";

-- DropIndex
DROP INDEX "AuditLog_tenantId_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_workspaceId_idx";

-- DropIndex
DROP INDEX "BrowserLinkSession_tenantId_idx";

-- DropIndex
DROP INDEX "BrowserLinkSession_tenantId_status_idx";

-- DropIndex
DROP INDEX "BrowserStateRef_tenantId_idx";

-- DropIndex
DROP INDEX "CatalogSnapshot_workspaceId_source_idx";

-- DropIndex
DROP INDEX "ConsentGrant_workspaceId_idx";

-- DropIndex
DROP INDEX "ConsentRevocationIntent_tenantId_completedAt_idx";

-- DropIndex
DROP INDEX "ConsentRevocationIntent_tenantId_consentId_key";

-- DropIndex
DROP INDEX "CredentialReference_workspaceId_idx";

-- DropIndex
DROP INDEX "DSPAccount_workspaceId_idx";

-- DropIndex
DROP INDEX "DeepScanCheckpoint_tenantId_idx";

-- DropIndex
DROP INDEX "DeepScanRun_tenantId_status_idx";

-- DropIndex
DROP INDEX "DistributorAccount_workspaceId_idx";

-- DropIndex
DROP INDEX "DistributorCatalogSnapshot_tenantId_distributor_idx";

-- DropIndex
DROP INDEX "DistributorCatalogSnapshot_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorConnection_tenantId_artistWorkspaceId_distributo_key";

-- DropIndex
DROP INDEX "DistributorConnection_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorEndpointCandidate_tenantId_scanId_fingerprint_key";

-- DropIndex
DROP INDEX "DistributorEndpointCandidate_tenantId_scanId_idx";

-- DropIndex
DROP INDEX "DistributorEndpointProfile_tenantId_distributor_fingerprint_key";

-- DropIndex
DROP INDEX "DistributorEndpointProfile_tenantId_distributor_status_idx";

-- DropIndex
DROP INDEX "DistributorExtractionSnapshot_tenantId_connectionId_idx";

-- DropIndex
DROP INDEX "DistributorExtractionSnapshot_tenantId_distributor_status_idx";

-- DropIndex
DROP INDEX "DistributorExtractionSnapshot_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorExtractionSnapshot_tenantId_snapshotId_key";

-- DropIndex
DROP INDEX "DistributorLinkRecord_tenantId_kind_idx";

-- DropIndex
DROP INDEX "DistributorRelease_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorReleaseOutcome_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorTrack_tenantId_idx";

-- DropIndex
DROP INDEX "DistributorTrackOutcome_tenantId_idx";

-- DropIndex
DROP INDEX "DistroKidCheckpointChunk_scope_pass_idx";

-- DropIndex
DROP INDEX "DistroKidCheckpointIndex_scope_ordinal_key";

-- DropIndex
DROP INDEX "DistroKidCheckpointPassPlanChunk_scope_pass_idx";

-- DropIndex
DROP INDEX "DistroKidSnapshotCheckpoint_tenantId_connectionId_idx";

-- DropIndex
DROP INDEX "Issue_workspaceId_reasonCode_idx";

-- DropIndex
DROP INDEX "Issue_workspaceId_severity_idx";

-- DropIndex
DROP INDEX "ObjectStorageArtifact_tenantId_idx";

-- DropIndex
DROP INDEX "Release_workspaceId_idx";

-- DropIndex
DROP INDEX "RetentionPolicy_tenantId_resourceKind_idx";

-- DropIndex
DROP INDEX "RetentionRun_tenantId_createdAt_idx";

-- DropIndex
DROP INDEX "RoyaltyReport_workspaceId_idx";

-- DropIndex
DROP INDEX "ScanEvent_tenantId_idx";

-- DropIndex
DROP INDEX "ScanJob_workspaceId_idx";

-- DropIndex
DROP INDEX "ScanRun_workspaceId_idx";

-- DropIndex
DROP INDEX "SupportPacket_workspaceId_idx";

-- DropIndex
DROP INDEX "Track_workspaceId_idx";

-- DropIndex
DROP INDEX "User_tenantId_email_key";

-- DropIndex
DROP INDEX "User_tenantId_idx";

-- DropIndex
DROP INDEX "audit_chain_anchors_tenant_anchored_idx";

-- DropIndex
DROP INDEX "audit_chain_anchors_tenant_sequence_key";

-- DropIndex
DROP INDEX "scan_records_tenant_created_idx";

-- DropIndex
DROP INDEX "scan_records_tenant_owner_created_idx";

-- DropIndex
DROP INDEX "scan_records_tenant_workspace_created_idx";

-- DropIndex
DROP INDEX "security_audit_events_tenant_id_occurred_at_idx";

-- DropIndex
DROP INDEX "security_audit_events_tenant_sequence_key";

-- AlterTable
ALTER TABLE "Artist" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "tenantId",
DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "BrowserLinkSession" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "BrowserStateRef" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CatalogSnapshot" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ConsentGrant" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ConsentRevocationIntent" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "CredentialReference" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DSPAccount" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DeepScanCheckpoint" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DeepScanRun" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorAccount" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorCatalogSnapshot" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorConnection" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorEndpointCandidate" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorEndpointProfile" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorExtractionSnapshot" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorLinkRecord" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorRelease" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorReleaseOutcome" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorTrack" DROP COLUMN "artistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistributorTrackOutcome" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DistroKidCheckpointChunk" DROP CONSTRAINT "DistroKidCheckpointChunk_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ADD CONSTRAINT "DistroKidCheckpointChunk_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "pass", "chunkIndex");

-- AlterTable
ALTER TABLE "DistroKidCheckpointIndex" DROP CONSTRAINT "DistroKidCheckpointIndex_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ADD CONSTRAINT "DistroKidCheckpointIndex_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "releaseId");

-- AlterTable
ALTER TABLE "DistroKidCheckpointOutcome" DROP CONSTRAINT "DistroKidCheckpointOutcome_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ADD CONSTRAINT "DistroKidCheckpointOutcome_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "releaseId");

-- AlterTable
ALTER TABLE "DistroKidCheckpointPassPlanChunk" DROP CONSTRAINT "DistroKidCheckpointPassPlanChunk_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ADD CONSTRAINT "DistroKidCheckpointPassPlanChunk_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "pass", "chunkIndex");

-- AlterTable
ALTER TABLE "DistroKidCheckpointProgress" DROP CONSTRAINT "DistroKidCheckpointProgress_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "completedChunks" DROP DEFAULT,
ADD CONSTRAINT "DistroKidCheckpointProgress_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");

-- AlterTable
ALTER TABLE "DistroKidCheckpointTerminal" DROP CONSTRAINT "DistroKidCheckpointTerminal_pkey",
DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL,
ADD CONSTRAINT "DistroKidCheckpointTerminal_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");

-- AlterTable
ALTER TABLE "DistroKidSnapshotCheckpoint" DROP CONSTRAINT "DistroKidSnapshotCheckpoint_pkey",
DROP COLUMN "recoveryArtistWorkspaceId",
DROP COLUMN "tenantId",
ADD COLUMN     "recoveryUserId" TEXT,
ADD COLUMN     "userId" TEXT NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT,
ADD CONSTRAINT "DistroKidSnapshotCheckpoint_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");

-- AlterTable
ALTER TABLE "Issue" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "IssueEvidence" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ObjectStorageArtifact" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Release" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RetentionPolicy" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "RetentionRun" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "RoyaltyReport" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ScanEvent" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ScanJob" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ScanRun" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "SupportPacket" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "TenantErasureRequest" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "Track" DROP COLUMN "workspaceId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "tenantId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "audit_anchor_outbox" DROP CONSTRAINT "audit_anchor_outbox_pkey",
DROP COLUMN "tenant_id",
ADD COLUMN     "user_id" TEXT NOT NULL,
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
ADD CONSTRAINT "audit_anchor_outbox_pkey" PRIMARY KEY ("user_id", "chain_sequence");

-- AlterTable
ALTER TABLE "audit_chain_anchors" DROP COLUMN "tenant_id",
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_pkey",
DROP COLUMN "tenant_id",
ADD COLUMN     "user_id" TEXT NOT NULL,
ADD CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("user_id");

-- AlterTable
ALTER TABLE "scan_records" DROP COLUMN "artist_workspace_id",
DROP COLUMN "owner_user_id",
DROP COLUMN "tenant_id",
ADD COLUMN     "user_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "security_audit_events" DROP COLUMN "tenant_id",
DROP COLUMN "workspace_id",
ADD COLUMN     "user_id" TEXT NOT NULL;

-- DropTable
DROP TABLE "InvitationWorkspaceGrant";

-- DropTable
DROP TABLE "OrganizationInvitation";

-- DropTable
DROP TABLE "OrganizationMembership";

-- DropTable
DROP TABLE "Tenant";

-- DropTable
DROP TABLE "Workspace";

-- DropTable
DROP TABLE "WorkspaceMembership";

-- DropEnum
DROP TYPE "MembershipStatus";

-- DropEnum
DROP TYPE "OrganizationRole";

-- DropEnum
DROP TYPE "WorkspaceRole";

-- CreateIndex
CREATE INDEX "Artist_userId_idx" ON "Artist"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BrowserLinkSession_userId_idx" ON "BrowserLinkSession"("userId");

-- CreateIndex
CREATE INDEX "BrowserLinkSession_userId_status_idx" ON "BrowserLinkSession"("userId", "status");

-- CreateIndex
CREATE INDEX "BrowserStateRef_userId_idx" ON "BrowserStateRef"("userId");

-- CreateIndex
CREATE INDEX "CatalogSnapshot_userId_source_idx" ON "CatalogSnapshot"("userId", "source");

-- CreateIndex
CREATE INDEX "ConsentGrant_userId_idx" ON "ConsentGrant"("userId");

-- CreateIndex
CREATE INDEX "ConsentRevocationIntent_userId_completedAt_idx" ON "ConsentRevocationIntent"("userId", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRevocationIntent_userId_consentId_key" ON "ConsentRevocationIntent"("userId", "consentId");

-- CreateIndex
CREATE INDEX "CredentialReference_userId_idx" ON "CredentialReference"("userId");

-- CreateIndex
CREATE INDEX "DSPAccount_userId_idx" ON "DSPAccount"("userId");

-- CreateIndex
CREATE INDEX "DeepScanCheckpoint_userId_idx" ON "DeepScanCheckpoint"("userId");

-- CreateIndex
CREATE INDEX "DeepScanRun_userId_status_idx" ON "DeepScanRun"("userId", "status");

-- CreateIndex
CREATE INDEX "DistributorAccount_userId_idx" ON "DistributorAccount"("userId");

-- CreateIndex
CREATE INDEX "DistributorCatalogSnapshot_userId_idx" ON "DistributorCatalogSnapshot"("userId");

-- CreateIndex
CREATE INDEX "DistributorCatalogSnapshot_userId_distributor_idx" ON "DistributorCatalogSnapshot"("userId", "distributor");

-- CreateIndex
CREATE INDEX "DistributorConnection_userId_idx" ON "DistributorConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorConnection_userId_distributor_key" ON "DistributorConnection"("userId", "distributor");

-- CreateIndex
CREATE INDEX "DistributorEndpointCandidate_userId_scanId_idx" ON "DistributorEndpointCandidate"("userId", "scanId");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorEndpointCandidate_userId_scanId_fingerprint_key" ON "DistributorEndpointCandidate"("userId", "scanId", "fingerprint");

-- CreateIndex
CREATE INDEX "DistributorEndpointProfile_userId_distributor_status_idx" ON "DistributorEndpointProfile"("userId", "distributor", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorEndpointProfile_userId_distributor_fingerprint_key" ON "DistributorEndpointProfile"("userId", "distributor", "fingerprint");

-- CreateIndex
CREATE INDEX "DistributorExtractionSnapshot_userId_idx" ON "DistributorExtractionSnapshot"("userId");

-- CreateIndex
CREATE INDEX "DistributorExtractionSnapshot_userId_connectionId_idx" ON "DistributorExtractionSnapshot"("userId", "connectionId");

-- CreateIndex
CREATE INDEX "DistributorExtractionSnapshot_userId_distributor_status_idx" ON "DistributorExtractionSnapshot"("userId", "distributor", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DistributorExtractionSnapshot_userId_snapshotId_key" ON "DistributorExtractionSnapshot"("userId", "snapshotId");

-- CreateIndex
CREATE INDEX "DistributorLinkRecord_userId_kind_idx" ON "DistributorLinkRecord"("userId", "kind");

-- CreateIndex
CREATE INDEX "DistributorRelease_userId_idx" ON "DistributorRelease"("userId");

-- CreateIndex
CREATE INDEX "DistributorReleaseOutcome_userId_idx" ON "DistributorReleaseOutcome"("userId");

-- CreateIndex
CREATE INDEX "DistributorTrack_userId_idx" ON "DistributorTrack"("userId");

-- CreateIndex
CREATE INDEX "DistributorTrackOutcome_userId_idx" ON "DistributorTrackOutcome"("userId");

-- CreateIndex
CREATE INDEX "DistroKidCheckpointChunk_userId_connectionId_snapshotId_pas_idx" ON "DistroKidCheckpointChunk"("userId", "connectionId", "snapshotId", "pass");

-- CreateIndex
CREATE UNIQUE INDEX "DistroKidCheckpointIndex_userId_connectionId_snapshotId_ord_key" ON "DistroKidCheckpointIndex"("userId", "connectionId", "snapshotId", "ordinal");

-- CreateIndex
CREATE INDEX "DistroKidCheckpointPassPlanChunk_userId_connectionId_snapsh_idx" ON "DistroKidCheckpointPassPlanChunk"("userId", "connectionId", "snapshotId", "pass");

-- CreateIndex
CREATE INDEX "DistroKidSnapshotCheckpoint_userId_connectionId_idx" ON "DistroKidSnapshotCheckpoint"("userId", "connectionId");

-- CreateIndex
CREATE INDEX "Issue_userId_reasonCode_idx" ON "Issue"("userId", "reasonCode");

-- CreateIndex
CREATE INDEX "Issue_userId_severity_idx" ON "Issue"("userId", "severity");

-- CreateIndex
CREATE INDEX "IssueEvidence_userId_idx" ON "IssueEvidence"("userId");

-- CreateIndex
CREATE INDEX "ObjectStorageArtifact_userId_idx" ON "ObjectStorageArtifact"("userId");

-- CreateIndex
CREATE INDEX "Release_userId_idx" ON "Release"("userId");

-- CreateIndex
CREATE INDEX "RetentionPolicy_userId_resourceKind_idx" ON "RetentionPolicy"("userId", "resourceKind");

-- CreateIndex
CREATE INDEX "RetentionRun_userId_createdAt_idx" ON "RetentionRun"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RoyaltyReport_userId_idx" ON "RoyaltyReport"("userId");

-- CreateIndex
CREATE INDEX "ScanEvent_userId_idx" ON "ScanEvent"("userId");

-- CreateIndex
CREATE INDEX "ScanJob_userId_idx" ON "ScanJob"("userId");

-- CreateIndex
CREATE INDEX "ScanRun_userId_idx" ON "ScanRun"("userId");

-- CreateIndex
CREATE INDEX "SupportPacket_userId_idx" ON "SupportPacket"("userId");

-- CreateIndex
CREATE INDEX "Track_userId_idx" ON "Track"("userId");

-- CreateIndex
CREATE INDEX "User_userId_idx" ON "User"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "User_userId_email_key" ON "User"("userId", "email");

-- CreateIndex
CREATE INDEX "audit_chain_anchors_user_id_anchored_at_idx" ON "audit_chain_anchors"("user_id", "anchored_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_chain_anchors_user_id_chain_sequence_key" ON "audit_chain_anchors"("user_id", "chain_sequence");

-- CreateIndex
CREATE INDEX "scan_records_user_created_idx" ON "scan_records"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "security_audit_events_user_id_occurred_at_idx" ON "security_audit_events"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "security_audit_events_user_id_chain_sequence_key" ON "security_audit_events"("user_id", "chain_sequence");

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointIndex" ADD CONSTRAINT "DistroKidCheckpointIndex_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointOutcome" ADD CONSTRAINT "DistroKidCheckpointOutcome_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointProgress" ADD CONSTRAINT "DistroKidCheckpointProgress_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointChunk" ADD CONSTRAINT "DistroKidCheckpointChunk_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointPassPlanChunk" ADD CONSTRAINT "DistroKidCheckpointPassPlanChunk_userId_connectionId_snaps_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistroKidCheckpointTerminal" ADD CONSTRAINT "DistroKidCheckpointTerminal_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
