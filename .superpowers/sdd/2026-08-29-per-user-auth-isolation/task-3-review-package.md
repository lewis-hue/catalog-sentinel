# Task 3 review package (ab26ea1..5989c93)

## Commits
5989c93 feat(db): per-user schema, drop org/workspace/invitation tables

## Stat
 .../migration.sql                                  | 698 +++++++++++++++++++++
 packages/db/prisma/schema.prisma                   | 540 ++++++----------
 2 files changed, 884 insertions(+), 354 deletions(-)

## Diff (-U6)
diff --git a/packages/db/prisma/migrations/20260830000000_per_user_isolation/migration.sql b/packages/db/prisma/migrations/20260830000000_per_user_isolation/migration.sql
new file mode 100644
index 0000000..5e687c6
--- /dev/null
+++ b/packages/db/prisma/migrations/20260830000000_per_user_isolation/migration.sql
@@ -0,0 +1,698 @@
+-- Per-user isolation: drop the org/workspace/invitation hierarchy and re-point every
+-- remaining tenant/workspace-scoped table to a single userId column.
+--
+-- Fresh start: this migration is destructive and does not backfill data. The database is
+-- wiped before this is applied in production (a later rollout task); it only needs to
+-- produce the correct final schema when applied to an empty/dev database.
+
+-- DropForeignKey
+ALTER TABLE "Artist" DROP CONSTRAINT "Artist_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_tenantId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "CatalogSnapshot" DROP CONSTRAINT "CatalogSnapshot_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "ConsentGrant" DROP CONSTRAINT "ConsentGrant_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "CredentialReference" DROP CONSTRAINT "CredentialReference_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DSPAccount" DROP CONSTRAINT "DSPAccount_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistributorAccount" DROP CONSTRAINT "DistributorAccount_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointChunk" DROP CONSTRAINT "DistroKidCheckpointChunk_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointIndex" DROP CONSTRAINT "DistroKidCheckpointIndex_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointOutcome" DROP CONSTRAINT "DistroKidCheckpointOutcome_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointPassPlanChunk" DROP CONSTRAINT "DistroKidCheckpointPassPlanChunk_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointProgress" DROP CONSTRAINT "DistroKidCheckpointProgress_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "DistroKidCheckpointTerminal" DROP CONSTRAINT "DistroKidCheckpointTerminal_checkpoint_fkey";
+
+-- DropForeignKey
+ALTER TABLE "InvitationWorkspaceGrant" DROP CONSTRAINT "InvitationWorkspaceGrant_invitation_fkey";
+
+-- DropForeignKey
+ALTER TABLE "InvitationWorkspaceGrant" DROP CONSTRAINT "InvitationWorkspaceGrant_workspace_fkey";
+
+-- DropForeignKey
+ALTER TABLE "Issue" DROP CONSTRAINT "Issue_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "OrganizationInvitation" DROP CONSTRAINT "OrganizationInvitation_tenantId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "OrganizationMembership" DROP CONSTRAINT "OrganizationMembership_tenantId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "Release" DROP CONSTRAINT "Release_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "RoyaltyReport" DROP CONSTRAINT "RoyaltyReport_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "ScanJob" DROP CONSTRAINT "ScanJob_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "ScanRun" DROP CONSTRAINT "ScanRun_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "SupportPacket" DROP CONSTRAINT "SupportPacket_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "Track" DROP CONSTRAINT "Track_workspaceId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "User" DROP CONSTRAINT "User_tenantId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "Workspace" DROP CONSTRAINT "Workspace_tenantId_fkey";
+
+-- DropForeignKey
+ALTER TABLE "WorkspaceMembership" DROP CONSTRAINT "WorkspaceMembership_organization_member_fkey";
+
+-- DropForeignKey
+ALTER TABLE "WorkspaceMembership" DROP CONSTRAINT "WorkspaceMembership_workspace_fkey";
+
+-- DropIndex
+DROP INDEX "Artist_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "AuditLog_tenantId_createdAt_idx";
+
+-- DropIndex
+DROP INDEX "AuditLog_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "BrowserLinkSession_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "BrowserLinkSession_tenantId_status_idx";
+
+-- DropIndex
+DROP INDEX "BrowserStateRef_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "CatalogSnapshot_workspaceId_source_idx";
+
+-- DropIndex
+DROP INDEX "ConsentGrant_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "ConsentRevocationIntent_tenantId_completedAt_idx";
+
+-- DropIndex
+DROP INDEX "ConsentRevocationIntent_tenantId_consentId_key";
+
+-- DropIndex
+DROP INDEX "CredentialReference_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "DSPAccount_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "DeepScanCheckpoint_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DeepScanRun_tenantId_status_idx";
+
+-- DropIndex
+DROP INDEX "DistributorAccount_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorCatalogSnapshot_tenantId_distributor_idx";
+
+-- DropIndex
+DROP INDEX "DistributorCatalogSnapshot_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorConnection_tenantId_artistWorkspaceId_distributo_key";
+
+-- DropIndex
+DROP INDEX "DistributorConnection_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorEndpointCandidate_tenantId_scanId_fingerprint_key";
+
+-- DropIndex
+DROP INDEX "DistributorEndpointCandidate_tenantId_scanId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorEndpointProfile_tenantId_distributor_fingerprint_key";
+
+-- DropIndex
+DROP INDEX "DistributorEndpointProfile_tenantId_distributor_status_idx";
+
+-- DropIndex
+DROP INDEX "DistributorExtractionSnapshot_tenantId_connectionId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorExtractionSnapshot_tenantId_distributor_status_idx";
+
+-- DropIndex
+DROP INDEX "DistributorExtractionSnapshot_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorExtractionSnapshot_tenantId_snapshotId_key";
+
+-- DropIndex
+DROP INDEX "DistributorLinkRecord_tenantId_kind_idx";
+
+-- DropIndex
+DROP INDEX "DistributorRelease_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorReleaseOutcome_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorTrack_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistributorTrackOutcome_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "DistroKidCheckpointChunk_scope_pass_idx";
+
+-- DropIndex
+DROP INDEX "DistroKidCheckpointIndex_scope_ordinal_key";
+
+-- DropIndex
+DROP INDEX "DistroKidCheckpointPassPlanChunk_scope_pass_idx";
+
+-- DropIndex
+DROP INDEX "DistroKidSnapshotCheckpoint_tenantId_connectionId_idx";
+
+-- DropIndex
+DROP INDEX "Issue_workspaceId_reasonCode_idx";
+
+-- DropIndex
+DROP INDEX "Issue_workspaceId_severity_idx";
+
+-- DropIndex
+DROP INDEX "ObjectStorageArtifact_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "Release_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "RetentionPolicy_tenantId_resourceKind_idx";
+
+-- DropIndex
+DROP INDEX "RetentionRun_tenantId_createdAt_idx";
+
+-- DropIndex
+DROP INDEX "RoyaltyReport_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "ScanEvent_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "ScanJob_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "ScanRun_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "SupportPacket_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "Track_workspaceId_idx";
+
+-- DropIndex
+DROP INDEX "User_tenantId_email_key";
+
+-- DropIndex
+DROP INDEX "User_tenantId_idx";
+
+-- DropIndex
+DROP INDEX "audit_chain_anchors_tenant_anchored_idx";
+
+-- DropIndex
+DROP INDEX "audit_chain_anchors_tenant_sequence_key";
+
+-- DropIndex
+DROP INDEX "scan_records_tenant_created_idx";
+
+-- DropIndex
+DROP INDEX "scan_records_tenant_owner_created_idx";
+
+-- DropIndex
+DROP INDEX "scan_records_tenant_workspace_created_idx";
+
+-- DropIndex
+DROP INDEX "security_audit_events_tenant_id_occurred_at_idx";
+
+-- DropIndex
+DROP INDEX "security_audit_events_tenant_sequence_key";
+
+-- AlterTable
+ALTER TABLE "Artist" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "AuditLog" DROP COLUMN "tenantId",
+DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "BrowserLinkSession" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ALTER COLUMN "userId" SET NOT NULL;
+
+-- AlterTable
+ALTER TABLE "BrowserStateRef" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "CatalogSnapshot" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ConsentGrant" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ConsentRevocationIntent" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "CredentialReference" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DSPAccount" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DeepScanCheckpoint" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DeepScanRun" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorAccount" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorCatalogSnapshot" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorConnection" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorEndpointCandidate" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorEndpointProfile" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorExtractionSnapshot" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorLinkRecord" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorRelease" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorReleaseOutcome" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorTrack" DROP COLUMN "artistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistributorTrackOutcome" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointChunk" DROP CONSTRAINT "DistroKidCheckpointChunk_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ADD CONSTRAINT "DistroKidCheckpointChunk_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "pass", "chunkIndex");
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointIndex" DROP CONSTRAINT "DistroKidCheckpointIndex_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ADD CONSTRAINT "DistroKidCheckpointIndex_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "releaseId");
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointOutcome" DROP CONSTRAINT "DistroKidCheckpointOutcome_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ALTER COLUMN "updatedAt" DROP DEFAULT,
+ADD CONSTRAINT "DistroKidCheckpointOutcome_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "releaseId");
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointPassPlanChunk" DROP CONSTRAINT "DistroKidCheckpointPassPlanChunk_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ADD CONSTRAINT "DistroKidCheckpointPassPlanChunk_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId", "pass", "chunkIndex");
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointProgress" DROP CONSTRAINT "DistroKidCheckpointProgress_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ALTER COLUMN "completedChunks" DROP DEFAULT,
+ADD CONSTRAINT "DistroKidCheckpointProgress_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");
+
+-- AlterTable
+ALTER TABLE "DistroKidCheckpointTerminal" DROP CONSTRAINT "DistroKidCheckpointTerminal_pkey",
+DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL,
+ADD CONSTRAINT "DistroKidCheckpointTerminal_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");
+
+-- AlterTable
+ALTER TABLE "DistroKidSnapshotCheckpoint" DROP CONSTRAINT "DistroKidSnapshotCheckpoint_pkey",
+DROP COLUMN "recoveryArtistWorkspaceId",
+DROP COLUMN "tenantId",
+ADD COLUMN     "recoveryUserId" TEXT,
+ADD COLUMN     "userId" TEXT NOT NULL,
+ALTER COLUMN "updatedAt" DROP DEFAULT,
+ADD CONSTRAINT "DistroKidSnapshotCheckpoint_pkey" PRIMARY KEY ("userId", "connectionId", "snapshotId");
+
+-- AlterTable
+ALTER TABLE "Issue" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "IssueEvidence" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ObjectStorageArtifact" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "Release" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "RetentionPolicy" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT;
+
+-- AlterTable
+ALTER TABLE "RetentionRun" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT;
+
+-- AlterTable
+ALTER TABLE "RoyaltyReport" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ScanEvent" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ScanJob" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "ScanRun" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "SupportPacket" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "TenantErasureRequest" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT;
+
+-- AlterTable
+ALTER TABLE "Track" DROP COLUMN "workspaceId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "User" DROP COLUMN "tenantId",
+ADD COLUMN     "userId" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "audit_anchor_outbox" DROP CONSTRAINT "audit_anchor_outbox_pkey",
+DROP COLUMN "tenant_id",
+ADD COLUMN     "user_id" TEXT NOT NULL,
+ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
+ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3),
+ADD CONSTRAINT "audit_anchor_outbox_pkey" PRIMARY KEY ("user_id", "chain_sequence");
+
+-- AlterTable
+ALTER TABLE "audit_chain_anchors" DROP COLUMN "tenant_id",
+ADD COLUMN     "user_id" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "audit_chain_heads" DROP CONSTRAINT "audit_chain_heads_pkey",
+DROP COLUMN "tenant_id",
+ADD COLUMN     "user_id" TEXT NOT NULL,
+ADD CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("user_id");
+
+-- AlterTable
+ALTER TABLE "scan_records" DROP COLUMN "artist_workspace_id",
+DROP COLUMN "owner_user_id",
+DROP COLUMN "tenant_id",
+ADD COLUMN     "user_id" TEXT NOT NULL;
+
+-- AlterTable
+ALTER TABLE "security_audit_events" DROP COLUMN "tenant_id",
+DROP COLUMN "workspace_id",
+ADD COLUMN     "user_id" TEXT NOT NULL;
+
+-- DropTable
+DROP TABLE "InvitationWorkspaceGrant";
+
+-- DropTable
+DROP TABLE "OrganizationInvitation";
+
+-- DropTable
+DROP TABLE "OrganizationMembership";
+
+-- DropTable
+DROP TABLE "Tenant";
+
+-- DropTable
+DROP TABLE "Workspace";
+
+-- DropTable
+DROP TABLE "WorkspaceMembership";
+
+-- DropEnum
+DROP TYPE "MembershipStatus";
+
+-- DropEnum
+DROP TYPE "OrganizationRole";
+
+-- DropEnum
+DROP TYPE "WorkspaceRole";
+
+-- CreateIndex
+CREATE INDEX "Artist_userId_idx" ON "Artist"("userId");
+
+-- CreateIndex
+CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt" DESC);
+
+-- CreateIndex
+CREATE INDEX "BrowserLinkSession_userId_idx" ON "BrowserLinkSession"("userId");
+
+-- CreateIndex
+CREATE INDEX "BrowserLinkSession_userId_status_idx" ON "BrowserLinkSession"("userId", "status");
+
+-- CreateIndex
+CREATE INDEX "BrowserStateRef_userId_idx" ON "BrowserStateRef"("userId");
+
+-- CreateIndex
+CREATE INDEX "CatalogSnapshot_userId_source_idx" ON "CatalogSnapshot"("userId", "source");
+
+-- CreateIndex
+CREATE INDEX "ConsentGrant_userId_idx" ON "ConsentGrant"("userId");
+
+-- CreateIndex
+CREATE INDEX "ConsentRevocationIntent_userId_completedAt_idx" ON "ConsentRevocationIntent"("userId", "completedAt");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "ConsentRevocationIntent_userId_consentId_key" ON "ConsentRevocationIntent"("userId", "consentId");
+
+-- CreateIndex
+CREATE INDEX "CredentialReference_userId_idx" ON "CredentialReference"("userId");
+
+-- CreateIndex
+CREATE INDEX "DSPAccount_userId_idx" ON "DSPAccount"("userId");
+
+-- CreateIndex
+CREATE INDEX "DeepScanCheckpoint_userId_idx" ON "DeepScanCheckpoint"("userId");
+
+-- CreateIndex
+CREATE INDEX "DeepScanRun_userId_status_idx" ON "DeepScanRun"("userId", "status");
+
+-- CreateIndex
+CREATE INDEX "DistributorAccount_userId_idx" ON "DistributorAccount"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorCatalogSnapshot_userId_idx" ON "DistributorCatalogSnapshot"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorCatalogSnapshot_userId_distributor_idx" ON "DistributorCatalogSnapshot"("userId", "distributor");
+
+-- CreateIndex
+CREATE INDEX "DistributorConnection_userId_idx" ON "DistributorConnection"("userId");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "DistributorConnection_userId_distributor_key" ON "DistributorConnection"("userId", "distributor");
+
+-- CreateIndex
+CREATE INDEX "DistributorEndpointCandidate_userId_scanId_idx" ON "DistributorEndpointCandidate"("userId", "scanId");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "DistributorEndpointCandidate_userId_scanId_fingerprint_key" ON "DistributorEndpointCandidate"("userId", "scanId", "fingerprint");
+
+-- CreateIndex
+CREATE INDEX "DistributorEndpointProfile_userId_distributor_status_idx" ON "DistributorEndpointProfile"("userId", "distributor", "status");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "DistributorEndpointProfile_userId_distributor_fingerprint_key" ON "DistributorEndpointProfile"("userId", "distributor", "fingerprint");
+
+-- CreateIndex
+CREATE INDEX "DistributorExtractionSnapshot_userId_idx" ON "DistributorExtractionSnapshot"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorExtractionSnapshot_userId_connectionId_idx" ON "DistributorExtractionSnapshot"("userId", "connectionId");
+
+-- CreateIndex
+CREATE INDEX "DistributorExtractionSnapshot_userId_distributor_status_idx" ON "DistributorExtractionSnapshot"("userId", "distributor", "status");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "DistributorExtractionSnapshot_userId_snapshotId_key" ON "DistributorExtractionSnapshot"("userId", "snapshotId");
+
+-- CreateIndex
+CREATE INDEX "DistributorLinkRecord_userId_kind_idx" ON "DistributorLinkRecord"("userId", "kind");
+
+-- CreateIndex
+CREATE INDEX "DistributorRelease_userId_idx" ON "DistributorRelease"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorReleaseOutcome_userId_idx" ON "DistributorReleaseOutcome"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorTrack_userId_idx" ON "DistributorTrack"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistributorTrackOutcome_userId_idx" ON "DistributorTrackOutcome"("userId");
+
+-- CreateIndex
+CREATE INDEX "DistroKidCheckpointChunk_userId_connectionId_snapshotId_pas_idx" ON "DistroKidCheckpointChunk"("userId", "connectionId", "snapshotId", "pass");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "DistroKidCheckpointIndex_userId_connectionId_snapshotId_ord_key" ON "DistroKidCheckpointIndex"("userId", "connectionId", "snapshotId", "ordinal");
+
+-- CreateIndex
+CREATE INDEX "DistroKidCheckpointPassPlanChunk_userId_connectionId_snapsh_idx" ON "DistroKidCheckpointPassPlanChunk"("userId", "connectionId", "snapshotId", "pass");
+
+-- CreateIndex
+CREATE INDEX "DistroKidSnapshotCheckpoint_userId_connectionId_idx" ON "DistroKidSnapshotCheckpoint"("userId", "connectionId");
+
+-- CreateIndex
+CREATE INDEX "Issue_userId_reasonCode_idx" ON "Issue"("userId", "reasonCode");
+
+-- CreateIndex
+CREATE INDEX "Issue_userId_severity_idx" ON "Issue"("userId", "severity");
+
+-- CreateIndex
+CREATE INDEX "IssueEvidence_userId_idx" ON "IssueEvidence"("userId");
+
+-- CreateIndex
+CREATE INDEX "ObjectStorageArtifact_userId_idx" ON "ObjectStorageArtifact"("userId");
+
+-- CreateIndex
+CREATE INDEX "Release_userId_idx" ON "Release"("userId");
+
+-- CreateIndex
+CREATE INDEX "RetentionPolicy_userId_resourceKind_idx" ON "RetentionPolicy"("userId", "resourceKind");
+
+-- CreateIndex
+CREATE INDEX "RetentionRun_userId_createdAt_idx" ON "RetentionRun"("userId", "createdAt" DESC);
+
+-- CreateIndex
+CREATE INDEX "RoyaltyReport_userId_idx" ON "RoyaltyReport"("userId");
+
+-- CreateIndex
+CREATE INDEX "ScanEvent_userId_idx" ON "ScanEvent"("userId");
+
+-- CreateIndex
+CREATE INDEX "ScanJob_userId_idx" ON "ScanJob"("userId");
+
+-- CreateIndex
+CREATE INDEX "ScanRun_userId_idx" ON "ScanRun"("userId");
+
+-- CreateIndex
+CREATE INDEX "SupportPacket_userId_idx" ON "SupportPacket"("userId");
+
+-- CreateIndex
+CREATE INDEX "Track_userId_idx" ON "Track"("userId");
+
+-- CreateIndex
+CREATE INDEX "User_userId_idx" ON "User"("userId");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "User_userId_email_key" ON "User"("userId", "email");
+
+-- CreateIndex
+CREATE INDEX "audit_chain_anchors_user_id_anchored_at_idx" ON "audit_chain_anchors"("user_id", "anchored_at");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "audit_chain_anchors_user_id_chain_sequence_key" ON "audit_chain_anchors"("user_id", "chain_sequence");
+
+-- CreateIndex
+CREATE INDEX "scan_records_user_created_idx" ON "scan_records"("user_id", "created_at" DESC);
+
+-- CreateIndex
+CREATE INDEX "security_audit_events_user_id_occurred_at_idx" ON "security_audit_events"("user_id", "occurred_at");
+
+-- CreateIndex
+CREATE UNIQUE INDEX "security_audit_events_user_id_chain_sequence_key" ON "security_audit_events"("user_id", "chain_sequence");
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointIndex" ADD CONSTRAINT "DistroKidCheckpointIndex_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointOutcome" ADD CONSTRAINT "DistroKidCheckpointOutcome_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointProgress" ADD CONSTRAINT "DistroKidCheckpointProgress_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointChunk" ADD CONSTRAINT "DistroKidCheckpointChunk_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointPassPlanChunk" ADD CONSTRAINT "DistroKidCheckpointPassPlanChunk_userId_connectionId_snaps_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
+
+-- AddForeignKey
+ALTER TABLE "DistroKidCheckpointTerminal" ADD CONSTRAINT "DistroKidCheckpointTerminal_userId_connectionId_snapshotId_fkey" FOREIGN KEY ("userId", "connectionId", "snapshotId") REFERENCES "DistroKidSnapshotCheckpoint"("userId", "connectionId", "snapshotId") ON DELETE CASCADE ON UPDATE CASCADE;
diff --git a/packages/db/prisma/schema.prisma b/packages/db/prisma/schema.prisma
index 543ffef..c64d190 100644
--- a/packages/db/prisma/schema.prisma
+++ b/packages/db/prisma/schema.prisma
@@ -1,11 +1,11 @@
-// Artist Catalog Sentinel — canonical data model (PRD §D).
+// Artist Catalog Sentinel - canonical data model (PRD §D).
 // PostgreSQL is the production persistence source of truth (see docs/runbook.md).
 //
