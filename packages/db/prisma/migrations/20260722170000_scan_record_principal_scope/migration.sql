-- Principal/workspace ownership for durable scan history.
-- Existing rows intentionally remain NULL: assigning them to whichever user first reads them
-- would be an ownership takeover. Tenant administrators can migrate/delete those rows while
-- authenticated ordinary users cannot enumerate them.
ALTER TABLE "scan_records"
    ADD COLUMN IF NOT EXISTS "owner_user_id" TEXT,
    ADD COLUMN IF NOT EXISTS "artist_workspace_id" TEXT;

CREATE INDEX IF NOT EXISTS "scan_records_tenant_owner_created_idx"
    ON "scan_records" ("tenant_id", "owner_user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "scan_records_tenant_workspace_created_idx"
    ON "scan_records" ("tenant_id", "artist_workspace_id", "created_at" DESC);
