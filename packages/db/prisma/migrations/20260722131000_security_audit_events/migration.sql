-- Append-only operational audit stream. It is deliberately not FK-bound to Tenant: the first
-- authenticated request for a newly provisioned identity must be auditable before tenant setup.
CREATE TABLE "security_audit_events" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "actor_user_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "security_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_audit_events_tenant_id_occurred_at_idx"
    ON "security_audit_events"("tenant_id", "occurred_at");
CREATE INDEX "security_audit_events_target_type_target_id_idx"
    ON "security_audit_events"("target_type", "target_id");