-// Multi-tenant: every row is scoped to a Tenant; the app enforces per-tenant
-// isolation at the query layer (row-level security recommended in prod).
+// Per-user: every row is scoped to a userId (the authenticated subject); the app enforces
+// per-user isolation at the query layer (row-level security recommended in prod).
 
 generator client {
   provider = "prisma-client-js"
 }
 
 datasource db {
@@ -18,32 +18,12 @@ enum UserRole {
   admin
   manager
   analyst
   viewer
 }
 
-enum OrganizationRole {
-  OWNER
-  ADMIN
-  MEMBER
-  AUDITOR
-  BILLING
-}
-
-enum WorkspaceRole {
-  OWNER
-  MANAGER
-  EDITOR
-  VIEWER
-}
-
-enum MembershipStatus {
-  ACTIVE
-  SUSPENDED
-}
-
 enum GovernanceJobStatus {
   PENDING
   RUNNING
   SUCCEEDED
   FAILED
   CANCELLED
@@ -72,160 +52,41 @@ enum IssueStatus {
   confirmed
   remediating
   resolved
   dismissed
 }
 
-model Tenant {
-  id        String   @id @default(cuid())
-  name      String
-  plan      String   @default("free")
-  createdAt DateTime @default(now())
-  updatedAt DateTime @updatedAt
-
-  users                   User[]
-  workspaces              Workspace[]
-  auditLogs               AuditLog[]
-  organizationMemberships OrganizationMembership[]
-  organizationInvitations OrganizationInvitation[]
-}
-
 model User {
   id          String   @id @default(cuid())
-  tenantId    String
+  userId      String
   email       String
   displayName String
   role        UserRole @default(viewer)
   mfaEnabled  Boolean  @default(false)
   createdAt   DateTime @default(now())
   updatedAt   DateTime @updatedAt
 
-  tenant        Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
   consentGrants ConsentGrant[]
 
-  @@unique([tenantId, email])
-  @@index([tenantId])
-}
-
-model Workspace {
-  id              String   @id @default(cuid())
-  tenantId        String
-  name            String
-  primaryArtistId String?
-  createdAt       DateTime @default(now())
-  updatedAt       DateTime @updatedAt
-
-  tenant               Tenant                     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
-  artists              Artist[]
-  distributorAccounts  DistributorAccount[]
-  dspAccounts          DSPAccount[]
-  credentialReferences CredentialReference[]
-  catalogSnapshots     CatalogSnapshot[]
-  releases             Release[]
-  tracks               Track[]
-  issues               Issue[]
-  supportPackets       SupportPacket[]
-  scanJobs             ScanJob[]
-  scanRuns             ScanRun[]
-  consentGrants        ConsentGrant[]
-  royaltyReports       RoyaltyReport[]
-  workspaceMemberships WorkspaceMembership[]
-  invitationGrants     InvitationWorkspaceGrant[]
-
-  @@unique([tenantId, id])
-  @@index([tenantId])
-}
-
-/// OIDC subjects, rather than mutable email addresses, are the authorization identity.
-/// A subject may belong to multiple organizations (Tenant is the legacy organization name).
-model OrganizationMembership {
-  id        String           @id @default(cuid())
-  tenantId  String
-  subjectId String
-  role      OrganizationRole
-  status    MembershipStatus @default(ACTIVE)
-  createdAt DateTime         @default(now()) @db.Timestamptz(3)
-  updatedAt DateTime         @updatedAt @db.Timestamptz(3)
-
-  tenant               Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
-  workspaceMemberships WorkspaceMembership[]
-
-  @@unique([tenantId, subjectId])
-  @@index([subjectId, status])
-}
-
-model WorkspaceMembership {
-  id          String           @id @default(cuid())
-  tenantId    String
-  workspaceId String
-  subjectId   String
-  role        WorkspaceRole
-  status      MembershipStatus @default(ACTIVE)
-  createdAt   DateTime         @default(now()) @db.Timestamptz(3)
-  updatedAt   DateTime         @updatedAt @db.Timestamptz(3)
-
-  organizationMembership OrganizationMembership @relation(fields: [tenantId, subjectId], references: [tenantId, subjectId], onDelete: Cascade)
-  workspace              Workspace              @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Cascade)
-
-  @@unique([tenantId, workspaceId, subjectId])
-  @@index([tenantId, subjectId, status])
-  @@index([workspaceId, status])
-}
-
-/// Only a SHA-256 digest of the bearer token is persisted. The plaintext token is returned once.
-model OrganizationInvitation {
-  id                  String           @id @default(cuid())
-  tenantId            String
-  emailNormalized     String
-  tokenHash           String           @unique
-  organizationRole    OrganizationRole
-  issuedBySubjectId   String
-  acceptedBySubjectId String?
-  expiresAt           DateTime         @db.Timestamptz(3)
-  acceptedAt          DateTime?        @db.Timestamptz(3)
-  revokedAt           DateTime?        @db.Timestamptz(3)
-  idempotencyKey      String
-  createdAt           DateTime         @default(now()) @db.Timestamptz(3)
-  updatedAt           DateTime         @updatedAt @db.Timestamptz(3)
-
-  tenant          Tenant                     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
-  workspaceGrants InvitationWorkspaceGrant[]
-
-  @@unique([tenantId, idempotencyKey])
-  @@unique([tenantId, id])
-  @@index([tenantId, emailNormalized, expiresAt])
-}
-
-model InvitationWorkspaceGrant {
-  id           String        @id @default(cuid())
-  tenantId     String
-  invitationId String
-  workspaceId  String
-  role         WorkspaceRole
-
-  invitation OrganizationInvitation @relation(fields: [tenantId, invitationId], references: [tenantId, id], onDelete: Cascade)
-  workspace  Workspace              @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Cascade)
-
-  @@unique([invitationId, workspaceId])
-  @@index([tenantId, workspaceId])
+  @@unique([userId, email])
+  @@index([userId])
 }
 
 model Artist {
-  id          String   @id @default(cuid())
-  workspaceId String
-  name        String
-  label       String?
-  country     String?
-  createdAt   DateTime @default(now())
-  updatedAt   DateTime @updatedAt
+  id        String   @id @default(cuid())
+  userId    String
+  name      String
+  label     String?
+  country   String?
+  createdAt DateTime @default(now())
+  updatedAt DateTime @updatedAt
 
-  workspace Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-  aliases   ArtistAlias[]
-  profiles  ArtistProfile[]
+  aliases  ArtistAlias[]
+  profiles ArtistProfile[]
 
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model ArtistAlias {
   id       String @id @default(cuid())
   artistId String
   value    String
@@ -252,98 +113,90 @@ model ArtistProfile {
 
   @@index([artistId, platform])
 }
 
 model DistributorAccount {
   id                    String   @id @default(cuid())
-  workspaceId           String
+  userId                String
   provider              String
   displayLabel          String
   ingestionMode         String
   credentialReferenceId String?
   connected             Boolean  @default(false)
   createdAt             DateTime @default(now())
   updatedAt             DateTime @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model DSPAccount {
   id                    String   @id @default(cuid())
-  workspaceId           String
+  userId                String
   platform              String
   displayLabel          String
   ingestionMode         String
   credentialReferenceId String?
   connected             Boolean  @default(false)
   createdAt             DateTime @default(now())
   updatedAt             DateTime @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 // Stores ONLY an opaque handle to a secret held in KMS/Secrets Manager.
 // NEVER stores a password or secret value.
 model CredentialReference {
   id           String    @id @default(cuid())
-  workspaceId  String
+  userId       String
   provider     String
   secretHandle String
   kind         String    @default("none")
   expiresAt    DateTime?
   createdAt    DateTime  @default(now())
   updatedAt    DateTime  @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model CatalogSnapshot {
   id           String   @id @default(cuid())
-  workspaceId  String
+  userId       String
   source       String
   sourceMode   String
   capturedAt   DateTime
   releaseCount Int      @default(0)
   trackCount   Int      @default(0)
   notes        String?
   createdAt    DateTime @default(now())
   updatedAt    DateTime @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-  releases  Release[]
+  releases Release[]
 
-  @@index([workspaceId, source])
+  @@index([userId, source])
 }
 
 model Release {
   id                   String   @id @default(cuid())
-  workspaceId          String
+  userId               String
   snapshotId           String
   title                String
   primaryArtistName    String
   upc                  String?
   distributorReleaseId String?
   distributorUrl       String?
   releaseDate          String?
   label                String?
   createdAt            DateTime @default(now())
   updatedAt            DateTime @updatedAt
 
-  workspace       Workspace           @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
   snapshot        CatalogSnapshot     @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
   tracks          Track[]
   storeSelections StoreSelection[]
   identifiers     ReleaseIdentifier[]
 
-  @@index([workspaceId])
+  @@index([userId])
   @@index([upc])
 }
 
 model ReleaseIdentifier {
   id        String  @id @default(cuid())
   releaseId String
@@ -356,28 +209,27 @@ model ReleaseIdentifier {
   @@index([releaseId])
   @@index([type, value])
 }
 
 model Track {
   id                String   @id @default(cuid())
-  workspaceId       String
+  userId            String
   releaseId         String
   title             String
   primaryArtistName String
   isrc              String?
   trackNumber       Int?
   durationSec       Int?
   isExplicit        Boolean?
   createdAt         DateTime @default(now())
   updatedAt         DateTime @updatedAt
 
-  workspace   Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
   release     Release           @relation(fields: [releaseId], references: [id], onDelete: Cascade)
   identifiers TrackIdentifier[]
 
-  @@index([workspaceId])
+  @@index([userId])
   @@index([isrc])
 }
 
 model TrackIdentifier {
   id       String  @id @default(cuid())
   trackId  String
@@ -402,13 +254,13 @@ model StoreSelection {
 
   @@index([releaseId, platform])
 }
 
 model Issue {
   id                String      @id @default(cuid())
-  workspaceId       String
+  userId            String
   reasonCode        String
   severity          String
   status            IssueStatus @default(open)
   platform          String?
   releaseId         String?
   trackId           String?
@@ -416,22 +268,21 @@ model Issue {
   confidence        Float       @default(0)
   confidenceBand    String
   recommendedAction String
   createdAt         DateTime    @default(now())
   updatedAt         DateTime    @updatedAt
 
-  workspace Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-  evidence  IssueEvidence[]
+  evidence IssueEvidence[]
 
-  @@index([workspaceId, reasonCode])
-  @@index([workspaceId, severity])
+  @@index([userId, reasonCode])
+  @@index([userId, severity])
 }
 
 model IssueEvidence {
   id                        String   @id @default(cuid())
-  workspaceId               String
+  userId                    String
   issueId                   String?
   snapshotId                String?
   sourceMode                String
   sourceEndpointCategory    String
   scannedAt                 DateTime
   normalizedMetadata        Json
@@ -442,32 +293,32 @@ model IssueEvidence {
   screenshotRef             String?
   remediation               String
   createdAt                 DateTime @default(now())
 
   issue Issue? @relation(fields: [issueId], references: [id], onDelete: Cascade)
 
+  @@index([userId])
   @@index([issueId])
 }
 
 model SupportPacket {
   id             String   @id @default(cuid())
-  workspaceId    String
+  userId         String
   template       String
   targetAudience String
   targetProvider String
   title          String
   subject        String
   bodyMarkdown   String
   issueIds       String[]
   createdAt      DateTime @default(now())
   updatedAt      DateTime @updatedAt
 
-  workspace Workspace               @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
   artifacts SupportPacketArtifact[]
 
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model SupportPacketArtifact {
   id       String @id @default(cuid())
   packetId String
   format   String
@@ -477,58 +328,55 @@ model SupportPacketArtifact {
   packet SupportPacket @relation(fields: [packetId], references: [id], onDelete: Cascade)
 
   @@index([packetId])
 }
 
 model ScanJob {
-  id          String   @id @default(cuid())
-  workspaceId String
-  kind        String
-  params      Json
-  schedule    String   @default("on-demand")
-  createdAt   DateTime @default(now())
-  updatedAt   DateTime @updatedAt
+  id        String   @id @default(cuid())
+  userId    String
+  kind      String
+  params    Json
+  schedule  String   @default("on-demand")
+  createdAt DateTime @default(now())
+  updatedAt DateTime @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-  runs      ScanRun[]
+  runs ScanRun[]
 
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model ScanRun {
   id             String     @id @default(cuid())
   scanJobId      String
-  workspaceId    String
+  userId         String
   status         ScanStatus @default(queued)
   startedAt      DateTime?
   finishedAt     DateTime?
   idempotencyKey String
   stats          Json
   error          String?
   createdAt      DateTime   @default(now())
   updatedAt      DateTime   @updatedAt
 
-  scanJob   ScanJob   @relation(fields: [scanJobId], references: [id], onDelete: Cascade)
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
+  scanJob ScanJob @relation(fields: [scanJobId], references: [id], onDelete: Cascade)
 
   @@unique([scanJobId, idempotencyKey])
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model RoyaltyReport {
   id          String   @id @default(cuid())
-  workspaceId String
+  userId      String
   periodStart String
   periodEnd   String
   source      String
   createdAt   DateTime @default(now())
 
-  workspace Workspace         @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
   lineItems RoyaltyLineItem[]
 
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model RoyaltyLineItem {
   id       String  @id @default(cuid())
   reportId String
   platform String
@@ -541,94 +389,88 @@ model RoyaltyLineItem {
 
   @@index([reportId])
 }
 
 model ConsentGrant {
   id              String    @id @default(cuid())
-  workspaceId     String
+  userId          String
   grantedByUserId String
   scopes          String[]
   purpose         String
   retentionDays   Int       @default(30)
   grantedAt       DateTime  @default(now())
   expiresAt       DateTime
   revokedAt       DateTime?
   createdAt       DateTime  @default(now())
   updatedAt       DateTime  @updatedAt
 
-  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
-  user      User      @relation(fields: [grantedByUserId], references: [id], onDelete: Cascade)
+  user User @relation(fields: [grantedByUserId], references: [id], onDelete: Cascade)
 
-  @@index([workspaceId])
+  @@index([userId])
 }
 
 model AuditLog {
   id          String   @id @default(cuid())
-  tenantId    String
-  workspaceId String?
+  userId      String
   actorUserId String?
   action      String
   targetType  String
   targetId    String?
   metadata    Json
   createdAt   DateTime @default(now())
 
-  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
-
-  @@index([tenantId, createdAt])
-  @@index([workspaceId])
+  @@index([userId, createdAt(sort: Desc)])
 }
 
-/// Append-only operational audit stream. This intentionally has no Tenant foreign key so the
-/// first authenticated action for a newly issued tenant can be recorded before provisioning.
+/// Append-only operational audit stream. This intentionally has no foreign key so the
+/// first authenticated action for a newly issued user can be recorded before provisioning.
 model SecurityAuditEvent {
   id               String   @id
   occurredAt       DateTime @default(now()) @map("occurred_at") @db.Timestamptz(3)
-  tenantId         String   @map("tenant_id")
-  workspaceId      String?  @map("workspace_id")
+  userId           String   @map("user_id")
   actorUserId      String?  @map("actor_user_id")
   action           String
   targetType       String   @map("target_type")
   targetId         String?  @map("target_id")
   metadata         Json     @default("{}")
   chainSequence    BigInt   @map("chain_sequence")
   previousHash     String   @map("previous_hash")
   eventHash        String   @map("event_hash")
   canonicalPayload String   @map("canonical_payload")
   canonicalVersion Int      @default(1) @map("canonical_version")
 
-  @@unique([tenantId, chainSequence])
-  @@index([tenantId, occurredAt])
+  @@unique([userId, chainSequence])
+  @@index([userId, occurredAt])
   @@index([targetType, targetId])
   @@map("security_audit_events")
 }
 
 /// Mutable pointer used only to serialize appends. The immutable events remain the authority.
 model AuditChainHead {
-  tenantId     String   @id @map("tenant_id")
+  userId       String   @id @map("user_id")
   lastSequence BigInt   @default(0) @map("last_sequence")
   lastHash     String   @default("") @map("last_hash")
   updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
 
   @@map("audit_chain_heads")
 }
 
 /// Signed checkpoints can be copied to WORM storage; the signature makes a rewritten DB chain
 /// detectable even to an offline verifier that does not trust this database.
 model AuditChainAnchor {
   id            String   @id
-  tenantId      String   @map("tenant_id")
+  userId        String   @map("user_id")
   chainSequence BigInt   @map("chain_sequence")
   eventHash     String   @map("event_hash")
   signerKeyId   String   @map("signer_key_id")
   signature     String
   externalRef   String   @map("external_ref")
   anchoredAt    DateTime @default(now()) @map("anchored_at") @db.Timestamptz(3)
 
-  @@unique([tenantId, chainSequence])
-  @@index([tenantId, anchoredAt])
+  @@unique([userId, chainSequence])
+  @@index([userId, anchoredAt])
   @@map("audit_chain_anchors")
 }
 
 /// Immutable, KMS-signed proof that an expired audit chain and its external WORM anchors were
 /// removed through the controlled retention procedure. It contains only irreversible digests.
 model AuditErasureReceipt {
@@ -650,21 +492,21 @@ model AuditErasureReceipt {
   @@map("audit_erasure_receipts")
 }
 
 /// Crash-recovery outbox holding the exact KMS signature until its immutable S3 anchor and
 /// database reference commit. This is operational state, not an audit event.
 model AuditAnchorOutbox {
-  tenantId      String   @map("tenant_id")
+  userId        String   @map("user_id")
   chainSequence BigInt   @map("chain_sequence")
   eventHash     String   @map("event_hash")
   payload       String
   signerKeyId   String   @map("signer_key_id")
   signature     String
   createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
 
-  @@id([tenantId, chainSequence])
+  @@id([userId, chainSequence])
   @@map("audit_anchor_outbox")
 }
 
 /// Durable freeze and exact inventory for a legally expired audit purge. Creation is serialized
 /// with audit appends and anchor publication; it is removed only by the guarded purge function.
 model AuditPurgeManifest {
@@ -681,14 +523,14 @@ model AuditPurgeManifest {
 
   @@map("audit_purge_manifests")
 }
 
 // ===========================================================================
 // Secure Distributor Link + Deep Catalog Scan (production models).
-// Standalone (string tenantId + indexes) to keep migrations simple. Sensitive
-// references are stored ONLY as envelope-encrypted blobs — never raw cookies.
+// Standalone (string userId + indexes) to keep migrations simple. Sensitive
+// references are stored ONLY as envelope-encrypted blobs - never raw cookies.
 // ===========================================================================
 
 enum BrowserSessionStatus {
   CREATED
   READY
   USER_ACTIVE
@@ -724,15 +566,13 @@ enum DeepScanStatus {
   FAILED
   CANCELLED
 }
 
 model BrowserLinkSession {
   id                          String               @id @default(cuid())
-  tenantId                    String
-  userId                      String?
-  artistWorkspaceId           String?
+  userId                      String
   provider                    String
   distributor                 String
   status                      BrowserSessionStatus @default(CREATED)
   userAccessUrlHash           String?
   providerSessionIdEncrypted  String
   providerAdminTokenEncrypted String?
@@ -743,54 +583,52 @@ model BrowserLinkSession {
   terminatedAt                DateTime?
   lastHeartbeatAt             DateTime?
   metadataJson                Json?
   createdAt                   DateTime             @default(now())
   updatedAt                   DateTime             @updatedAt
 
-  @@index([tenantId])
-  @@index([tenantId, status])
+  @@index([userId])
+  @@index([userId, status])
   @@index([expiresAt])
 }
 
 model BrowserStateRef {
   id           String           @id @default(cuid())
-  tenantId     String
+  userId       String
   provider     String
   kind         BrowserStateKind
   encryptedRef String
   expiresAt    DateTime
   revokedAt    DateTime?
   createdAt    DateTime         @default(now())
   updatedAt    DateTime         @updatedAt
 
-  @@index([tenantId])
+  @@index([userId])
   @@index([expiresAt])
 }
 
 model DistributorConnection {
   id                String                      @id @default(cuid())
-  tenantId          String
-  artistWorkspaceId String
+  userId            String
   distributor       String
   status            DistributorConnectionStatus @default(PENDING)
   connectionMode    String
   browserStateRefId String?
   lastValidatedAt   DateTime?
   lastScanAt        DateTime?
   revokedAt         DateTime?
   createdAt         DateTime                    @default(now())
   updatedAt         DateTime                    @updatedAt
 
-  @@unique([tenantId, artistWorkspaceId, distributor])
-  @@index([tenantId])
+  @@unique([userId, distributor])
+  @@index([userId])
 }
 
 model DeepScanRun {
   id                      String         @id @default(cuid())
-  tenantId                String
-  artistWorkspaceId       String
+  userId                  String
   distributorConnectionId String
   status                  DeepScanStatus @default(QUEUED)
   progressPercent         Int            @default(0)
   currentStep             String?
   pagesScanned            Int            @default(0)
   releasesFound           Int            @default(0)
@@ -802,75 +640,73 @@ model DeepScanRun {
   startedAt               DateTime?
   completedAt             DateTime?
   createdAt               DateTime       @default(now())
   updatedAt               DateTime       @updatedAt
 
   @@unique([distributorConnectionId, idempotencyKey])
-  @@index([tenantId, status])
+  @@index([userId, status])
   @@index([distributorConnectionId])
 }
 
 model DeepScanCheckpoint {
   id                  String   @id @default(cuid())
-  tenantId            String
+  userId              String
   deepScanRunId       String   @unique
   currentReleaseIndex Int      @default(0)
   scannedReleaseIds   String[]
   scannedTrackIds     String[]
   createdAt           DateTime @default(now())
   updatedAt           DateTime @updatedAt
 
-  @@index([tenantId])
+  @@index([userId])
 }
 
 model DistributorCatalogSnapshot {
-  id                String   @id @default(cuid())
-  tenantId          String
-  artistWorkspaceId String
-  distributor       String
-  deepScanRunId     String?
-  releaseCount      Int      @default(0)
-  trackCount        Int      @default(0)
-  capturedAt        DateTime @default(now())
-  createdAt         DateTime @default(now())
+  id            String   @id @default(cuid())
+  userId        String
+  distributor   String
+  deepScanRunId String?
+  releaseCount  Int      @default(0)
+  trackCount    Int      @default(0)
+  capturedAt    DateTime @default(now())
+  createdAt     DateTime @default(now())
 
   releases DistributorRelease[]
 
-  @@index([tenantId])
-  @@index([tenantId, distributor])
+  @@index([userId])
+  @@index([userId, distributor])
 }
 
 model DistributorRelease {
   id                    String   @id @default(cuid())
-  tenantId              String
+  userId                String
   snapshotId            String
   distributor           String
   distributorReleaseId  String?
   distributorReleaseUrl String?
   title                 String
   normalizedTitle       String
   primaryArtist         String
-  // UPC is a RELEASE-level identifier and lives only here — never on a track.
+  // UPC is a RELEASE-level identifier and lives only here - never on a track.
   upc                   String?
   releaseDate           String?
   scanSource            String?
   confidence            Float    @default(0)
   createdAt             DateTime @default(now())
 
   snapshot DistributorCatalogSnapshot @relation(fields: [snapshotId], references: [id], onDelete: Cascade)
   tracks   DistributorTrack[]
 
   @@unique([snapshotId, distributorReleaseId])
-  @@index([tenantId])
+  @@index([userId])
   @@index([snapshotId])
 }
 
 model DistributorTrack {
   id                      String   @id @default(cuid())
-  tenantId                String
-  artistWorkspaceId       String
+  userId                  String
   snapshotId              String
   releaseId               String
   distributor             String
   distributorTrackId      String?
   distributorTrackUrl     String?
   title                   String
@@ -891,20 +727,20 @@ model DistributorTrack {
   scanSource              String?
   confidence              Float    @default(0)
   createdAt               DateTime @default(now())
 
   release DistributorRelease @relation(fields: [releaseId], references: [id], onDelete: Cascade)
 
-  // ISRC duplicates are DETECTED and flagged, never blocked — so no unique on ISRC.
-  @@index([tenantId])
+  // ISRC duplicates are DETECTED and flagged, never blocked - so no unique on ISRC.
+  @@index([userId])
   @@index([snapshotId])
   @@index([isrc])
 }
 
 // ============================================================================
-// Network-first extraction — the DURABLE system of record.
+// Network-first extraction - the DURABLE system of record.
 //
 // Redis holds operational checkpoints so a crashed read can resume; it is NOT the catalog
 // system of record and may be flushed at any time. These tables are what survive.
 //
 // Two rules the older tables broke:
 //   1. Store NORMALIZED, ALLOWLISTED fields only. There is deliberately no raw-payload column:
@@ -913,13 +749,13 @@ model DistributorTrack {
 //   2. Record WHY a value is absent. A null that means "the distributor has no UPC" and a null
 //      that means "our request timed out" are different facts, and only one is retryable.
 // ============================================================================
 
 model DistributorExtractionSnapshot {
   id           String @id @default(cuid())
-  tenantId     String
+  userId       String
   connectionId String
   /// The application-level snapshot id (the scan/search id). Idempotency key for finalization.
   snapshotId   String
   distributor  String
   /// COMPLETE | COMPLETE_WITH_SOURCE_GAPS | PARTIAL_RETRYABLE | PARTIAL_REAUTH_REQUIRED |
   /// FAILED_SCHEMA_CHANGED | FAILED
@@ -931,13 +767,13 @@ model DistributorExtractionSnapshot {
   completedReleases   Int     @default(0)
   failedReleases      Int     @default(0)
   expectedTracksKnown Boolean @default(false)
   expectedTracks      Int     @default(0)
   extractedTracks     Int     @default(0)
 
-  // Coverage per identifier LEVEL — never blended into one number.
+  // Coverage per identifier LEVEL - never blended into one number.
   releasesWithUpc     Int @default(0)
   releasesWithArtwork Int @default(0)
   tracksWithIsrc      Int @default(0)
 
   // "Absent at source" (the distributor has none) vs "not captured" (our failure, retryable).
   releasesUpcAbsentAtSource Int @default(0)
@@ -959,24 +795,24 @@ model DistributorExtractionSnapshot {
   storeLyricsTotal     Int       @default(0)
   storeLyricsError     String?
   storeLyricsCheckedAt DateTime?
 
   releases DistributorReleaseOutcome[]
 
-  @@unique([tenantId, snapshotId])
-  @@index([tenantId])
-  @@index([tenantId, connectionId])
-  @@index([tenantId, distributor, status])
+  @@unique([userId, snapshotId])
+  @@index([userId])
+  @@index([userId, connectionId])
+  @@index([userId, distributor, status])
 }
 
 model DistributorReleaseOutcome {
   id                   String  @id @default(cuid())
-  tenantId             String
+  userId               String
   extractionSnapshotId String
   distributorReleaseId String
-  /// COMPLETED | FAILED | SKIPPED — every indexed release gets one. A release with no row is
+  /// COMPLETED | FAILED | SKIPPED - every indexed release gets one. A release with no row is
   /// what makes a snapshot PARTIAL_RETRYABLE rather than silently short.
   kind                 String
   /// Reason CODE for a non-COMPLETED outcome: TIMEOUT | REQUEST_FAILED | PARSE_FAILED |
   /// SCHEMA_CHANGED | REAUTH_REQUIRED | NOT_AUTHORIZED | RATE_LIMITED | BUDGET_EXHAUSTED | UNKNOWN
   reason               String?
 
@@ -1012,22 +848,22 @@ model DistributorReleaseOutcome {
 
   snapshot DistributorExtractionSnapshot @relation(fields: [extractionSnapshotId], references: [id], onDelete: Cascade)
   tracks   DistributorTrackOutcome[]
 
   // Finalization is idempotent: a retried finalize upserts on this key rather than duplicating.
   @@unique([extractionSnapshotId, distributorReleaseId])
-  @@index([tenantId])
+  @@index([userId])
   @@index([extractionSnapshotId, kind])
 }
 
 model DistributorTrackOutcome {
   id                 String   @id @default(cuid())
-  tenantId           String
+  userId             String
   releaseOutcomeId   String
   distributorTrackId String?
-  /// Position within the release — the stable key when the distributor exposes no track id.
+  /// Position within the release - the stable key when the distributor exposes no track id.
   trackIndex         Int
   title              String?
   primaryArtist      String?
   featuredArtists    String[]
   trackNumber        Int?
   durationMs         Int?
@@ -1035,13 +871,13 @@ model DistributorTrackOutcome {
 
   // Track-level identifier + WHY it is absent when it is. No `upc` here, by design.
   isrc       String?
   isrcStatus String  @default("UNKNOWN")
 
   /// Distributor-side lyric availability per type: present | processing | none | unknown.
-  /// `unknown` (the default) means the scrape did not read the cell — never rendered as "missing".
+  /// `unknown` (the default) means the scrape did not read the cell - never rendered as "missing".
   plainLyricsStatus  String @default("unknown")
   syncedLyricsStatus String @default("unknown")
 
   /// Store-side lyric availability, verified against the stores' lyric provider (LRCLIB), kept next
   /// to the distributor-side status so one track row carries BOTH facts for the missing-lyrics
   /// comparison. Written by the independent lyrics-verification worker (not the store-presence scan).
@@ -1062,19 +898,19 @@ model DistributorTrackOutcome {
   parserVersion String?
   capturedAt    DateTime?
 
   release DistributorReleaseOutcome @relation(fields: [releaseOutcomeId], references: [id], onDelete: Cascade)
 
   @@unique([releaseOutcomeId, trackIndex])
-  @@index([tenantId])
+  @@index([userId])
   @@index([isrc])
 }
 
 model DistributorEndpointProfile {
   id          String @id @default(cuid())
-  tenantId    String
+  userId      String
   distributor String
   /// SANITIZED identity: hash of (method, host, masked path, query KEY names, operationName).
   /// Never contains query VALUES, cookies, headers or tokens.
   fingerprint String
 
   /// catalogIndex | releaseDetails | trackIdentifiers | artwork | storeDeliveryStatus |
@@ -1109,20 +945,20 @@ model DistributorEndpointProfile {
 
   firstSeenAt DateTime  @default(now())
   lastSeenAt  DateTime  @updatedAt
   promotedAt  DateTime?
   degradedAt  DateTime?
 
-  @@unique([tenantId, distributor, fingerprint])
-  @@index([tenantId, distributor, status])
+  @@unique([userId, distributor, fingerprint])
+  @@index([userId, distributor, status])
 }
 
 model DistributorEndpointCandidate {
   id          String @id @default(cuid())
-  tenantId    String
-  /// The scan that observed it — candidates are discovery output, scoped to their scan.
+  userId      String
+  /// The scan that observed it - candidates are discovery output, scoped to their scan.
   scanId      String
   distributor String
   fingerprint String
 
   method        String
   host          String
@@ -1132,112 +968,107 @@ model DistributorEndpointCandidate {
   schemaKeys    String[]
   schemaHash    String?
 
   score            Int     @default(0)
   observations     Int     @default(1)
   distinctPayloads Int     @default(1)
-  /// Whether the payload varied per release — a constant payload cannot be release data.
+  /// Whether the payload varied per release - a constant payload cannot be release data.
   variesPerRelease Boolean @default(false)
   sizeBytes        Int?
 
   firstSeenAt DateTime @default(now())
   lastSeenAt  DateTime @updatedAt
 
-  @@unique([tenantId, scanId, fingerprint])
-  @@index([tenantId, scanId])
+  @@unique([userId, scanId, fingerprint])
+  @@index([userId, scanId])
 }
 
 model ScanEvent {
   id            String   @id @default(cuid())
-  tenantId      String
+  userId        String
   deepScanRunId String
   type          String
   at            DateTime @default(now())
   dataJson      Json?
 
   @@index([deepScanRunId, at])
-  @@index([tenantId])
+  @@index([userId])
 }
 
 model ObjectStorageArtifact {
   id        String    @id @default(cuid())
-  tenantId  String
+  userId    String
   kind      String
   objectKey String
   byteSize  Int       @default(0)
   encrypted Boolean   @default(true)
   expiresAt DateTime?
   createdAt DateTime  @default(now())
 
-  @@index([tenantId])
+  @@index([userId])
 }
 
-/// Operational, tenant-scoped store for the distributor-link feature state
+/// Operational, user-scoped store for the distributor-link feature state
 /// (sessions, consents, connections, scan runs). One JSON payload per record,
-/// keyed by kind. Every query filters by tenantId (cross-tenant isolation).
+/// keyed by kind. Every query filters by userId (cross-user isolation).
 model DistributorLinkRecord {
   id        String   @id
-  tenantId  String
+  userId    String
   kind      String
   dataJson  Json
   createdAt DateTime @default(now())
   updatedAt DateTime @updatedAt
 
-  @@index([tenantId, kind])
+  @@index([userId, kind])
 }
 
 /// Transactional outbox for consent revocation side effects. The application updates the
 /// JSON consent row and inserts this intent in one SQL statement, then replicas lease work with
 /// `FOR UPDATE SKIP LOCKED`. Lease-token CAS prevents a stale worker from acknowledging another
 /// replica's retry.
 model ConsentRevocationIntent {
-  id                String    @id
-  tenantId          String
-  consentId         String
-  artistWorkspaceId String
-  attempts          Int       @default(0)
-  availableAt       DateTime  @default(now()) @db.Timestamptz(3)
-  leaseToken        String?
-  leaseExpiresAt    DateTime? @db.Timestamptz(3)
-  lastError         String?
-  completedAt       DateTime? @db.Timestamptz(3)
-  createdAt         DateTime  @default(now()) @db.Timestamptz(3)
-  updatedAt         DateTime  @updatedAt @db.Timestamptz(3)
-
-  @@unique([tenantId, consentId])
+  id             String    @id
+  userId         String
+  consentId      String
+  attempts       Int       @default(0)
+  availableAt    DateTime  @default(now()) @db.Timestamptz(3)
+  leaseToken     String?
+  leaseExpiresAt DateTime? @db.Timestamptz(3)
+  lastError      String?
+  completedAt    DateTime? @db.Timestamptz(3)
+  createdAt      DateTime  @default(now()) @db.Timestamptz(3)
+  updatedAt      DateTime  @updatedAt @db.Timestamptz(3)
+
+  @@unique([userId, consentId])
   @@index([availableAt, leaseExpiresAt])
-  @@index([tenantId, completedAt])
+  @@index([userId, completedAt])
 }
 
-/// Durable, tenant-owned projection served by the search API and updated by scan workers.
+/// Durable, user-owned projection served by the search API and updated by scan workers.
 /// The runtime uses revision-conditional SQL for cross-process convergence; schema ownership
 /// remains exclusively in the Prisma migration chain.
 model ScanRecord {
-  id                String   @id
-  tenantId          String   @default("default") @map("tenant_id")
-  ownerUserId       String?  @map("owner_user_id")
-  artistWorkspaceId String?  @map("artist_workspace_id")
-  artist            String
-  distributor       String
-  deepScanStatus    String?  @map("deep_scan_status")
-  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
-  updatedAt         DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
-  record            Json
+  id             String   @id
+  userId         String   @map("user_id")
+  artist         String
+  distributor    String
+  deepScanStatus String?  @map("deep_scan_status")
+  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
+  updatedAt      DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
+  record         Json
 
   @@index([createdAt(sort: Desc)], map: "scan_records_created_idx")
-  @@index([tenantId, createdAt(sort: Desc)], map: "scan_records_tenant_created_idx")
-  @@index([tenantId, ownerUserId, createdAt(sort: Desc)], map: "scan_records_tenant_owner_created_idx")
-  @@index([tenantId, artistWorkspaceId, createdAt(sort: Desc)], map: "scan_records_tenant_workspace_created_idx")
+  @@index([userId, createdAt(sort: Desc)], map: "scan_records_user_created_idx")
   @@map("scan_records")
 }
 
-/// Durable request retained after erasure as a pseudonymous compliance receipt. `tenantId` is
+/// Durable request retained after erasure as a pseudonymous compliance receipt. `userId` is
 /// nulled only after every required resource reports success or an explicit legal-hold outcome.
 model TenantErasureRequest {
   id                     String              @id @default(cuid())
-  tenantId               String?
+  userId                 String?
   tenantHash             String
   requestedBySubjectHash String
   pseudonymKeyVersion    String
   idempotencyKey         String
   reason                 String
   status                 GovernanceJobStatus @default(PENDING)
@@ -1275,17 +1106,18 @@ model TenantErasureStep {
   request TenantErasureRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
 
   @@unique([requestId, resourceKind])
   @@index([requestId, status])
 }
 
-/// Policies are versioned and can be global (`tenantId = null`, `scopeKey = GLOBAL`) or tenant
-/// specific (`scopeKey = tenant:<id>`). `scopeKey` closes PostgreSQL's nullable-unique loophole.
+/// Policies are versioned and can be global (`userId = null`, `scopeKey = GLOBAL`) or user
+/// specific (`scopeKey` referencing the owning userId). `scopeKey` closes PostgreSQL's
+/// nullable-unique loophole.
 model RetentionPolicy {
   id                 String   @id @default(cuid())
-  tenantId           String?
+  userId             String?
   scopeKey           String
   resourceKind       String
   retentionDays      Int
   deletionGraceDays  Int      @default(7)
   enabled            Boolean  @default(true)
   version            Int      @default(1)
@@ -1295,19 +1127,19 @@ model RetentionPolicy {
   updatedAt          DateTime @updatedAt @db.Timestamptz(3)
 
   runs RetentionRun[]
 
   @@unique([scopeKey, resourceKind])
   @@index([enabled, nextRunAt])
-  @@index([tenantId, resourceKind])
+  @@index([userId, resourceKind])
 }
 
 model RetentionRun {
   id             String              @id @default(cuid())
   policyId       String
-  tenantId       String?
+  userId         String?
   idempotencyKey String
   status         GovernanceJobStatus @default(PENDING)
   cutoffAt       DateTime            @db.Timestamptz(3)
   cursor         Json                @default("{}")
   deletedCount   BigInt              @default(0)
   attempts       Int                 @default(0)
@@ -1321,20 +1153,20 @@ model RetentionRun {
   updatedAt      DateTime            @updatedAt @db.Timestamptz(3)
 
   policy RetentionPolicy @relation(fields: [policyId], references: [id], onDelete: Restrict)
 
   @@unique([policyId, idempotencyKey])
   @@index([status, availableAt, leaseExpiresAt])
-  @@index([tenantId, createdAt])
+  @@index([userId, createdAt(sort: Desc)])
 }
 
 /// Durable ownership anchor for an in-flight DistroKid catalogue read. `snapshotId` is globally
-/// unique so a queue job can never re-bind a snapshot to another tenant or connection. Redis is
+/// unique so a queue job can never re-bind a snapshot to another user or connection. Redis is
 /// only a rehydratable hot projection of the child rows below.
 model DistroKidSnapshotCheckpoint {
-  tenantId        String
+  userId          String
   connectionId    String
   snapshotId      String
   distributor     String
   indexVersion    BigInt   @default(0)
   outcomesVersion BigInt   @default(0)
   progressVersion BigInt   @default(0)
@@ -1343,13 +1175,13 @@ model DistroKidSnapshotCheckpoint {
   terminalVersion BigInt   @default(0)
   /// Recovery authority is populated by the API before BullMQ submission and cleared only after
   /// terminal Steel release. The handle is already application-envelope-encrypted; plaintext
   /// provider ids, cookies, storage state, passwords, and 2FA values are rejected by the writer.
   recoveryArtists                Json?     @db.JsonB
   recoveryConsentId              String?
-  recoveryArtistWorkspaceId      String?
+  recoveryUserId                 String?
   recoverySteelSessionIdEncrypted String?
   recoverySessionExpiresAt       DateTime? @db.Timestamptz(3)
   recoveryDeadlineAt             DateTime? @db.Timestamptz(3)
   recoverySchemaVersion          Int?
   createdAt       DateTime @default(now()) @db.Timestamptz(3)
   updatedAt       DateTime @updatedAt @db.Timestamptz(3)
@@ -1358,106 +1190,106 @@ model DistroKidSnapshotCheckpoint {
   outcomes        DistroKidCheckpointOutcome[]
   progress        DistroKidCheckpointProgress?
   completedChunks DistroKidCheckpointChunk[]
   passPlanChunks  DistroKidCheckpointPassPlanChunk[]
   terminal        DistroKidCheckpointTerminal?
 
-  @@id([tenantId, connectionId, snapshotId])
+  @@id([userId, connectionId, snapshotId])
   @@unique([snapshotId])
-  @@index([tenantId, connectionId])
+  @@index([userId, connectionId])
 }
 
 /// Sanitized release references only. No response body, request headers, cookie or token is
 /// representable in this table.
 model DistroKidCheckpointIndex {
-  tenantId           String
+  userId             String
   connectionId       String
   snapshotId         String
   releaseId          String
   ordinal            Int
   dashboardUrl       String
   title              String?
   artist             String?
   expectedTrackCount Int?
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId, releaseId])
-  @@unique([tenantId, connectionId, snapshotId, ordinal])
+  @@id([userId, connectionId, snapshotId, releaseId])
+  @@unique([userId, connectionId, snapshotId, ordinal])
 }
 
 /// One normalized extraction outcome per release. The application reconstructs this JSON from
 /// the canonical metadata contract and strips unknown/raw transport fields before every write.
 model DistroKidCheckpointOutcome {
-  tenantId     String
+  userId       String
   connectionId String
   snapshotId   String
   releaseId    String
   outcome      Json
   updatedAt    DateTime @updatedAt @db.Timestamptz(3)
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId, releaseId])
+  @@id([userId, connectionId, snapshotId, releaseId])
 }
 
 model DistroKidCheckpointProgress {
-  tenantId          String
+  userId            String
   connectionId      String
   snapshotId        String
   distributor       String
   status            String
   expectedReleases  Int
   completedReleases Int
   failedReleases    Int
   chunkCount        Int
   completedChunks   Int[]
   startedAt         DateTime @db.Timestamptz(3)
   updatedAt         DateTime @db.Timestamptz(3)
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId])
+  @@id([userId, connectionId, snapshotId])
 }
 
 model DistroKidCheckpointChunk {
-  tenantId     String
+  userId       String
   connectionId String
   snapshotId   String
   pass         Int
   chunkIndex   Int
   completedAt  DateTime @default(now()) @db.Timestamptz(3)
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId, pass, chunkIndex])
-  @@index([tenantId, connectionId, snapshotId, pass])
+  @@id([userId, connectionId, snapshotId, pass, chunkIndex])
+  @@index([userId, connectionId, snapshotId, pass])
 }
 
 /// One bounded row per planned chunk rather than one unbounded plan document.
 model DistroKidCheckpointPassPlanChunk {
-  tenantId     String
+  userId       String
   connectionId String
   snapshotId   String
   pass         Int
   chunkIndex   Int
   releaseIds   String[]
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId, pass, chunkIndex])
-  @@index([tenantId, connectionId, snapshotId, pass])
+  @@id([userId, connectionId, snapshotId, pass, chunkIndex])
+  @@index([userId, connectionId, snapshotId, pass])
 }
 
 /// First-writer-wins terminal/cancellation record. Queue session handles may be present only in
 /// their application envelope-encrypted v1/v2 form; the durable store rejects plaintext handles.
 model DistroKidCheckpointTerminal {
-  tenantId     String
+  userId       String
   connectionId String
   snapshotId   String
   tombstone    Json
   createdAt    DateTime @default(now()) @db.Timestamptz(3)
 
-  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [tenantId, connectionId, snapshotId], references: [tenantId, connectionId, snapshotId], onDelete: Cascade)
+  checkpoint DistroKidSnapshotCheckpoint @relation(fields: [userId, connectionId, snapshotId], references: [userId, connectionId, snapshotId], onDelete: Cascade)
 
-  @@id([tenantId, connectionId, snapshotId])
+  @@id([userId, connectionId, snapshotId])
 }
