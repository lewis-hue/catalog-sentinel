-- Cross-tenant access grant (docs/multi-tenancy.md). A verified OIDC token proves WHO the caller
-- is; only an active row here proves WHICH shared tenant they may act in. Personal tenants
-- (tenant_id = subject) need no row and are not stored. `role`/`status` are text (not the UserRole
-- enum) so the runtime raw-SQL adapter reads them as `text`; the application validates the values.
-- `id` is a deterministic id (mbr_<hash of user,tenant> for members; a stable id for invites), so a
-- re-invite or a repeated login upserts on the primary key rather than duplicating a grant.

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "invited_email" TEXT,
    "invited_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memberships_user_status_idx" ON "memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "memberships_tenant_idx" ON "memberships"("tenant_id");
