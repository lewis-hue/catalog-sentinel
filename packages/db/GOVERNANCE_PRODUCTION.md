# Production governance adapters

`createProductionGovernanceAdapters` is the only production composition for retention and tenant
erasure. It constructs concrete PostgreSQL, versioned S3, Secrets Manager, BullMQ, Redis, Steel,
Keycloak, observability, AWS Backup, and finite audit-hold adapters. Construction or readiness
fails if a mandatory integration is absent; an HTTP success without a resource-bound completion
receipt is not treated as erasure.

The maintenance process must construct `ProductionGovernanceMaintenanceService` with
`adapters.auditLegalHold` as its `ExpiredAuditHoldPurger`, call `verifyReady()` before advertising
readiness, and run maintenance cycles continuously. A cycle publishes due audit anchors before it
processes legally expired audit manifests.

## Mandatory configuration

- AWS: `AWS_REGION`, `AWS_ACCOUNT_ID`, `KMS_KEY_ID`, `GOVERNANCE_HMAC_KMS_KEY_ID`,
  `AUDIT_SIGNING_KMS_KEY_ID`, `ARTIFACT_KMS_KEY_ID`, `AUDIT_EXPORT_KMS_KEY_ID`,
  `ARTIFACT_S3_BUCKET`, `AUDIT_EXPORT_S3_BUCKET`, and optional `AUDIT_EXPORT_S3_PREFIX`.
  Every key setting must be a full immutable key ARN in the configured account/region.
- Artifact recovery: `GOVERNANCE_ARTIFACT_BUCKETS` is a JSON array containing every primary and
  replicated `{region,name,kmsKeyId}` bucket. Version-specific S3 source deletion is not assumed to
  erase replica versions; every configured bucket must independently confirm exact-key erasure.
- Queue/cache: TLS `REDIS_URL` and explicit JSON `GOVERNANCE_BULLMQ_QUEUES`. The list must contain
  every name in `REQUIRED_GOVERNANCE_QUEUE_NAMES`; queue discovery by convention is forbidden.
- Steel: `STEEL_CONNECTOR_MODE`, `STEEL_API_URL` when not using the cloud default, and
  `STEEL_API_KEY` for cloud. Erasure releases the real `/v1/sessions/{id}/release` handle and the
  handle must have been stored as a KMS envelope, never as a raw remote id.
- Identity: `KEYCLOAK_ADMIN_BASE_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ERASURE_CLIENT_ID`,
  `KEYCLOAK_ERASURE_CLIENT_SECRET_ARN`, and optional `KEYCLOAK_ERASURE_CLIENT_SECRET_JSON_KEY`.
- Observability: `OBSERVABILITY_ERASURE_URL`, `OBSERVABILITY_ERASURE_READINESS_URL`,
  `OBSERVABILITY_ERASURE_TOKEN_SECRET_ARN`, and optional
  `OBSERVABILITY_ERASURE_TOKEN_SECRET_JSON_KEY`.
- Finite holds: `GOVERNANCE_BACKUP_VAULTS` (JSON objects containing every primary and DR
  `{region,name}` vault), `BACKUP_RETENTION_DAYS`,
  `BACKUP_LEGAL_BASIS_REFERENCE`, `AUDIT_RETENTION_DAYS`, and
  `AUDIT_LEGAL_BASIS_REFERENCE`. Backup retention is 35–3,650 days and audit retention is
  365–3,650 days, matching the production Vault Lock and template bounds.
- Bounds: optional `GOVERNANCE_ADAPTER_BATCH_SIZE`, `GOVERNANCE_EXTERNAL_TIMEOUT_MS`, and
  `GOVERNANCE_AWS_MAX_ATTEMPTS`.

AWS endpoint overrides are rejected. Production envelope encryption rejects local master keys.

## Required AWS authorization

Use separate workload roles where possible. Scope bucket actions to the two named buckets/prefixes,
KMS actions to the named key ARNs, integration-secret reads to exact ARNs, and tenant-secret
deletion to a dedicated path and mandatory tenant/application resource tags.

- S3 bucket: `s3:ListBucket`, `s3:ListBucketVersions`, `s3:GetBucketVersioning`,
  `s3:GetEncryptionConfiguration`; add `s3:GetBucketObjectLockConfiguration` for the audit bucket.
- S3 objects: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObjectVersion`; the audit prefix also needs
  `s3:PutObjectRetention`. Versioning must be enabled. The audit bucket must use Object Lock
  COMPLIANCE mode and both buckets must default to their configured KMS keys.
- Secrets Manager: `secretsmanager:GetSecretValue` for the exact Keycloak/observability secrets and
  tenant credential namespace; `secretsmanager:DeleteSecret` only for the tagged tenant credential
  namespace. Explicitly deny untagged and infrastructure secrets.
- AWS Backup: `backup:DescribeBackupVault` and `backup:ListRecoveryPointsByBackupVault` for the
  configured vault. Vault Lock must enforce a finite maximum retention.
- KMS: envelope key `kms:Encrypt`/`kms:Decrypt`; HMAC key `kms:GenerateMac`; signing key
  `kms:Sign`/`kms:Verify`; S3 keys `kms:GenerateDataKey` and `kms:Decrypt` as required by SSE-KMS.
  Key policies must also authorize the workload role and S3 use via the configured region/account.

Redis credentials need ACL access to `SCAN`, `GET`, `DEL`, `UNLINK`, and the BullMQ commands only
within this application's namespace. The Keycloak service account needs only user query/view/delete
capabilities in the configured realm. Its secret and the observability bearer token must be sourced
from Secrets Manager.

## Database capability and deployment order

Create a `NOLOGIN` role named `sentinel_governance_executor` before applying
`20260723010000_controlled_audit_expiry_purge`, grant that role to the dedicated governance database
user, and do not grant API roles direct mutation access to audit events, anchors, purge guards,
manifests, or receipts. The migration grants only the controlled prepare/purge functions and the
minimum anchor-outbox access when that role already exists. Confirm both function privileges during
readiness.

Quiesce old governance workers while applying this migration. Updated workers persist an exact KMS
signature before S3 publication and use a tenant advisory lock shared with audit append and purge.
At legal expiry, phase one commits an exact `audit_purge_manifests` inventory and freezes new audit
events/anchors. S3 deletion is idempotent and verified; phase two then deletes the matching database
chain and stores an immutable signed digest receipt. A crash at either boundary resumes from the
outbox/manifest without changing the inventory.

## External contracts that must exist before release

- The observability erasure endpoint must be backed by tenant-partitioned logs/indices. CloudWatch
  Logs alone cannot selectively delete individual tenant events. Readiness must attest
  `ready=true`, `supportsSelectiveTenantErasure=true`, and `identifier=raw-tenant-id-v1`; completion
  must return the same request/digest, `remainingCount=0`, and a durable receipt id.
- Keycloak users must carry an exact multi-valued `tenant_id` attribute. A tenant-exclusive user is
  deleted; a shared human identity is preserved and only the erased tenant value is removed while
  retaining every other attribute and tenant binding.
- Backups must be aggregate encrypted recovery points with lifecycle `DeleteAt` populated for every
  live recovery point. Selective deletion is represented only as a finite legal hold, never as an
  immediate-success claim.
- S3 lifecycle/replication, observability archives, SIEM exports, support exports, and DR copies must
  preserve the same tenant erasure contract. Readiness must fail until every destination is covered.

Legal/DPA approval, production credentials, an authorized real distributor account, and cloud DR
evidence are release evidence supplied by the operator; code must not fabricate them. Record their
approved references in the legal-basis variables and release evidence package.
