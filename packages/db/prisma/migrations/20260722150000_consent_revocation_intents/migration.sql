-- A durable transactional outbox for revoking live Steel authority. The consent JSON row and
-- this intent are written by one SQL statement, so a process crash cannot lose cleanup work.
CREATE TABLE "ConsentRevocationIntent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "artistWorkspaceId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ConsentRevocationIntent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConsentRevocationIntent_artistWorkspaceId_nonempty" CHECK ("artistWorkspaceId" <> '')
);

CREATE UNIQUE INDEX "ConsentRevocationIntent_tenantId_consentId_key"
    ON "ConsentRevocationIntent"("tenantId", "consentId");

CREATE INDEX "ConsentRevocationIntent_availableAt_leaseExpiresAt_idx"
    ON "ConsentRevocationIntent"("availableAt", "leaseExpiresAt");

-- Pollers never need terminal rows. This stays small as completed history grows and is the index
-- used by the due-work SKIP LOCKED query (Prisma cannot currently declare partial indexes).
CREATE INDEX "ConsentRevocationIntent_pending_due_idx"
    ON "ConsentRevocationIntent"("availableAt", "leaseExpiresAt", "createdAt")
    WHERE "completedAt" IS NULL;

CREATE INDEX "ConsentRevocationIntent_tenantId_completedAt_idx"
    ON "ConsentRevocationIntent"("tenantId", "completedAt");

-- Deployments may already contain revoked JSON consents from before the outbox existed. Queue
-- those rows immediately so the reconciler can release any surviving Steel authority after the
-- migration. Use a deterministic id to keep replays/idempotent restores safe, and tolerate legacy
-- rows whose workspace proof predates the current schema (cleanup only needs tenant + consent).
INSERT INTO "ConsentRevocationIntent" (
    "id", "tenantId", "consentId", "artistWorkspaceId", "attempts",
    "availableAt", "leaseToken", "leaseExpiresAt", "lastError", "completedAt",
    "createdAt", "updatedAt"
)
SELECT
    'consent-revoke-backfill-' || md5(length(record."tenantId")::text || ':' || record."tenantId" || ':' || record."id"),
    record."tenantId",
    record."id",
    COALESCE(NULLIF(record."dataJson"->>'artistWorkspaceId', ''), 'legacy-unknown'),
    0,
    CURRENT_TIMESTAMP,
    NULL,
    NULL,
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "DistributorLinkRecord" AS record
WHERE record."kind" = 'consent'
  AND NULLIF(record."dataJson"->>'revokedAt', '') IS NOT NULL
ON CONFLICT ("tenantId", "consentId") DO NOTHING;
