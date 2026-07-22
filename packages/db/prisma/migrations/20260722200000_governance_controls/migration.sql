-- Durable organization access, privacy lifecycle jobs, and a database-serialized audit chain.
-- Every mutable governance operation is tenant scoped and every worker lease uses compare-and-set.

CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING');
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'MANAGER', 'EDITOR', 'VIEWER');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "GovernanceJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "GovernanceStepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED_LEGAL_HOLD');

CREATE UNIQUE INDEX "Workspace_tenantId_id_key" ON "Workspace"("tenantId", "id");

CREATE TABLE "OrganizationMembership" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "role" "OrganizationRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationMembership_subject_nonempty" CHECK (length(btrim("subjectId")) > 0)
);

CREATE UNIQUE INDEX "OrganizationMembership_tenantId_subjectId_key"
  ON "OrganizationMembership"("tenantId", "subjectId");
CREATE INDEX "OrganizationMembership_subjectId_status_idx"
  ON "OrganizationMembership"("subjectId", "status");

CREATE TABLE "WorkspaceMembership" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subjectId" TEXT NOT NULL,
  "role" "WorkspaceRole" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "WorkspaceMembership_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkspaceMembership_subject_nonempty" CHECK (length(btrim("subjectId")) > 0)
);

CREATE UNIQUE INDEX "WorkspaceMembership_tenantId_workspaceId_subjectId_key"
  ON "WorkspaceMembership"("tenantId", "workspaceId", "subjectId");
CREATE INDEX "WorkspaceMembership_tenantId_subjectId_status_idx"
  ON "WorkspaceMembership"("tenantId", "subjectId", "status");
CREATE INDEX "WorkspaceMembership_workspaceId_status_idx"
  ON "WorkspaceMembership"("workspaceId", "status");

