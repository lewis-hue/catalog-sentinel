-- Canonical durable search/scan projection.
--
-- Older releases created this table from the application process. IF NOT EXISTS allows those
-- deployments to adopt the table into the migration history without dropping retained scans.
-- Runtime application roles no longer receive schema-creation privileges.
CREATE TABLE IF NOT EXISTS "scan_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL DEFAULT 'default',
    "artist" TEXT NOT NULL,
    "distributor" TEXT NOT NULL,
    "deep_scan_status" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "record" JSONB NOT NULL,

    CONSTRAINT "scan_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "scan_records_created_idx"
    ON "scan_records" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "scan_records_tenant_created_idx"
    ON "scan_records" ("tenant_id", "created_at" DESC);