CREATE TABLE "OrganizationInvitation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "organizationRole" "OrganizationRole" NOT NULL,
  "issuedBySubjectId" TEXT NOT NULL,
  "acceptedBySubjectId" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "idempotencyKey" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrganizationInvitation_email_normalized" CHECK (
    length("emailNormalized") > 2 AND "emailNormalized" = lower(btrim("emailNormalized"))
  ),
  CONSTRAINT "OrganizationInvitation_token_hash" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "OrganizationInvitation_expiry" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "OrganizationInvitation_acceptance_identity" CHECK (("acceptedAt" IS NULL) = ("acceptedBySubjectId" IS NULL)),
  CONSTRAINT "OrganizationInvitation_terminal_state" CHECK (NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "OrganizationInvitation"("tokenHash");
CREATE UNIQUE INDEX "OrganizationInvitation_tenantId_idempotencyKey_key"
  ON "OrganizationInvitation"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "OrganizationInvitation_tenantId_id_key"
  ON "OrganizationInvitation"("tenantId", "id");
CREATE INDEX "OrganizationInvitation_tenantId_emailNormalized_expiresAt_idx"
  ON "OrganizationInvitation"("tenantId", "emailNormalized", "expiresAt");

CREATE TABLE "InvitationWorkspaceGrant" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "invitationId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "role" "WorkspaceRole" NOT NULL,
  CONSTRAINT "InvitationWorkspaceGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvitationWorkspaceGrant_invitationId_workspaceId_key"
  ON "InvitationWorkspaceGrant"("invitationId", "workspaceId");
CREATE INDEX "InvitationWorkspaceGrant_tenantId_workspaceId_idx"
  ON "InvitationWorkspaceGrant"("tenantId", "workspaceId");

ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_organization_member_fkey"
  FOREIGN KEY ("tenantId", "subjectId") REFERENCES "OrganizationMembership"("tenantId", "subjectId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMembership" ADD CONSTRAINT "WorkspaceMembership_workspace_fkey"
  FOREIGN KEY ("tenantId", "workspaceId") REFERENCES "Workspace"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvitationWorkspaceGrant" ADD CONSTRAINT "InvitationWorkspaceGrant_invitation_fkey"
  FOREIGN KEY ("tenantId", "invitationId") REFERENCES "OrganizationInvitation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvitationWorkspaceGrant" ADD CONSTRAINT "InvitationWorkspaceGrant_workspace_fkey"
  FOREIGN KEY ("tenantId", "workspaceId") REFERENCES "Workspace"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TenantErasureRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "tenantHash" TEXT NOT NULL,
  "requestedBySubjectHash" TEXT NOT NULL,
  "pseudonymKeyVersion" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "GovernanceJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "resultSummary" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "TenantErasureRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantErasureRequest_tenant_hash" CHECK ("tenantHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TenantErasureRequest_subject_hash" CHECK ("requestedBySubjectHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "TenantErasureRequest_key_version" CHECK (length(btrim("pseudonymKeyVersion")) > 0),
  CONSTRAINT "TenantErasureRequest_live_tenant" CHECK ("status" = 'SUCCEEDED' OR "tenantId" IS NOT NULL),
  CONSTRAINT "TenantErasureRequest_completed" CHECK (("status" = 'SUCCEEDED') = ("completedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "TenantErasureRequest_tenantHash_idempotencyKey_key"
  ON "TenantErasureRequest"("tenantHash", "idempotencyKey");
CREATE INDEX "TenantErasureRequest_status_availableAt_leaseExpiresAt_idx"
  ON "TenantErasureRequest"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "TenantErasureRequest_tenantHash_createdAt_idx"
  ON "TenantErasureRequest"("tenantHash", "createdAt");

CREATE TABLE "TenantErasureStep" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "status" "GovernanceStepStatus" NOT NULL DEFAULT 'PENDING',
  "deletedCount" BIGINT NOT NULL DEFAULT 0,
  "checkpoint" JSONB NOT NULL DEFAULT '{}',
  "legalBasis" TEXT,
  "lastError" TEXT,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "TenantErasureStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantErasureStep_legal_hold_basis" CHECK ("status" <> 'SKIPPED_LEGAL_HOLD' OR length(btrim(COALESCE("legalBasis", ''))) > 0)
);

CREATE UNIQUE INDEX "TenantErasureStep_requestId_resourceKind_key"
  ON "TenantErasureStep"("requestId", "resourceKind");
CREATE INDEX "TenantErasureStep_requestId_status_idx"
  ON "TenantErasureStep"("requestId", "status");
ALTER TABLE "TenantErasureStep" ADD CONSTRAINT "TenantErasureStep_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "TenantErasureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RetentionPolicy" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "scopeKey" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "retentionDays" INTEGER NOT NULL,
  "deletionGraceDays" INTEGER NOT NULL DEFAULT 7,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedBySubjectId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetentionPolicy_scope" CHECK (
    ("tenantId" IS NULL AND "scopeKey" = 'GLOBAL') OR
    ("tenantId" IS NOT NULL AND "scopeKey" = 'tenant:' || "tenantId")
  ),
  CONSTRAINT "RetentionPolicy_days" CHECK ("retentionDays" >= 1 AND "deletionGraceDays" >= 0),
  CONSTRAINT "RetentionPolicy_version" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "RetentionPolicy_scopeKey_resourceKind_key"
  ON "RetentionPolicy"("scopeKey", "resourceKind");
CREATE INDEX "RetentionPolicy_enabled_nextRunAt_idx" ON "RetentionPolicy"("enabled", "nextRunAt");
CREATE INDEX "RetentionPolicy_tenantId_resourceKind_idx" ON "RetentionPolicy"("tenantId", "resourceKind");

CREATE TABLE "RetentionRun" (
  "id" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "tenantId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" "GovernanceJobStatus" NOT NULL DEFAULT 'PENDING',
  "cutoffAt" TIMESTAMPTZ(3) NOT NULL,
  "cursor" JSONB NOT NULL DEFAULT '{}',
  "deletedCount" BIGINT NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "RetentionRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RetentionRun_counts" CHECK ("deletedCount" >= 0 AND "attempts" >= 0)
);

CREATE UNIQUE INDEX "RetentionRun_policyId_idempotencyKey_key"
  ON "RetentionRun"("policyId", "idempotencyKey");
CREATE INDEX "RetentionRun_status_availableAt_leaseExpiresAt_idx"
  ON "RetentionRun"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "RetentionRun_tenantId_createdAt_idx" ON "RetentionRun"("tenantId", "createdAt");
ALTER TABLE "RetentionRun" ADD CONSTRAINT "RetentionRun_policyId_fkey"
  FOREIGN KEY ("policyId") REFERENCES "RetentionPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Serialize each tenant's audit appends under a row lock. The event payload stored alongside the
-- digest is the exact UTF-8 input used by offline verifiers; verifiers never need to reproduce
-- PostgreSQL JSON formatting.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "audit_chain_heads" (
  "tenant_id" TEXT NOT NULL,
  "last_sequence" BIGINT NOT NULL DEFAULT 0,
  "last_hash" TEXT NOT NULL DEFAULT '',
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "audit_chain_heads_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "audit_chain_anchors" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "chain_sequence" BIGINT NOT NULL,
  "event_hash" TEXT NOT NULL,
  "signer_key_id" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "external_ref" TEXT NOT NULL,
  "anchored_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_chain_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_chain_anchors_hash" CHECK ("event_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audit_chain_anchors_signature" CHECK (length("signature") >= 16),
  CONSTRAINT "audit_chain_anchors_external_ref" CHECK (length(btrim("external_ref")) > 0)
);
CREATE UNIQUE INDEX "audit_chain_anchors_tenant_sequence_key"
  ON "audit_chain_anchors"("tenant_id", "chain_sequence");
CREATE INDEX "audit_chain_anchors_tenant_anchored_idx"
  ON "audit_chain_anchors"("tenant_id", "anchored_at");

ALTER TABLE "security_audit_events"
  ADD COLUMN "chain_sequence" BIGINT,
  ADD COLUMN "previous_hash" TEXT,
  ADD COLUMN "event_hash" TEXT,
  ADD COLUMN "canonical_payload" TEXT,
  ADD COLUMN "canonical_version" INTEGER NOT NULL DEFAULT 1;

DO $backfill$
DECLARE
  tenant_row RECORD;
  event_row RECORD;
  next_sequence BIGINT;
  prior_hash TEXT;
  payload TEXT;
  digest_hex TEXT;
BEGIN
  FOR tenant_row IN SELECT DISTINCT "tenant_id" FROM "security_audit_events" ORDER BY "tenant_id" LOOP
    next_sequence := 0;
    prior_hash := '';
    FOR event_row IN
      SELECT * FROM "security_audit_events"
      WHERE "tenant_id" = tenant_row."tenant_id"
      ORDER BY "occurred_at", "id"
    LOOP
      next_sequence := next_sequence + 1;
      payload := jsonb_build_object(
        'action', event_row."action",
        'actorUserId', event_row."actor_user_id",
        'canonicalVersion', 1,
        'id', event_row."id",
        'metadata', event_row."metadata",
        'occurredAt', to_char(event_row."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'targetId', event_row."target_id",
        'targetType', event_row."target_type",
        'tenantId', event_row."tenant_id",
        'workspaceId', event_row."workspace_id"
      )::text;
      digest_hex := encode(digest(convert_to(prior_hash || E'\n' || payload, 'UTF8'), 'sha256'), 'hex');
      UPDATE "security_audit_events"
      SET "chain_sequence" = next_sequence,
          "previous_hash" = prior_hash,
          "event_hash" = digest_hex,
          "canonical_payload" = payload
      WHERE "id" = event_row."id";
      prior_hash := digest_hex;
    END LOOP;
    INSERT INTO "audit_chain_heads" ("tenant_id", "last_sequence", "last_hash", "updated_at")
    VALUES (tenant_row."tenant_id", next_sequence, prior_hash, clock_timestamp());
  END LOOP;
END
$backfill$;

ALTER TABLE "security_audit_events"
  ALTER COLUMN "chain_sequence" SET NOT NULL,
  ALTER COLUMN "previous_hash" SET NOT NULL,
  ALTER COLUMN "event_hash" SET NOT NULL,
  ALTER COLUMN "canonical_payload" SET NOT NULL;

CREATE UNIQUE INDEX "security_audit_events_tenant_sequence_key"
  ON "security_audit_events"("tenant_id", "chain_sequence");
ALTER TABLE "security_audit_events" ADD CONSTRAINT "security_audit_events_hash_format"
  CHECK ("event_hash" ~ '^[0-9a-f]{64}$' AND ("previous_hash" = '' OR "previous_hash" ~ '^[0-9a-f]{64}$'));

CREATE FUNCTION sentinel_chain_audit_event() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  head_sequence BIGINT;
  head_hash TEXT;
BEGIN
  INSERT INTO public."audit_chain_heads" ("tenant_id", "last_sequence", "last_hash", "updated_at")
  VALUES (NEW."tenant_id", 0, '', clock_timestamp())
  ON CONFLICT ("tenant_id") DO NOTHING;

  SELECT "last_sequence", "last_hash" INTO head_sequence, head_hash
  FROM public."audit_chain_heads"
  WHERE "tenant_id" = NEW."tenant_id"
  FOR UPDATE;

  NEW."canonical_version" := 1;
  NEW."chain_sequence" := head_sequence + 1;
  NEW."previous_hash" := head_hash;
  NEW."canonical_payload" := jsonb_build_object(
    'action', NEW."action",
    'actorUserId', NEW."actor_user_id",
    'canonicalVersion', 1,
    'id', NEW."id",
    'metadata', NEW."metadata",
    'occurredAt', to_char(NEW."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'targetId', NEW."target_id",
    'targetType', NEW."target_type",
    'tenantId', NEW."tenant_id",
    'workspaceId', NEW."workspace_id"
  )::text;
  NEW."event_hash" := encode(digest(convert_to(head_hash || E'\n' || NEW."canonical_payload", 'UTF8'), 'sha256'), 'hex');

  UPDATE public."audit_chain_heads"
  SET "last_sequence" = NEW."chain_sequence", "last_hash" = NEW."event_hash", "updated_at" = clock_timestamp()
  WHERE "tenant_id" = NEW."tenant_id";
  RETURN NEW;
END
$function$;

CREATE TRIGGER security_audit_events_chain_before_insert
  BEFORE INSERT ON "security_audit_events"
  FOR EACH ROW EXECUTE FUNCTION sentinel_chain_audit_event();

CREATE FUNCTION sentinel_reject_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'security_audit_events is append-only';
END
$function$;

CREATE TRIGGER security_audit_events_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "security_audit_events"
  FOR EACH ROW EXECUTE FUNCTION sentinel_reject_audit_mutation();
CREATE TRIGGER security_audit_events_no_truncate
  BEFORE TRUNCATE ON "security_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION sentinel_reject_audit_mutation();

CREATE TRIGGER audit_chain_anchors_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "audit_chain_anchors"
  FOR EACH ROW EXECUTE FUNCTION sentinel_reject_audit_mutation();
CREATE TRIGGER audit_chain_anchors_no_truncate
  BEFORE TRUNCATE ON "audit_chain_anchors"
  FOR EACH STATEMENT EXECUTE FUNCTION sentinel_reject_audit_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON "security_audit_events" FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "audit_chain_heads" FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_chain_anchors" FROM PUBLIC;
