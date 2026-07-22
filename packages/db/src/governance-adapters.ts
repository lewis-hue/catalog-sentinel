import { createHash } from 'node:crypto';
import {
  BackupClient,
  DescribeBackupVaultCommand,
  ListRecoveryPointsByBackupVaultCommand,
} from '@aws-sdk/client-backup';
import {
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  envelopeEncryptorFromEnv,
  type EnvelopeCrypto,
} from '@sentinel/security';
import type { GovernanceSqlClient, GovernanceSqlPool } from './governance-types';
import { GovernanceConflictError, GovernanceValidationError } from './governance-types';
import type { AuditAnchorSigner } from './audit-chain';
import type { RetentionAdapter, RetentionResourceKind } from './retention';
import type {
  TenantErasureAdapter,
  TenantErasureBatchResult,
  TenantPseudonymizer,
} from './tenant-erasure';
import { PostgresTenantRowsErasureAdapter } from './tenant-erasure';

const DAY_MS = 86_400_000;
const DEFAULT_BATCH_SIZE = 100;
const BULL_JOB_TYPES = ['active', 'wait', 'waiting-children', 'prioritized', 'delayed', 'completed', 'failed', 'paused'] as const;
const TERMINAL_BULL_JOB_TYPES = ['completed', 'failed'] as const;

/** Every production queue known to the API/worker contract. Configuration may add queues. */
export const REQUIRED_GOVERNANCE_QUEUE_NAMES = [
  'store-presence-deep-scan',
  'distrokid-catalog-index',
  'distrokid-plan-chunks',
  'distrokid-release-chunk',
  'distrokid-retry-failed',
  'distrokid-reconcile',
  'distrokid-finalize',
] as const;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new GovernanceValidationError(`${name} is required for production governance adapters.`);
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new GovernanceValidationError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function boundedBatch(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new GovernanceValidationError('Governance adapter batch size must be an integer from 1 through 1000.');
  }
  return value;
}

function httpsUrl(value: string, name: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new GovernanceValidationError(`${name} must be an absolute HTTPS URL.`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new GovernanceValidationError(`${name} must be an absolute HTTPS URL without credentials or a fragment.`);
  }
  return parsed;
}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new GovernanceValidationError(`${name} is invalid.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new GovernanceValidationError(`${name} is invalid.`);
  return parsed.toISOString();
}

function cursorInteger(cursor: Record<string, unknown>, name: string, fallback = 0): number {
  const raw = cursor[name];
  if (raw === undefined) return fallback;
  if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw new GovernanceValidationError(`Invalid ${name} checkpoint.`);
  return Number(raw);
}

function cursorString(cursor: Record<string, unknown>, name: string, fallback = ''): string {
  const raw = cursor[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || raw.length > 4_096) throw new GovernanceValidationError(`Invalid ${name} checkpoint.`);
  return raw;
}

async function useClient<T>(pool: GovernanceSqlPool, work: (client: GovernanceSqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await work(client); }
  finally { client.release(); }
}

function tenantDigest(tenantId: string): string {
  return createHash('sha256').update(tenantId, 'utf8').digest('hex');
}

function requestSignal(timeoutMs: number): { signal: AbortSignal; close: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('governance backend deadline exceeded')), timeoutMs);
  timeout.unref?.();
  return { signal: controller.signal, close: () => clearTimeout(timeout) };
}

async function fetchJson(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
  accepted: readonly number[] = [200],
): Promise<{ status: number; body: unknown }> {
  const request = requestSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: request.signal });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { throw new Error('governance backend returned non-JSON data'); }
    }
    if (!accepted.includes(response.status)) throw new Error(`governance backend returned HTTP ${response.status}`);
    return { status: response.status, body };
  } finally {
    request.close();
  }
}

interface SqlDeleteStatement {
  readonly name: string;
  /** $1 tenant id (nullable for global policy), $2 cutoff, $3 batch size. */
  readonly sql: string;
}

const deleteById = (
  table: string,
  timestampExpression: string,
  tenantExpression: string,
  extra = 'TRUE',
): string => `
  WITH victims AS (
    SELECT target."id" FROM "${table}" AS target
    WHERE ($1::text IS NULL OR (${tenantExpression}) = $1)
      AND (${timestampExpression}) < $2::timestamptz AND (${extra})
    ORDER BY (${timestampExpression}), target."id"
    FOR UPDATE SKIP LOCKED LIMIT $3
  )
  DELETE FROM "${table}" AS target USING victims
  WHERE target."id" = victims."id" RETURNING target."id"`;

const workspaceTenant = `(
  SELECT workspace."tenantId" FROM "Workspace" AS workspace
  WHERE workspace."id" = target."workspaceId"
)`;

const SQL_RETENTION: Readonly<Record<Exclude<RetentionResourceKind, 'evidence_artifacts' | 'operational_jobs'>, readonly SqlDeleteStatement[]>> = {
  catalog_snapshots: [
    { name: 'network extraction snapshots', sql: deleteById('DistributorExtractionSnapshot', 'target."startedAt"', 'target."tenantId"') },
    { name: 'normalized distributor snapshots', sql: deleteById('DistributorCatalogSnapshot', 'target."createdAt"', 'target."tenantId"') },
    { name: 'legacy catalog snapshots', sql: deleteById('CatalogSnapshot', 'target."createdAt"', workspaceTenant) },
  ],
  scan_history: [
    { name: 'search history', sql: deleteById('scan_records', 'target."created_at"', 'target."tenant_id"') },
    { name: 'endpoint candidates', sql: deleteById('DistributorEndpointCandidate', 'target."firstSeenAt"', 'target."tenantId"') },
    { name: 'scan events', sql: deleteById('ScanEvent', 'target."at"', 'target."tenantId"') },
    {
      name: 'deep scan checkpoints',
      sql: deleteById(
        'DeepScanCheckpoint',
        'target."updatedAt"',
        'target."tenantId"',
        `EXISTS (
          SELECT 1 FROM "DeepScanRun" AS run WHERE run."id" = target."deepScanRunId"
            AND run."status" IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')
        )`,
      ),
    },
    {
      name: 'deep scan runs',
      sql: deleteById(
        'DeepScanRun',
        'target."createdAt"',
        'target."tenantId"',
        `target."status" IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED')`,
      ),
    },
    {
      name: 'legacy scan runs',
      sql: deleteById(
        'ScanRun',
        'target."createdAt"',
        workspaceTenant,
        `target."status" IN ('succeeded', 'failed', 'cancelled', 'partial')`,
      ),
    },
  ],
  browser_state: [
    {
      name: 'operational browser state',
      sql: deleteById(
        'DistributorLinkRecord',
        `COALESCE(NULLIF(target."dataJson"->>'expiresAt', '')::timestamptz, target."createdAt")`,
        'target."tenantId"',
        `target."kind" IN ('session', 'stateRef')
          AND NULLIF(target."dataJson"->>'expiresAt', '') IS NOT NULL
          AND NULLIF(target."dataJson"->>'expiresAt', '')::timestamptz <= clock_timestamp()`,
      ),
    },
    {
      name: 'browser state references',
      sql: deleteById('BrowserStateRef', 'target."expiresAt"', 'target."tenantId"', 'target."expiresAt" <= clock_timestamp()'),
    },
    {
      name: 'browser sessions',
      sql: deleteById('BrowserLinkSession', 'target."expiresAt"', 'target."tenantId"', 'target."expiresAt" <= clock_timestamp()'),
    },
  ],
  invitation_records: [
    {
      name: 'organization invitations',
      sql: deleteById(
        'OrganizationInvitation',
        'target."createdAt"',
        'target."tenantId"',
        `(target."expiresAt" <= clock_timestamp() OR target."revokedAt" IS NOT NULL OR target."acceptedAt" IS NOT NULL)`,
      ),
    },
  ],
};

/** Batched PostgreSQL retention for resources whose authority is PostgreSQL. */
export class PostgresResourceRetentionAdapter implements RetentionAdapter {
  readonly resourceKind: Exclude<RetentionResourceKind, 'evidence_artifacts' | 'operational_jobs'>;
  private readonly statements: readonly SqlDeleteStatement[];

  constructor(
    resourceKind: Exclude<RetentionResourceKind, 'evidence_artifacts' | 'operational_jobs'>,
    private readonly pool: GovernanceSqlPool,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {
    this.resourceKind = resourceKind;
    this.statements = SQL_RETENTION[resourceKind];
    boundedBatch(batchSize);
  }

  async deleteBefore(input: {
    tenantId: string | null;
    cutoffAt: string;
    cursor: Record<string, unknown>;
  }): Promise<{ done: boolean; deletedCount: bigint; cursor: Record<string, unknown> }> {
    const cutoffAt = isoDate(input.cutoffAt, 'retention cutoff');
    const statementIndex = cursorInteger(input.cursor, 'statementIndex');
    if (statementIndex >= this.statements.length) return { done: true, deletedCount: 0n, cursor: { statementIndex } };
    const statement = this.statements[statementIndex]!;
    const result = await useClient(this.pool, (client) => client.query<{ id: string }>(
      statement.sql,
      [input.tenantId, cutoffAt, this.batchSize],
    ));
    const count = result.rows.length;
    const nextIndex = count < this.batchSize ? statementIndex + 1 : statementIndex;
    return {
      done: nextIndex >= this.statements.length,
      deletedCount: BigInt(count),
      cursor: { statementIndex: nextIndex, statement: statement.name },
    };
  }
}

interface ArtifactRow {
  source: 'artifact' | 'support' | 'screenshot';
  id: string;
  objectRef: string;
}

interface S3ArtifactStoreConfig {
  bucket: string;
  kmsKeyId: string;
  batchSize: number;
  requireObjectLock?: boolean;
}

function parseS3ObjectRef(row: ArtifactRow, expectedBucket: string): string {
  if (row.source === 'artifact' && !row.objectRef.startsWith('s3://')) {
    const key = row.objectRef.replace(/^\/+/, '');
    if (!key || key.includes('\0')) throw new GovernanceConflictError('An artifact has an invalid object key.');
    return key;
  }
  const withoutQuery = row.objectRef.split('?', 1)[0]!;
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(withoutQuery);
  if (!match || match[1] !== expectedBucket || !match[2] || match[2].includes('\0')) {
    throw new GovernanceConflictError('An artifact reference is not in the configured production S3 bucket.');
  }
  return match[2];
}

/** Deletes every version and delete marker for an exact key, then verifies the version inventory is empty. */
export class VersionedS3ObjectEraser {
  constructor(private readonly client: S3Client, private readonly config: S3ArtifactStoreConfig) {
    boundedBatch(config.batchSize);
  }

  async verifyReady(): Promise<void> {
    const [versioning, encryption, , objectLock] = await Promise.all([
      this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket })),
      this.client.send(new GetBucketEncryptionCommand({ Bucket: this.config.bucket })),
      this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket })),
      this.config.requireObjectLock
        ? this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }))
        : Promise.resolve(null),
    ]);
    if (versioning.Status !== 'Enabled') throw new Error('Artifact S3 bucket versioning must be enabled for verifiable erasure.');
    const rules = encryption.ServerSideEncryptionConfiguration?.Rules ?? [];
    const configured = rules.some((rule) =>
      rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms'
      && rule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID === this.config.kmsKeyId);
    if (!configured) throw new Error('Artifact S3 bucket default encryption must use ARTIFACT_KMS_KEY_ID.');
    if (this.config.requireObjectLock && objectLock?.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
      throw new Error('Immutable audit S3 bucket must have Object Lock enabled.');
    }
  }

  async eraseExactKey(key: string): Promise<bigint> {
    let deleted = 0n;
    for (;;) {
      const listed = await this.client.send(new ListObjectVersionsCommand({
        Bucket: this.config.bucket,
        Prefix: key,
        MaxKeys: 1_000,
      }));
      const objects = [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ].filter((entry) => entry.Key === key && entry.VersionId)
        .map((entry) => ({ Key: key, VersionId: entry.VersionId! }));
      if (objects.length === 0) break;
      const response = await this.client.send(new DeleteObjectsCommand({
        Bucket: this.config.bucket,
        Delete: { Objects: objects, Quiet: false },
      }));
      if ((response.Errors?.length ?? 0) > 0 || (response.Deleted?.length ?? 0) !== objects.length) {
        throw new Error('S3 did not confirm deletion of every requested object version.');
      }
      deleted += BigInt(objects.length);
    }

    const verification = await this.client.send(new ListObjectVersionsCommand({
      Bucket: this.config.bucket,
      Prefix: key,
      MaxKeys: 1_000,
    }));
    const remains = [...(verification.Versions ?? []), ...(verification.DeleteMarkers ?? [])]
      .some((entry) => entry.Key === key);
    if (remains) throw new Error('S3 object versions remain after erasure.');
    return deleted;
  }
}

const ARTIFACT_INVENTORY_SQL = `
  SELECT 'artifact'::text AS "source", artifact."id", artifact."objectKey" AS "objectRef"
  FROM "ObjectStorageArtifact" AS artifact
  WHERE ($1::text IS NULL OR artifact."tenantId" = $1)
    AND ($2::timestamptz IS NULL OR COALESCE(artifact."expiresAt", artifact."createdAt") < $2)
  UNION ALL
  SELECT 'support'::text AS "source", artifact."id", artifact."ref" AS "objectRef"
  FROM "SupportPacketArtifact" AS artifact
  JOIN "SupportPacket" AS packet ON packet."id" = artifact."packetId"
  JOIN "Workspace" AS workspace ON workspace."id" = packet."workspaceId"
  WHERE ($1::text IS NULL OR workspace."tenantId" = $1)
    AND ($2::timestamptz IS NULL OR packet."createdAt" < $2)
  UNION ALL
  SELECT 'screenshot'::text AS "source", evidence."id", evidence."screenshotRef" AS "objectRef"
  FROM "IssueEvidence" AS evidence
  JOIN "Workspace" AS workspace ON workspace."id" = evidence."workspaceId"
  WHERE evidence."screenshotRef" IS NOT NULL
    AND ($1::text IS NULL OR workspace."tenantId" = $1)
    AND ($2::timestamptz IS NULL OR evidence."createdAt" < $2)
  ORDER BY "source", "id" LIMIT $3`;

/** Shared S3-first deletion. Metadata is removed only after all exact S3 versions are gone. */
export class S3EvidenceRetentionAdapter implements RetentionAdapter {
  readonly resourceKind = 'evidence_artifacts' as const;

  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly stores: readonly { bucket: string; eraser: VersionedS3ObjectEraser }[],
    private readonly canonicalBucket: string,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {
    boundedBatch(batchSize);
    if (stores.length === 0 || !stores.some((store) => store.bucket === canonicalBucket)) {
      throw new GovernanceValidationError('S3 evidence erasure must include its canonical artifact bucket.');
    }
  }

  async deleteBefore(input: {
    tenantId: string | null;
    cutoffAt: string;
    cursor: Record<string, unknown>;
  }): Promise<{ done: boolean; deletedCount: bigint; cursor: Record<string, unknown> }> {
    const cutoff = isoDate(input.cutoffAt, 'retention cutoff');
    const rows = await this.load(input.tenantId, cutoff);
    let deleted = 0n;
    for (const row of rows) {
      const key = parseS3ObjectRef(row, this.canonicalBucket);
      // Version-specific source deletion does not delete pre-existing S3 replica versions. Every
      // declared recovery bucket must therefore confirm exact-key erasure before metadata is gone.
      for (const store of this.stores) await store.eraser.eraseExactKey(key);
      await this.removeMetadata(row, input.tenantId);
      deleted += 1n;
    }
    return { done: rows.length < this.batchSize, deletedCount: deleted, cursor: { pass: cursorInteger(input.cursor, 'pass') + 1 } };
  }

  private load(tenantId: string | null, cutoff: string | null): Promise<ArtifactRow[]> {
    return useClient(this.pool, async (client) =>
      (await client.query<ArtifactRow>(ARTIFACT_INVENTORY_SQL, [tenantId, cutoff, this.batchSize])).rows);
  }

  private async removeMetadata(row: ArtifactRow, tenantId: string | null): Promise<void> {
    const result = await useClient(this.pool, (client) => {
      if (row.source === 'artifact') {
        return client.query(`DELETE FROM "ObjectStorageArtifact" WHERE "id" = $1 AND ($2::text IS NULL OR "tenantId" = $2)`, [row.id, tenantId]);
      }
      if (row.source === 'support') {
        return client.query(
          `DELETE FROM "SupportPacketArtifact" AS artifact USING "SupportPacket" AS packet, "Workspace" AS workspace
           WHERE artifact."id" = $1 AND packet."id" = artifact."packetId" AND workspace."id" = packet."workspaceId"
             AND ($2::text IS NULL OR workspace."tenantId" = $2)`,
          [row.id, tenantId],
        );
      }
      return client.query(
        `UPDATE "IssueEvidence" AS evidence SET "screenshotRef" = NULL
         FROM "Workspace" AS workspace WHERE evidence."id" = $1 AND workspace."id" = evidence."workspaceId"
           AND ($2::text IS NULL OR workspace."tenantId" = $2)`,
        [row.id, tenantId],
      );
    });
    if ((result.rowCount ?? 0) !== 1) throw new GovernanceConflictError('Artifact metadata ownership changed during retention.');
  }
}

export class S3TenantObjectsErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'object_storage_objects' as const;

  constructor(
    private readonly retention: S3EvidenceRetentionAdapter,
  ) {}

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const result = await this.retention.deleteBefore({
      tenantId: input.tenantId,
      cutoffAt: '9999-12-31T23:59:59.999Z',
      cursor: input.checkpoint,
    });
    return { ...result, checkpoint: result.cursor };
  }
}

function isResourceNotFound(cause: unknown): boolean {
  const error = cause as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return error?.name === 'ResourceNotFoundException' || error?.Code === 'ResourceNotFoundException'
    || error?.$metadata?.httpStatusCode === 404;
}

function isPendingSecretDeletion(cause: unknown): boolean {
  const error = cause as { name?: string; Code?: string; message?: string };
  return (error?.name === 'InvalidRequestException' || error?.Code === 'InvalidRequestException')
    && /scheduled for deletion|marked for deletion/i.test(error.message ?? '');
}

export class AwsSecretsManagerTenantErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'secret_references' as const;

  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly client: SecretsManagerClient,
    private readonly region: string,
    private readonly accountId: string,
    private readonly batchSize = 25,
  ) { boundedBatch(batchSize); }

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const credentials = await useClient(this.pool, async (client) => (await client.query<{ id: string; secretHandle: string }>(
      `SELECT credential."id", credential."secretHandle"
       FROM "CredentialReference" AS credential
       JOIN "Workspace" AS workspace ON workspace."id" = credential."workspaceId"
       WHERE workspace."tenantId" = $1 ORDER BY credential."id" LIMIT $2`,
      [input.tenantId, this.batchSize],
    )).rows);
    let deleted = 0n;
    for (const credential of credentials) {
      const arn = credential.secretHandle;
      const match = /^arn:[a-z0-9-]+:secretsmanager:([^:]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/.exec(arn);
      if (!match || match[1] !== this.region || match[2] !== this.accountId) {
        throw new GovernanceConflictError('A credential reference is not an immutable Secrets Manager ARN in the configured account and region.');
      }
      try {
        await this.client.send(new DeleteSecretCommand({ SecretId: arn, ForceDeleteWithoutRecovery: true }));
      } catch (cause) {
        if (!isResourceNotFound(cause) && !isPendingSecretDeletion(cause)) {
          throw new Error('Secrets Manager could not delete a tenant secret.');
        }
      }
      let inaccessible = false;
      try { await this.client.send(new GetSecretValueCommand({ SecretId: arn })); }
      catch (cause) {
        if (isResourceNotFound(cause)) inaccessible = true;
        else if (isPendingSecretDeletion(cause)) inaccessible = false;
        else throw new Error('Secrets Manager could not verify tenant-secret erasure.');
      }
      if (!inaccessible) {
        return { done: false, deletedCount: deleted, checkpoint: { pendingSecretIdHash: createHash('sha256').update(arn).digest('hex') } };
      }
      const removed = await useClient(this.pool, (client) => client.query(
        `DELETE FROM "CredentialReference" AS credential USING "Workspace" AS workspace
         WHERE credential."id" = $1 AND workspace."id" = credential."workspaceId" AND workspace."tenantId" = $2`,
        [credential.id, input.tenantId],
      ));
      if ((removed.rowCount ?? 0) !== 1) throw new GovernanceConflictError('Credential ownership changed during secret erasure.');
      deleted += 1n;
    }
    return { done: credentials.length < this.batchSize, deletedCount: deleted, checkpoint: { pass: cursorInteger(input.checkpoint, 'pass') + 1 } };
  }
}

interface GovernanceQueueJob {
  id?: string;
  data: unknown;
  timestamp?: number;
  finishedOn?: number;
  remove(options?: { removeChildren?: boolean }): Promise<void>;
}

interface QueueCursor {
  queueIndex: number;
  offset: number;
}

function queueCursor(value: Record<string, unknown>): QueueCursor {
  return {
    queueIndex: cursorInteger(value, 'queueIndex'),
    offset: cursorInteger(value, 'offset'),
  };
}

function jobTenant(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).tenantId;
  return typeof value === 'string' ? value : null;
}

function jobSteelHandle(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = (data as Record<string, unknown>).steelSessionId;
  return typeof value === 'string' && value ? value : null;
}

/** Bounded tenant-aware inspection/removal over every configured BullMQ queue. */
export class BullMqTenantJobInventory {
  constructor(
    private readonly queues: readonly Queue[],
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) { boundedBatch(batchSize); }

  async verifyReady(): Promise<void> {
    await Promise.all(this.queues.map(async (queue) => {
      await queue.getJobCounts('active', 'wait', 'delayed', 'completed', 'failed');
    }));
  }

  async eraseTenantBatch(tenantId: string, cursorValue: Record<string, unknown>): Promise<TenantErasureBatchResult> {
    const cursor = queueCursor(cursorValue);
    if (cursor.queueIndex >= this.queues.length) {
      return { done: true, deletedCount: 0n, checkpoint: { queueIndex: cursor.queueIndex, offset: 0 } };
    }
    const queue = this.queues[cursor.queueIndex]!;
    const jobs = await queue.getJobs(
      [...BULL_JOB_TYPES] as never,
      cursor.offset,
      cursor.offset + this.batchSize - 1,
      true,
    ) as unknown as GovernanceQueueJob[];
    let deleted = 0n;
    for (const job of jobs) {
      if (jobTenant(job.data) !== tenantId) continue;
      try { await job.remove({ removeChildren: true }); }
      catch { throw new GovernanceConflictError(`Tenant BullMQ job ${job.id ?? '<unknown>'} is active or could not be removed.`); }
      deleted += 1n;
    }
    if (jobs.length < this.batchSize) {
      return {
        done: cursor.queueIndex + 1 >= this.queues.length,
        deletedCount: deleted,
        checkpoint: { queueIndex: cursor.queueIndex + 1, offset: 0 },
      };
    }
    // Removing jobs shifts the range. Re-read the same page when any match was removed.
    return {
      done: false,
      deletedCount: deleted,
      checkpoint: { queueIndex: cursor.queueIndex, offset: deleted > 0n ? cursor.offset : cursor.offset + this.batchSize },
    };
  }

  async deleteExpiredTenantJobs(
    tenantId: string | null,
    cutoffAt: string,
    cursorValue: Record<string, unknown>,
  ): Promise<{ done: boolean; deletedCount: bigint; cursor: Record<string, unknown> }> {
    const cutoff = new Date(cutoffAt).getTime();
    const cursor = queueCursor(cursorValue);
    if (cursor.queueIndex >= this.queues.length) {
      return { done: true, deletedCount: 0n, cursor: { queueIndex: cursor.queueIndex, offset: 0 } };
    }
    const queue = this.queues[cursor.queueIndex]!;
    const jobs = await queue.getJobs(
      [...TERMINAL_BULL_JOB_TYPES] as never,
      cursor.offset,
      cursor.offset + this.batchSize - 1,
      true,
    ) as unknown as GovernanceQueueJob[];
    let deleted = 0n;
    for (const job of jobs) {
      const finishedAt = job.finishedOn ?? job.timestamp ?? Number.POSITIVE_INFINITY;
      if (finishedAt >= cutoff || (tenantId !== null && jobTenant(job.data) !== tenantId)) continue;
      try { await job.remove({ removeChildren: true }); }
      catch { throw new GovernanceConflictError(`Expired BullMQ job ${job.id ?? '<unknown>'} could not be removed.`); }
      deleted += 1n;
    }
    if (jobs.length < this.batchSize) {
      return {
        done: cursor.queueIndex + 1 >= this.queues.length,
        deletedCount: deleted,
        cursor: { queueIndex: cursor.queueIndex + 1, offset: 0 },
      };
    }
    return {
      done: false,
      deletedCount: deleted,
      cursor: { queueIndex: cursor.queueIndex, offset: deleted > 0n ? cursor.offset : cursor.offset + this.batchSize },
    };
  }

  async collectTenantSteelHandles(
    tenantId: string,
    cursorValue: Record<string, unknown>,
  ): Promise<{ handles: string[]; done: boolean; cursor: Record<string, unknown> }> {
    const cursor = queueCursor(cursorValue);
    if (cursor.queueIndex >= this.queues.length) return { handles: [], done: true, cursor: { queueIndex: cursor.queueIndex, offset: 0 } };
    const queue = this.queues[cursor.queueIndex]!;
    const jobs = await queue.getJobs(
      [...BULL_JOB_TYPES] as never,
      cursor.offset,
      cursor.offset + this.batchSize - 1,
      true,
    ) as unknown as GovernanceQueueJob[];
    const handles = jobs
      .filter((job) => jobTenant(job.data) === tenantId)
      .map((job) => jobSteelHandle(job.data))
      .filter((value): value is string => value !== null);
    if (jobs.length < this.batchSize) {
      return {
        handles,
        done: cursor.queueIndex + 1 >= this.queues.length,
        cursor: { queueIndex: cursor.queueIndex + 1, offset: 0 },
      };
    }
    return { handles, done: false, cursor: { queueIndex: cursor.queueIndex, offset: cursor.offset + this.batchSize } };
  }

  async close(): Promise<void> {
    await Promise.all(this.queues.map((queue) => queue.close()));
  }
}

export class BullMqTenantErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'queue_jobs' as const;
  constructor(private readonly inventory: BullMqTenantJobInventory) {}
  erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    return this.inventory.eraseTenantBatch(input.tenantId, input.checkpoint);
  }
}

const OPERATIONAL_SQL: readonly SqlDeleteStatement[] = [
  {
    name: 'terminal durable DistroKid checkpoints',
    sql: `
      WITH victims AS (
        SELECT target."tenantId", target."connectionId", target."snapshotId"
        FROM "DistroKidSnapshotCheckpoint" AS target
        JOIN "DistroKidCheckpointTerminal" AS terminal
          USING ("tenantId", "connectionId", "snapshotId")
        WHERE ($1::text IS NULL OR target."tenantId" = $1)
          AND terminal."createdAt" < $2::timestamptz
        ORDER BY terminal."createdAt", target."tenantId", target."connectionId", target."snapshotId"
        FOR UPDATE OF target SKIP LOCKED LIMIT $3
      )
      DELETE FROM "DistroKidSnapshotCheckpoint" AS target USING victims
      WHERE target."tenantId" = victims."tenantId"
        AND target."connectionId" = victims."connectionId"
        AND target."snapshotId" = victims."snapshotId"
      RETURNING target."snapshotId" AS "id"`,
  },
  {
    name: 'completed consent revocation intents',
    sql: deleteById(
      'ConsentRevocationIntent',
      'target."completedAt"',
      'target."tenantId"',
      'target."completedAt" IS NOT NULL',
    ),
  },
  {
    name: 'terminal retention runs',
    sql: deleteById(
      'RetentionRun',
      'target."completedAt"',
      'target."tenantId"',
      `target."completedAt" IS NOT NULL AND target."status" IN ('SUCCEEDED', 'CANCELLED')`,
    ),
  },
];

export class OperationalJobsRetentionAdapter implements RetentionAdapter {
  readonly resourceKind = 'operational_jobs' as const;

  constructor(
    private readonly queues: BullMqTenantJobInventory,
    private readonly pool: GovernanceSqlPool,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) { boundedBatch(batchSize); }

  async deleteBefore(input: {
    tenantId: string | null;
    cutoffAt: string;
    cursor: Record<string, unknown>;
  }): Promise<{ done: boolean; deletedCount: bigint; cursor: Record<string, unknown> }> {
    const cutoffAt = isoDate(input.cutoffAt, 'retention cutoff');
    const phase = cursorString(input.cursor, 'phase', 'queues');
    if (phase === 'queues') {
      const queueResult = await this.queues.deleteExpiredTenantJobs(input.tenantId, cutoffAt, input.cursor);
      if (!queueResult.done) return { ...queueResult, cursor: { phase, ...queueResult.cursor } };
      return { done: false, deletedCount: queueResult.deletedCount, cursor: { phase: 'postgres', statementIndex: 0 } };
    }
    if (phase !== 'postgres') throw new GovernanceValidationError('Invalid operational-jobs retention phase.');
    const statementIndex = cursorInteger(input.cursor, 'statementIndex');
    if (statementIndex >= OPERATIONAL_SQL.length) return { done: true, deletedCount: 0n, cursor: input.cursor };
    const statement = OPERATIONAL_SQL[statementIndex]!;
    const result = await useClient(this.pool, (client) => client.query<{ id: string }>(
      statement.sql,
      [input.tenantId, cutoffAt, this.batchSize],
    ));
    const next = result.rows.length < this.batchSize ? statementIndex + 1 : statementIndex;
    return {
      done: next >= OPERATIONAL_SQL.length,
      deletedCount: BigInt(result.rows.length),
      cursor: { phase, statementIndex: next, statement: statement.name },
    };
  }
}

interface StoredConnectEnvelope {
  tenantId?: unknown;
  encryptedSession?: unknown;
}

interface DecryptedConnectSession {
  tenantId?: unknown;
  steelSessionId?: unknown;
  consentId?: unknown;
}

export class SteelTenantSessionErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'steel_sessions' as const;

  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly redis: Redis,
    private readonly queues: BullMqTenantJobInventory,
    private readonly envelope: EnvelopeCrypto,
    private readonly baseUrl: URL,
    private readonly apiKey: string | null,
    private readonly requestTimeoutMs: number,
    private readonly scanCount = DEFAULT_BATCH_SIZE,
  ) { boundedBatch(scanCount); }

  async verifyReady(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Steel-Api-Key'] = this.apiKey;
    const url = new URL('/v1/sessions?limit=1', this.baseUrl);
    await fetchJson(url, { method: 'GET', headers }, this.requestTimeoutMs, [200]);
  }

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const phase = cursorString(input.checkpoint, 'phase', 'redis');
    if (phase === 'redis') {
      const cursor = cursorString(input.checkpoint, 'redisCursor', '0');
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'sentinel:connect-session:*', 'COUNT', this.scanCount);
      let released = 0n;
      for (const key of keys) {
        if (key.endsWith(':claims') || key.includes(':by-consent:') || key.includes(':revoked-consent')) continue;
        const raw = await this.redis.get(key);
        if (!raw) continue;
        let stored: StoredConnectEnvelope;
        try { stored = JSON.parse(raw) as StoredConnectEnvelope; }
        catch { continue; }
        if (stored.tenantId !== input.tenantId || typeof stored.encryptedSession !== 'string') continue;
        const decoded = await this.envelope.decrypt(stored.encryptedSession);
        const session = JSON.parse(decoded) as DecryptedConnectSession;
        if (session.tenantId !== input.tenantId || typeof session.steelSessionId !== 'string') {
          throw new GovernanceConflictError('A tenant Steel handoff has an invalid encrypted ownership binding.');
        }
        await this.releaseHandle(session.steelSessionId);
        released += 1n;
      }
      if (next !== '0') return { done: false, deletedCount: released, checkpoint: { phase, redisCursor: next } };
      return { done: false, deletedCount: released, checkpoint: { phase: 'queues', queueIndex: 0, offset: 0 } };
    }
    if (phase === 'queues') {
      const batch = await this.queues.collectTenantSteelHandles(input.tenantId, input.checkpoint);
      let released = 0n;
      for (const handle of new Set(batch.handles)) {
        await this.releaseHandle(handle);
        released += 1n;
      }
      if (!batch.done) return { done: false, deletedCount: released, checkpoint: { phase, ...batch.cursor } };
      return { done: false, deletedCount: released, checkpoint: { phase: 'verify' } };
    }
    if (phase !== 'verify') throw new GovernanceValidationError('Invalid Steel erasure checkpoint phase.');
    const active = await useClient(this.pool, (client) => client.query<{ id: string }>(
      `SELECT "id" FROM "DistributorLinkRecord"
       WHERE "tenantId" = $1 AND "kind" = 'session'
         AND COALESCE(NULLIF("dataJson"->>'expiresAt', '')::timestamptz, 'infinity'::timestamptz) > clock_timestamp()
         AND COALESCE("dataJson"->>'status', '') NOT IN ('TERMINATED', 'EXPIRED', 'FAILED')
       LIMIT 1`,
      [input.tenantId],
    ));
    if (active.rows.length > 0) {
      throw new GovernanceConflictError('An active legacy Steel session has no durable remote handle; erasure will retry after its finite Steel lease expires.');
    }
    return { done: true, deletedCount: 0n, checkpoint: { phase: 'verified' } };
  }

  private async releaseHandle(value: string): Promise<void> {
    const remoteId = await this.remoteId(value);
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['Steel-Api-Key'] = this.apiKey;
    const url = new URL(`/v1/sessions/${encodeURIComponent(remoteId)}/release`, this.baseUrl);
    try { await fetchJson(url, { method: 'POST', headers }, this.requestTimeoutMs, [200, 201, 202, 204, 404, 410]); }
    catch { throw new Error('Steel did not confirm remote-session release.'); }
  }

  private async remoteId(value: string): Promise<string> {
    let current = value;
    let decrypted = false;
    for (let depth = 0; depth < 4; depth += 1) {
      if (current.startsWith('steel-handoff:')) {
        const plaintext = await this.envelope.decrypt(current.slice('steel-handoff:'.length));
        const payload = JSON.parse(plaintext) as { remoteId?: unknown };
        if (typeof payload.remoteId !== 'string' || !payload.remoteId) throw new Error('invalid Steel handoff');
        current = payload.remoteId;
        decrypted = true;
        break;
      }
      if (current.startsWith('v2.')) {
        current = await this.envelope.decrypt(current);
        decrypted = true;
        continue;
      }
      break;
    }
    if (!decrypted || !/^[A-Za-z0-9._-]{1,512}$/.test(current)) {
      throw new GovernanceConflictError('Steel session handles must be envelope-encrypted production handoffs.');
    }
    return current;
  }
}

function hasTenantBinding(value: unknown, tenantId: string, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => hasTenantBinding(entry, tenantId, depth + 1));
  const record = value as Record<string, unknown>;
  if (record.tenantId === tenantId || record.tenant_id === tenantId) return true;
  return Object.values(record).some((entry) => hasTenantBinding(entry, tenantId, depth + 1));
}

/**
 * Deletes the application's Redis projections and checkpoints. It never uses KEYS; bounded SCAN
 * passes repeat from cursor zero after mutation so Redis' weak cursor guarantees cannot skip data.
 */
export class RedisTenantKeysErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'redis_keys' as const;

  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly redis: Redis,
    private readonly envelope: EnvelopeCrypto,
    private readonly scanCount = DEFAULT_BATCH_SIZE,
  ) { boundedBatch(scanCount); }

  async verifyReady(): Promise<void> {
    if (await this.redis.ping() !== 'PONG') throw new Error('Redis governance readiness ping failed.');
  }

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const phase = cursorString(input.checkpoint, 'phase', 'snapshot_index');
    if (phase === 'snapshot_index') return this.eraseKnownSnapshots(input);
    if (phase === 'search_index') return this.eraseKnownSearches(input);
    if (phase !== 'scan') throw new GovernanceValidationError('Invalid Redis erasure checkpoint phase.');
    return this.scanRedis(input);
  }

  private async eraseKnownSnapshots(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const lastId = cursorString(input.checkpoint, 'lastId');
    const rows = await useClient(this.pool, async (client) => (await client.query<{ id: string; snapshotId: string }>(
      `SELECT inventory."id", inventory."snapshotId" FROM (
         SELECT 'extraction:' || snapshot."id" AS "id", snapshot."snapshotId"
         FROM "DistributorExtractionSnapshot" AS snapshot WHERE snapshot."tenantId" = $1
         UNION ALL
         SELECT 'checkpoint:' || checkpoint."snapshotId" AS "id", checkpoint."snapshotId"
         FROM "DistroKidSnapshotCheckpoint" AS checkpoint WHERE checkpoint."tenantId" = $1
       ) AS inventory
       WHERE inventory."id" > $2 ORDER BY inventory."id" LIMIT $3`,
      [input.tenantId, lastId, this.scanCount],
    )).rows);
    let deleted = 0n;
    for (const row of rows) deleted += await this.deleteSnapshotNamespace(row.snapshotId);
    if (rows.length < this.scanCount) {
      return { done: false, deletedCount: deleted, checkpoint: { phase: 'search_index', lastId: '' } };
    }
    return { done: false, deletedCount: deleted, checkpoint: { phase: 'snapshot_index', lastId: rows.at(-1)!.id } };
  }

  private async eraseKnownSearches(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const lastId = cursorString(input.checkpoint, 'lastId');
    const rows = await useClient(this.pool, async (client) => (await client.query<{ id: string; ownerUserId: string | null }>(
      `SELECT "id", "owner_user_id" AS "ownerUserId" FROM "scan_records"
       WHERE "tenant_id" = $1 AND "id" > $2 ORDER BY "id" LIMIT $3`,
      [input.tenantId, lastId, this.scanCount],
    )).rows);
    let deleted = 0n;
    for (const row of rows) deleted += await this.deleteSearchProjection(row.id, input.tenantId, row.ownerUserId);
    if (rows.length < this.scanCount) {
      return { done: false, deletedCount: deleted, checkpoint: { phase: 'scan', redisCursor: '0' } };
    }
    return { done: false, deletedCount: deleted, checkpoint: { phase: 'search_index', lastId: rows.at(-1)!.id } };
  }

  private async scanRedis(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const cursor = cursorString(input.checkpoint, 'redisCursor', '0');
    const [next, keys] = await this.redis.scan(cursor, 'MATCH', '*', 'COUNT', this.scanCount);
    let deleted = 0n;
    for (const key of keys) {
      if (key.startsWith('bull:')) continue; // BullMQ ownership is handled through its supported API.
      const type = await this.redis.type(key);
      let parsed: unknown = null;
      let raw: string | null = null;
      if (type === 'string') {
        const size = await this.redis.strlen(key);
        if (size > 8 * 1024 * 1024) throw new GovernanceConflictError('Refusing to inspect an oversized Redis governance value.');
        raw = await this.redis.get(key);
        if (raw) {
          try { parsed = JSON.parse(raw); }
          catch { parsed = null; }
        }
      }
      const directLock = key.startsWith(`dk:lock:conn:${input.tenantId}:`);
      const tenantSearchIndex = key.startsWith(`search:tenant:${encodeURIComponent(input.tenantId)}:`);
      const ownedValue = hasTenantBinding(parsed, input.tenantId);
      if (!directLock && !tenantSearchIndex && !ownedValue) {
        if (key.includes(input.tenantId)) {
          throw new GovernanceConflictError('A Redis key contains a raw tenant identifier outside a governed namespace.');
        }
        continue;
      }

      if (key.startsWith('search:') && parsed && typeof parsed === 'object') {
        const record = parsed as { id?: unknown; ownerUserId?: unknown };
        if (typeof record.id === 'string') {
          deleted += await this.deleteSearchProjection(
            record.id,
            input.tenantId,
            typeof record.ownerUserId === 'string' ? record.ownerUserId : null,
          );
          continue;
        }
      }
      if (key.startsWith('sentinel:connect-session:') && parsed && typeof parsed === 'object') {
        await this.deleteConnectIndexes(key, parsed as StoredConnectEnvelope, input.tenantId);
      }
      deleted += BigInt(await this.redis.del(key));
    }
    if (next !== '0') return { done: false, deletedCount: deleted, checkpoint: { phase: 'scan', redisCursor: next } };
    if (deleted > 0n) return { done: false, deletedCount: deleted, checkpoint: { phase: 'scan', redisCursor: '0' } };
    return { done: true, deletedCount: 0n, checkpoint: { phase: 'verified', redisCursor: '0' } };
  }

  private async deleteSnapshotNamespace(snapshotId: string): Promise<bigint> {
    if (!snapshotId || /[:\s*?[\]{}]/.test(snapshotId)) {
      throw new GovernanceConflictError('A snapshot id cannot be safely mapped to its Redis namespace.');
    }
    let deleted = 0n;
    let passDeleted: bigint;
    do {
      let cursor = '0';
      passDeleted = 0n;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `dk:snap:${snapshotId}:*`, 'COUNT', this.scanCount);
        if (keys.length > 0) passDeleted += BigInt(await this.redis.del(...keys));
        cursor = next;
      } while (cursor !== '0');
      deleted += passDeleted;
    } while (passDeleted > 0n);
    return deleted;
  }

  private async deleteSearchProjection(recordId: string, tenantId: string, ownerUserId: string | null): Promise<bigint> {
    const key = `search:${recordId}`;
    const removed = BigInt(await this.redis.del(key));
    await this.redis.lrem('search:index', 0, recordId);
    await this.redis.lrem(`search:tenant:${encodeURIComponent(tenantId)}:index`, 0, recordId);
    if (ownerUserId) {
      await this.redis.lrem(
        `search:tenant:${encodeURIComponent(tenantId)}:owner:${encodeURIComponent(ownerUserId)}:index`,
        0,
        recordId,
      );
    }
    return removed;
  }

  private async deleteConnectIndexes(key: string, stored: StoredConnectEnvelope, tenantId: string): Promise<void> {
    if (typeof stored.encryptedSession !== 'string') return;
    let session: DecryptedConnectSession;
    try { session = JSON.parse(await this.envelope.decrypt(stored.encryptedSession)) as DecryptedConnectSession; }
    catch { throw new GovernanceConflictError('A tenant connect-session envelope cannot be decrypted for erasure.'); }
    if (session.tenantId !== tenantId) throw new GovernanceConflictError('A connect-session tenant binding changed during erasure.');
    const connectId = key.slice('sentinel:connect-session:'.length);
    await this.redis.zrem('sentinel:connect-session:claims', connectId);
    if (typeof session.consentId === 'string' && session.consentId) {
      const digest = createHash('sha256').update(`${tenantId}\0${session.consentId}`).digest('hex');
      await this.redis.del(
        `sentinel:connect-session:by-consent:${digest}`,
        `sentinel:connect-session:revoked-consent:${digest}`,
        `sentinel:connect-session:revoked-consent-work:${digest}`,
      );
      await this.redis.zrem('sentinel:connect-session:revoked-consent-work', digest);
    }
  }
}

export class AwsSecretTextReader {
  constructor(private readonly client: SecretsManagerClient) {}

  async read(secretId: string, jsonKey?: string): Promise<string> {
    let response;
    try { response = await this.client.send(new GetSecretValueCommand({ SecretId: secretId })); }
    catch { throw new Error('Secrets Manager could not provide a governance integration credential.'); }
    let value: string;
    if (response.SecretString !== undefined) value = response.SecretString;
    else if (response.SecretBinary) value = Buffer.from(response.SecretBinary).toString('utf8');
    else throw new Error('A governance integration secret has no value.');
    if (jsonKey) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); }
      catch { throw new Error('A governance integration secret is not the configured JSON object.'); }
      const selected = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[jsonKey]
        : undefined;
      if (typeof selected !== 'string' || !selected) throw new Error('A governance integration secret is missing its configured JSON field.');
      value = selected;
    }
    if (!value || value.length > 65_536) throw new Error('A governance integration credential has an invalid length.');
    return value;
  }
}

interface KeycloakUserRepresentation {
  id?: unknown;
  attributes?: unknown;
  [key: string]: unknown;
}

export class KeycloakTenantIdentityErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'identity_memberships' as const;

  constructor(
    private readonly adminBaseUrl: URL,
    private readonly realm: string,
    private readonly clientId: string,
    private readonly clientSecretArn: string,
    private readonly clientSecretJsonKey: string | undefined,
    private readonly secrets: AwsSecretTextReader,
    private readonly requestTimeoutMs: number,
    private readonly batchSize = 50,
  ) { boundedBatch(batchSize); }

  async verifyReady(): Promise<void> {
    const token = await this.accessToken();
    const url = this.adminUrl('/users?first=0&max=1&briefRepresentation=true');
    await fetchJson(url, { headers: { Authorization: `Bearer ${token}` } }, this.requestTimeoutMs, [200]);
  }

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const token = await this.accessToken();
    const first = cursorInteger(input.checkpoint, 'first');
    const query = new URLSearchParams({
      q: `tenant_id:${input.tenantId}`,
      first: String(first),
      max: String(this.batchSize),
      briefRepresentation: 'false',
    });
    const response = await fetchJson(
      this.adminUrl(`/users?${query.toString()}`),
      { headers: { Authorization: `Bearer ${token}` } },
      this.requestTimeoutMs,
      [200],
    );
    if (!Array.isArray(response.body)) throw new Error('Keycloak returned an invalid user inventory.');
    const exact = (response.body as KeycloakUserRepresentation[]).filter((user) => {
      if (!user.attributes || typeof user.attributes !== 'object' || Array.isArray(user.attributes)) return false;
      const values = (user.attributes as Record<string, unknown>).tenant_id;
      return Array.isArray(values) && values.some((value) => value === input.tenantId);
    });
    let deleted = 0n;
    for (const user of exact) {
      if (typeof user.id !== 'string' || !/^[A-Za-z0-9._:-]{1,255}$/.test(user.id)) {
        throw new Error('Keycloak returned a user without a valid immutable id.');
      }
      const attributes = user.attributes as Record<string, unknown>;
      const tenantValues = attributes.tenant_id;
      if (!Array.isArray(tenantValues) || tenantValues.some((value) => typeof value !== 'string')) {
        throw new Error('Keycloak returned a user with an invalid tenant_id attribute.');
      }
      const remainingTenants = [...new Set(tenantValues.filter((value): value is string =>
        typeof value === 'string' && value !== input.tenantId))];
      if (remainingTenants.length === 0) {
        await fetchJson(
          this.adminUrl(`/users/${encodeURIComponent(user.id)}`),
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          this.requestTimeoutMs,
          [204, 404],
        );
      } else {
        await fetchJson(
          this.adminUrl(`/users/${encodeURIComponent(user.id)}`),
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...user, attributes: { ...attributes, tenant_id: remainingTenants } }),
          },
          this.requestTimeoutMs,
          [204],
        );
      }
      deleted += 1n;
    }
    // Re-read the same page after deletion because Keycloak's result window shifts left.
    return {
      done: exact.length === 0 && response.body.length < this.batchSize,
      deletedCount: deleted,
      checkpoint: {
        pass: cursorInteger(input.checkpoint, 'pass') + 1,
        first: exact.length > 0 ? first : first + response.body.length,
      },
    };
  }

  private adminUrl(path: string): URL {
    return new URL(`/admin/realms/${encodeURIComponent(this.realm)}${path}`, this.adminBaseUrl);
  }

  private async accessToken(): Promise<string> {
    const secret = await this.secrets.read(this.clientSecretArn, this.clientSecretJsonKey);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: secret,
    });
    const response = await fetchJson(
      new URL(`/realms/${encodeURIComponent(this.realm)}/protocol/openid-connect/token`, this.adminBaseUrl),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      this.requestTimeoutMs,
      [200],
    );
    const token = response.body && typeof response.body === 'object' && !Array.isArray(response.body)
      ? (response.body as Record<string, unknown>).access_token
      : undefined;
    if (typeof token !== 'string' || token.length < 20 || token.length > 16_384) {
      throw new Error('Keycloak did not issue a valid administration access token.');
    }
    return token;
  }
}

interface ObservabilityErasureResponse {
  status?: unknown;
  requestId?: unknown;
  tenantDigest?: unknown;
  deletedCount?: unknown;
  remainingCount?: unknown;
  receiptId?: unknown;
  completedAt?: unknown;
}

/**
 * Provider-neutral HTTPS contract for the configured observability backend. CloudWatch Logs does
 * not support deleting individual events, so production must supply an erasure gateway backed by
 * tenant-partitioned streams/indices. A 2xx without a zero-remaining receipt is not success.
 */
export class ObservabilityTenantErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'observability_records' as const;

  constructor(
    private readonly eraseUrl: URL,
    private readonly readinessUrl: URL,
    private readonly tokenSecretArn: string,
    private readonly tokenSecretJsonKey: string | undefined,
    private readonly secrets: AwsSecretTextReader,
    private readonly requestTimeoutMs: number,
  ) {}

  async verifyReady(): Promise<void> {
    const token = await this.secrets.read(this.tokenSecretArn, this.tokenSecretJsonKey);
    const response = await fetchJson(
      this.readinessUrl,
      { headers: { Authorization: `Bearer ${token}` } },
      this.requestTimeoutMs,
      [200],
    );
    const body = response.body as Record<string, unknown> | null;
    if (
      !body || body.ready !== true || body.supportsSelectiveTenantErasure !== true
      || body.identifier !== 'raw-tenant-id-v1'
    ) {
      throw new Error('Observability backend does not attest selective raw-tenant-id erasure support.');
    }
  }

  async erase(input: { requestId: string; tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const token = await this.secrets.read(this.tokenSecretArn, this.tokenSecretJsonKey);
    const digest = tenantDigest(input.tenantId);
    const response = await fetchJson(
      this.eraseUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.requestId,
        },
        body: JSON.stringify({
          version: 1,
          requestId: input.requestId,
          subject: { type: 'raw-tenant-id-v1', value: input.tenantId },
          tenantDigest: digest,
        }),
      },
      this.requestTimeoutMs,
      [200, 202],
    );
    const body = (response.body ?? {}) as ObservabilityErasureResponse;
    if (body.requestId !== input.requestId || body.tenantDigest !== digest) {
      throw new Error('Observability erasure receipt does not match the request binding.');
    }
    if (response.status === 202 || body.status === 'pending') {
      return { done: false, deletedCount: 0n, checkpoint: { receiptId: String(body.receiptId ?? '') } };
    }
    const deletedCount = typeof body.deletedCount === 'number' && Number.isSafeInteger(body.deletedCount) && body.deletedCount >= 0
      ? BigInt(body.deletedCount)
      : null;
    if (
      body.status !== 'completed' || deletedCount === null || body.remainingCount !== 0
      || typeof body.receiptId !== 'string' || !body.receiptId
      || typeof body.completedAt !== 'string' || !Number.isFinite(new Date(body.completedAt).getTime())
    ) {
      throw new Error('Observability backend did not provide a complete zero-remaining erasure receipt.');
    }
    return {
      done: true,
      deletedCount,
      checkpoint: {
        receiptId: body.receiptId,
        completedAt: new Date(body.completedAt).toISOString(),
        tenantDigest: digest,
      },
    };
  }
}

export class AwsBackupFiniteExpiryAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'backup_expiry' as const;

  constructor(
    private readonly vaults: readonly (BackupVaultConfig & { client: BackupClient })[],
    private readonly retentionDays: number,
    private readonly legalBasisReference: string,
  ) {
    if (vaults.length === 0) throw new GovernanceValidationError('At least one production AWS Backup vault is required.');
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 35 || retentionDays > 3_650) {
      throw new GovernanceValidationError('BACKUP_RETENTION_DAYS must be an integer from 35 through 3650.');
    }
    if (!legalBasisReference.trim() || legalBasisReference.length > 512) {
      throw new GovernanceValidationError('BACKUP_LEGAL_BASIS_REFERENCE is invalid.');
    }
  }

  async verifyReady(): Promise<void> {
    await Promise.all(this.vaults.map(async (target) => {
      const vault = await target.client.send(new DescribeBackupVaultCommand({ BackupVaultName: target.name }));
      if (
        !vault.BackupVaultArn?.includes(`:backup:${target.region}:`)
        || !vault.BackupVaultArn.endsWith(`:backup-vault:${target.name}`)
        || vault.Locked !== true
      ) {
        throw new Error(`AWS Backup vault ${target.region}/${target.name} must exist and have Vault Lock enabled.`);
      }
      if (vault.MaxRetentionDays === undefined || vault.MaxRetentionDays > 3_650) {
        throw new Error('AWS Backup Vault Lock must enforce a finite maximum no greater than 3650 days.');
      }
      if (vault.MinRetentionDays !== undefined && this.retentionDays < vault.MinRetentionDays) {
        throw new Error('BACKUP_RETENTION_DAYS is shorter than an AWS Backup Vault Lock minimum.');
      }
    }));
  }

  async erase(input: { checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const vaultIndex = cursorInteger(input.checkpoint, 'vaultIndex');
    if (vaultIndex >= this.vaults.length) {
      throw new GovernanceValidationError('AWS Backup checkpoint references a vault outside the configured inventory.');
    }
    const nextToken = input.checkpoint.nextToken;
    if (nextToken !== undefined && (typeof nextToken !== 'string' || nextToken.length > 4_096)) {
      throw new GovernanceValidationError('Invalid AWS Backup checkpoint token.');
    }
    let farthestDeleteAt = input.checkpoint.farthestDeleteAt === undefined
      ? 0
      : new Date(isoDate(input.checkpoint.farthestDeleteAt, 'backup recovery-point expiry')).getTime();
    const target = this.vaults[vaultIndex]!;
    const page = await target.client.send(new ListRecoveryPointsByBackupVaultCommand({
      BackupVaultName: target.name,
      ...(nextToken ? { NextToken: nextToken } : {}),
      MaxResults: 1_000,
    }));
    for (const recoveryPoint of page.RecoveryPoints ?? []) {
      if (recoveryPoint.Status === 'DELETING' || recoveryPoint.Status === 'EXPIRED') continue;
      const deleteAt = recoveryPoint.CalculatedLifecycle?.DeleteAt;
      if (!deleteAt || !Number.isFinite(deleteAt.getTime())) {
        throw new GovernanceConflictError('AWS Backup contains a recovery point without a finite calculated deletion time.');
      }
      farthestDeleteAt = Math.max(farthestDeleteAt, deleteAt.getTime());
    }
    if (page.NextToken) {
      return {
        done: false,
        deletedCount: 0n,
        checkpoint: {
          vaultIndex,
          nextToken: page.NextToken,
          ...(farthestDeleteAt > 0 ? { farthestDeleteAt: new Date(farthestDeleteAt).toISOString() } : {}),
        },
      };
    }
    const nextVaultIndex = vaultIndex + 1;
    if (nextVaultIndex < this.vaults.length) {
      return {
        done: false,
        deletedCount: 0n,
        checkpoint: {
          vaultIndex: nextVaultIndex,
          ...(farthestDeleteAt > 0 ? { farthestDeleteAt: new Date(farthestDeleteAt).toISOString() } : {}),
        },
      };
    }
    const holdUntil = new Date(Math.max(Date.now(), farthestDeleteAt)).toISOString();
    if (new Date(holdUntil).getTime() > Date.now() + this.retentionDays * DAY_MS + 60_000) {
      throw new GovernanceConflictError('An AWS Backup recovery point exceeds BACKUP_RETENTION_DAYS.');
    }
    return {
      done: true,
      deletedCount: 0n,
      checkpoint: {
        holdUntil,
        backupVaults: this.vaults.map(({ region, name }) => ({ region, name })),
        inventoryVerifiedAt: new Date().toISOString(),
      },
      legalBasis: `Aggregate encrypted backup is not tenant-selectively mutable; AWS Backup expiry is enforced no later than ${holdUntil}. Basis: ${this.legalBasisReference}.`,
    };
  }
}

export class AuditLegalRecordFiniteHoldAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'audit_legal_record' as const;

  constructor(
    private readonly pool: GovernanceSqlPool,
    private readonly envelope: EnvelopeCrypto,
    private readonly retentionDays: number,
    private readonly legalBasisReference: string,
    private readonly auditObjects: { bucket: string; eraser: VersionedS3ObjectEraser },
    private readonly receiptSigner: AuditAnchorSigner,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 365 || retentionDays > 3_650) {
      throw new GovernanceValidationError('AUDIT_RETENTION_DAYS must be an integer from 365 through 3650.');
    }
    if (!legalBasisReference.trim() || legalBasisReference.length > 512) {
      throw new GovernanceValidationError('AUDIT_LEGAL_BASIS_REFERENCE is invalid.');
    }
  }

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    const holdUntil = input.checkpoint.holdUntil === undefined
      ? new Date(Date.now() + this.retentionDays * DAY_MS).toISOString()
      : isoDate(input.checkpoint.holdUntil, 'audit hold expiry');
    const subjectRef = typeof input.checkpoint.subjectRef === 'string'
      ? input.checkpoint.subjectRef
      : await this.envelope.encrypt(input.tenantId);
    if (new Date(holdUntil).getTime() > Date.now() + this.retentionDays * DAY_MS + 60_000) {
      throw new GovernanceConflictError('Audit legal hold exceeds the configured finite retention window.');
    }
    return {
      done: true,
      deletedCount: 0n,
      checkpoint: { holdUntil, subjectRef, tenantDigest: tenantDigest(input.tenantId) },
      legalBasis: `Tamper-evident security audit records remain under a finite legal/security hold until ${holdUntil}; automatic purge is due immediately afterward. Basis: ${this.legalBasisReference}.`,
    };
  }

  /** Delete expired WORM objects first, then use the guarded database function and save a KMS-signed receipt. */
  async purgeExpired(now = new Date().toISOString(), limit = 25): Promise<number> {
    const dueAt = isoDate(now, 'audit legal-hold purge time');
    const batch = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await useClient(this.pool, async (client) => (await client.query<{
      requestId: string;
      subjectRef: string;
      tenantDigest: string;
      holdUntil: string;
    }>(
      `SELECT step."requestId", step."checkpoint"->>'subjectRef' AS "subjectRef",
              step."checkpoint"->>'tenantDigest' AS "tenantDigest",
              step."checkpoint"->>'holdUntil' AS "holdUntil"
       FROM "TenantErasureStep" AS step
       JOIN "TenantErasureRequest" AS request ON request."id" = step."requestId" AND request."status" = 'SUCCEEDED'
       WHERE step."resourceKind" = 'audit_legal_record' AND step."status" = 'SKIPPED_LEGAL_HOLD'
         AND NULLIF(step."checkpoint"->>'holdUntil', '')::timestamptz <= $1::timestamptz
         AND COALESCE(step."checkpoint"->>'purgedAt', '') = ''
       ORDER BY NULLIF(step."checkpoint"->>'holdUntil', '')::timestamptz, step."id"
       FOR UPDATE SKIP LOCKED LIMIT $2`,
      [dueAt, batch],
    )).rows);
    let purged = 0;
    for (const row of rows) {
      if (!row.subjectRef || !/^[0-9a-f]{64}$/.test(row.tenantDigest)) {
        throw new GovernanceConflictError('Expired audit hold is missing its encrypted subject binding.');
      }
      const tenantId = await this.envelope.decrypt(row.subjectRef);
      if (tenantDigest(tenantId) !== row.tenantDigest) {
        throw new GovernanceConflictError('Expired audit hold tenant digest does not match its encrypted subject reference.');
      }
      const manifestResult = await useClient(this.pool, (client) => client.query<{
        eventCount: bigint | string | number;
        lastSequence: bigint | string | number;
        lastHash: string;
        anchorCount: bigint | string | number;
        anchorDigest: string;
        anchorRefs: unknown;
        holdUntil: string;
      }>(
        `SELECT * FROM sentinel_prepare_expired_audit_purge($1, $2, $3)`,
        [row.requestId, tenantId, row.tenantDigest],
      ));
      const manifest = manifestResult.rows[0];
      if (!manifest) throw new GovernanceConflictError('Controlled audit purge did not return a durable manifest.');
      if (!Array.isArray(manifest.anchorRefs) || manifest.anchorRefs.some((value) => typeof value !== 'string')) {
        throw new GovernanceConflictError('Controlled audit purge manifest contains an invalid anchor inventory.');
      }
      const anchorRefs = manifest.anchorRefs as string[];
      const anchorCount = BigInt(manifest.anchorCount);
      const calculatedAnchorDigest = createHash('sha256').update(anchorRefs.join('\n'), 'utf8').digest('hex');
      if (anchorCount !== BigInt(anchorRefs.length) || manifest.anchorDigest !== calculatedAnchorDigest) {
        throw new GovernanceConflictError('Controlled audit purge manifest anchor digest is invalid.');
      }
      for (const externalRef of anchorRefs) {
        const withoutQuery = externalRef.split('?', 1)[0]!;
        const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(withoutQuery);
        if (!match || match[1] !== this.auditObjects.bucket || !match[2]) {
          throw new GovernanceConflictError('An audit anchor is outside the configured immutable audit bucket.');
        }
        await this.auditObjects.eraser.eraseExactKey(match[2]);
      }
      const eventCount = BigInt(manifest.eventCount);
      const lastSequence = BigInt(manifest.lastSequence);
      const payload = [
        'sentinel-audit-erasure-v1',
        row.requestId,
        row.tenantDigest,
        manifest.holdUntil,
        eventCount.toString(),
        lastSequence.toString(),
        manifest.lastHash,
        anchorCount.toString(),
        manifest.anchorDigest,
        dueAt,
      ].join('\n');
      const signed = await this.receiptSigner.sign(Buffer.from(payload, 'utf8'));
      const receipt = await useClient(this.pool, (client) => client.query<{ receiptId: string }>(
        `SELECT * FROM sentinel_purge_expired_audit_chain($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9)`,
        [row.requestId, tenantId, row.tenantDigest, anchorCount.toString(), manifest.anchorDigest,
          dueAt, payload, signed.keyId, signed.signature],
      ));
      if (receipt.rows.length !== 1 || !receipt.rows[0]?.receiptId) {
        throw new GovernanceConflictError('Controlled audit expiry purge did not return an immutable receipt.');
      }
      purged += 1;
    }
    return purged;
  }
}

export interface ProductionGovernanceAdapters {
  readonly retentionAdapters: readonly RetentionAdapter[];
  readonly erasureAdapters: readonly TenantErasureAdapter[];
  readonly auditLegalHold: AuditLegalRecordFiniteHoldAdapter;
  verifyReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ProductionGovernanceAdapterDependencies {
  s3?: S3Client;
  s3Clients?: Readonly<Record<string, S3Client>>;
  secretsManager?: SecretsManagerClient;
  /** Primary-region compatibility hook; use backupClients for every configured region. */
  backup?: BackupClient;
  backupClients?: Readonly<Record<string, BackupClient>>;
  redis?: Redis;
  envelope?: EnvelopeCrypto;
  queues?: readonly Queue[];
  /** Use the production asymmetric KMS signer already created by the governance runtime. */
  auditReceiptSigner?: AuditAnchorSigner;
}

function awsRegion(env: NodeJS.ProcessEnv): string {
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim();
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) throw new GovernanceValidationError('AWS_REGION must be a valid AWS region.');
  return region;
}

function awsAccountId(env: NodeJS.ProcessEnv): string {
  const accountId = required(env, 'AWS_ACCOUNT_ID');
  if (!/^\d{12}$/.test(accountId)) throw new GovernanceValidationError('AWS_ACCOUNT_ID must contain 12 digits.');
  return accountId;
}

function kmsArn(value: string, region: string, accountId: string, name: string): string {
  const match = /^arn:[a-z0-9-]+:kms:([^:]+):(\d{12}):key\/[A-Za-z0-9-]+$/.exec(value);
  if (!match || match[1] !== region || match[2] !== accountId) {
    throw new GovernanceValidationError(`${name} must be an immutable KMS key ARN in AWS_REGION and AWS_ACCOUNT_ID.`);
  }
  return value;
}

interface ArtifactBucketConfig {
  readonly region: string;
  readonly name: string;
  readonly kmsKeyId: string;
}

function artifactBucketConfigs(env: NodeJS.ProcessEnv, accountId: string): ArtifactBucketConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(required(env, 'GOVERNANCE_ARTIFACT_BUCKETS')); }
  catch { throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS must be a JSON array of region/name/kmsKeyId objects.'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS must contain between 1 and 20 buckets.');
  }
  const configs = parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS entries must be objects.');
    }
    const { region, name, kmsKeyId } = value as Record<string, unknown>;
    if (
      typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)
      || typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)
      || typeof kmsKeyId !== 'string'
    ) {
      throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS contains an invalid region, bucket, or KMS key.');
    }
    return { region, name, kmsKeyId: kmsArn(kmsKeyId, region, accountId, `GOVERNANCE_ARTIFACT_BUCKETS[${index}].kmsKeyId`) };
  });
  if (new Set(configs.map(({ region, name }) => `${region}\0${name}`)).size !== configs.length) {
    throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS cannot contain duplicates.');
  }
  return configs;
}

function queueNames(env: NodeJS.ProcessEnv): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(required(env, 'GOVERNANCE_BULLMQ_QUEUES')); }
  catch { throw new GovernanceValidationError('GOVERNANCE_BULLMQ_QUEUES must be a JSON array of queue names.'); }
  if (
    !Array.isArray(parsed) || parsed.length === 0 || parsed.length > 100
    || parsed.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(name))
  ) {
    throw new GovernanceValidationError('GOVERNANCE_BULLMQ_QUEUES must contain unique safe queue names.');
  }
  const unique = [...new Set(parsed as string[])];
  if (unique.length !== parsed.length) throw new GovernanceValidationError('GOVERNANCE_BULLMQ_QUEUES cannot contain duplicates.');
  const missing = REQUIRED_GOVERNANCE_QUEUE_NAMES.filter((name) => !unique.includes(name));
  if (missing.length > 0) throw new GovernanceValidationError(`GOVERNANCE_BULLMQ_QUEUES is missing required queues: ${missing.join(', ')}.`);
  return unique;
}

interface BackupVaultConfig {
  readonly region: string;
  readonly name: string;
}

function backupVaultConfigs(env: NodeJS.ProcessEnv): BackupVaultConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(required(env, 'GOVERNANCE_BACKUP_VAULTS')); }
  catch { throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS must be a JSON array of region/name objects.'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 20) {
    throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS must contain between 1 and 20 vaults.');
  }
  const configs = parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS entries must be region/name objects.');
    }
    const { region, name } = value as Record<string, unknown>;
    if (
      typeof region !== 'string' || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)
      || typeof name !== 'string' || !/^[A-Za-z0-9_.-]{2,50}$/.test(name)
    ) {
      throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS contains an invalid region or vault name.');
    }
    return { region, name };
  });
  const unique = new Set(configs.map(({ region, name }) => `${region}\0${name}`));
  if (unique.size !== configs.length) throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS cannot contain duplicates.');
  return configs;
}

function productionRedisUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new GovernanceValidationError('REDIS_URL must be a valid rediss URL.'); }
  if (parsed.protocol !== 'rediss:' || !parsed.hostname) {
    throw new GovernanceValidationError('Production governance requires REDIS_URL with TLS (rediss://).');
  }
  return value;
}

function steelEndpoint(env: NodeJS.ProcessEnv): { url: URL; apiKey: string | null } {
  const mode = required(env, 'STEEL_CONNECTOR_MODE').toLowerCase();
  if (!['cloud', 'external', 'self_hosted'].includes(mode)) {
    throw new GovernanceValidationError('STEEL_CONNECTOR_MODE must be cloud, external, or self_hosted.');
  }
  const raw = mode === 'cloud' ? (env.STEEL_API_URL?.trim() || 'https://api.steel.dev') : required(env, 'STEEL_API_URL');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new GovernanceValidationError('STEEL_API_URL is invalid.'); }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    throw new GovernanceValidationError('STEEL_API_URL must be an HTTP(S) URL without credentials or a fragment.');
  }
  if (mode !== 'self_hosted' && url.protocol !== 'https:') {
    throw new GovernanceValidationError('Cloud/external Steel control-plane traffic must use HTTPS.');
  }
  const apiKey = env.STEEL_API_KEY?.trim() || null;
  if (mode === 'cloud' && !apiKey) throw new GovernanceValidationError('STEEL_API_KEY is required for Steel cloud.');
  return { url, apiKey };
}

/**
 * Strict composition for all supported resources. It creates no fallback adapters: missing
 * tenant-selective observability, Keycloak administration, AWS backup, S3, or Redis configuration
 * aborts construction before a governance worker can advertise readiness.
 */
export function createProductionGovernanceAdapters(
  pool: GovernanceSqlPool,
  pseudonymizer: TenantPseudonymizer,
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionGovernanceAdapterDependencies = {},
): ProductionGovernanceAdapters {
  if ([
    env.AWS_ENDPOINT_URL,
    env.AWS_ENDPOINT_URL_S3,
    env.AWS_ENDPOINT_URL_SECRETSMANAGER,
    env.AWS_ENDPOINT_URL_BACKUP,
    env.S3_ENDPOINT,
  ].some((value) => value?.trim())) {
    throw new GovernanceValidationError('AWS endpoint overrides are forbidden in production governance adapters.');
  }
  const region = awsRegion(env);
  const accountId = awsAccountId(env);
  const backupConfigs = backupVaultConfigs(env);
  if (!backupConfigs.some((config) => config.region === region)) {
    throw new GovernanceValidationError('GOVERNANCE_BACKUP_VAULTS must include the primary AWS_REGION.');
  }
  const artifactBucket = required(env, 'ARTIFACT_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(artifactBucket)) {
    throw new GovernanceValidationError('ARTIFACT_S3_BUCKET is invalid.');
  }
  const artifactKmsKeyId = kmsArn(required(env, 'ARTIFACT_KMS_KEY_ID'), region, accountId, 'ARTIFACT_KMS_KEY_ID');
  const artifactConfigs = artifactBucketConfigs(env, accountId);
  if (!artifactConfigs.some((config) =>
    config.region === region && config.name === artifactBucket && config.kmsKeyId === artifactKmsKeyId)) {
    throw new GovernanceValidationError('GOVERNANCE_ARTIFACT_BUCKETS must include the canonical ARTIFACT_S3_BUCKET and key.');
  }
  const auditBucket = required(env, 'AUDIT_EXPORT_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(auditBucket)) {
    throw new GovernanceValidationError('AUDIT_EXPORT_S3_BUCKET is invalid.');
  }
  const auditKmsKeyId = kmsArn(required(env, 'AUDIT_EXPORT_KMS_KEY_ID'), region, accountId, 'AUDIT_EXPORT_KMS_KEY_ID');
  const batchSize = integer(env.GOVERNANCE_ADAPTER_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 1_000, 'GOVERNANCE_ADAPTER_BATCH_SIZE');
  const requestTimeoutMs = integer(env.GOVERNANCE_EXTERNAL_TIMEOUT_MS, 10_000, 500, 60_000, 'GOVERNANCE_EXTERNAL_TIMEOUT_MS');
  const maxAttempts = integer(env.GOVERNANCE_AWS_MAX_ATTEMPTS, 3, 1, 10, 'GOVERNANCE_AWS_MAX_ATTEMPTS');
  const names = queueNames(env);
  const redisUrl = productionRedisUrl(required(env, 'REDIS_URL'));
  const steel = steelEndpoint(env);

  const ownSecrets = !dependencies.secretsManager;
  const ownRedis = !dependencies.redis;
  const ownedS3Clients: S3Client[] = [];
  const s3ClientsByRegion = new Map<string, S3Client>();
  for (const targetRegion of new Set([region, ...artifactConfigs.map((config) => config.region)])) {
    const injected = dependencies.s3Clients?.[targetRegion]
      ?? (targetRegion === region ? dependencies.s3 : undefined);
    const client = injected ?? new S3Client({
      region: targetRegion,
      maxAttempts,
      ignoreConfiguredEndpointUrls: true,
    });
    if (!injected) ownedS3Clients.push(client);
    s3ClientsByRegion.set(targetRegion, client);
  }
  const s3 = s3ClientsByRegion.get(region)!;
  const secretsManager = dependencies.secretsManager
    ?? new SecretsManagerClient({ region, maxAttempts, ignoreConfiguredEndpointUrls: true });
  const ownedBackupClients: BackupClient[] = [];
  const backupClientsByRegion = new Map<string, BackupClient>();
  for (const config of backupConfigs) {
    if (backupClientsByRegion.has(config.region)) continue;
    const injected = dependencies.backupClients?.[config.region]
      ?? (config.region === region ? dependencies.backup : undefined);
    const client = injected ?? new BackupClient({
      region: config.region,
      maxAttempts,
      ignoreConfiguredEndpointUrls: true,
    });
    if (!injected) ownedBackupClients.push(client);
    backupClientsByRegion.set(config.region, client);
  }
  const redis = dependencies.redis ?? new Redis(redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  });
  const envelope = dependencies.envelope ?? envelopeEncryptorFromEnv(env);
  if (!dependencies.auditReceiptSigner) {
    throw new GovernanceValidationError('A production asymmetric KMS auditReceiptSigner is required for immutable audit-erasure receipts.');
  }
  const ownQueues = !dependencies.queues;
  const queues = dependencies.queues ?? names.map((name) => new Queue(name, { connection: redis as never }));

  const queueInventory = new BullMqTenantJobInventory(queues, batchSize);
  const artifactStores = artifactConfigs.map((config) => ({
    bucket: config.name,
    eraser: new VersionedS3ObjectEraser(s3ClientsByRegion.get(config.region)!, {
      bucket: config.name,
      kmsKeyId: config.kmsKeyId,
      batchSize,
    }),
  }));
  const auditS3Eraser = new VersionedS3ObjectEraser(s3, {
    bucket: auditBucket,
    kmsKeyId: auditKmsKeyId,
    batchSize,
    requireObjectLock: true,
  });
  const s3Retention = new S3EvidenceRetentionAdapter(pool, artifactStores, artifactBucket, batchSize);
  const secretReader = new AwsSecretTextReader(secretsManager);
  const keycloak = new KeycloakTenantIdentityErasureAdapter(
    httpsUrl(required(env, 'KEYCLOAK_ADMIN_BASE_URL'), 'KEYCLOAK_ADMIN_BASE_URL'),
    required(env, 'KEYCLOAK_REALM'),
    required(env, 'KEYCLOAK_ERASURE_CLIENT_ID'),
    required(env, 'KEYCLOAK_ERASURE_CLIENT_SECRET_ARN'),
    env.KEYCLOAK_ERASURE_CLIENT_SECRET_JSON_KEY?.trim() || undefined,
    secretReader,
    requestTimeoutMs,
    Math.min(batchSize, 100),
  );
  const observability = new ObservabilityTenantErasureAdapter(
    httpsUrl(required(env, 'OBSERVABILITY_ERASURE_URL'), 'OBSERVABILITY_ERASURE_URL'),
    httpsUrl(required(env, 'OBSERVABILITY_ERASURE_READINESS_URL'), 'OBSERVABILITY_ERASURE_READINESS_URL'),
    required(env, 'OBSERVABILITY_ERASURE_TOKEN_SECRET_ARN'),
    env.OBSERVABILITY_ERASURE_TOKEN_SECRET_JSON_KEY?.trim() || undefined,
    secretReader,
    requestTimeoutMs,
  );
  const backupExpiry = new AwsBackupFiniteExpiryAdapter(
    backupConfigs.map((config) => ({ ...config, client: backupClientsByRegion.get(config.region)! })),
    integer(env.BACKUP_RETENTION_DAYS, 2_555, 35, 3_650, 'BACKUP_RETENTION_DAYS'),
    required(env, 'BACKUP_LEGAL_BASIS_REFERENCE'),
  );
  const auditHold = new AuditLegalRecordFiniteHoldAdapter(
    pool,
    envelope,
    integer(env.AUDIT_RETENTION_DAYS, 2_555, 365, 3_650, 'AUDIT_RETENTION_DAYS'),
    required(env, 'AUDIT_LEGAL_BASIS_REFERENCE'),
    { bucket: auditBucket, eraser: auditS3Eraser },
    dependencies.auditReceiptSigner,
  );

  const retentionAdapters: RetentionAdapter[] = [
    new PostgresResourceRetentionAdapter('catalog_snapshots', pool, batchSize),
    new PostgresResourceRetentionAdapter('scan_history', pool, batchSize),
    s3Retention,
    new PostgresResourceRetentionAdapter('browser_state', pool, batchSize),
    new PostgresResourceRetentionAdapter('invitation_records', pool, batchSize),
    new OperationalJobsRetentionAdapter(queueInventory, pool, batchSize),
  ];
  const erasureAdapters: TenantErasureAdapter[] = [
    new SteelTenantSessionErasureAdapter(
      pool,
      redis,
      queueInventory,
      envelope,
      steel.url,
      steel.apiKey,
      requestTimeoutMs,
      batchSize,
    ),
    keycloak,
    new AwsSecretsManagerTenantErasureAdapter(pool, secretsManager, region, accountId, Math.min(batchSize, 100)),
    new S3TenantObjectsErasureAdapter(s3Retention),
    new BullMqTenantErasureAdapter(queueInventory),
    new RedisTenantKeysErasureAdapter(pool, redis, envelope, batchSize),
    new PostgresTenantRowsErasureAdapter(pool),
    observability,
    backupExpiry,
    auditHold,
  ];

  return {
    retentionAdapters,
    erasureAdapters,
    auditLegalHold: auditHold,
    async verifyReady(): Promise<void> {
      await useClient(pool, async (client) => {
        await client.query('SELECT 1 FROM "RetentionPolicy" LIMIT 0');
        await client.query('SELECT 1 FROM "TenantErasureStep" LIMIT 0');
        await client.query('SELECT 1 FROM "ObjectStorageArtifact" LIMIT 0');
        await client.query('SELECT 1 FROM audit_purge_manifests LIMIT 0');
        const capability = await client.query<{ prepareAllowed: boolean; purgeAllowed: boolean }>(
          `SELECT
             has_function_privilege(current_user,
               'sentinel_prepare_expired_audit_purge(text,text,text)', 'EXECUTE') AS "prepareAllowed",
             has_function_privilege(current_user,
               'sentinel_purge_expired_audit_chain(text,text,text,bigint,text,text,text,text,text)', 'EXECUTE') AS "purgeAllowed"`,
        );
        if (capability.rows[0]?.prepareAllowed !== true || capability.rows[0]?.purgeAllowed !== true) {
          throw new Error('Governance database role lacks controlled audit-expiry purge capability.');
        }
      });
      await Promise.all([
        ...artifactStores.map((store) => store.eraser.verifyReady()),
        auditS3Eraser.verifyReady(),
        queueInventory.verifyReady(),
        keycloak.verifyReady(),
        observability.verifyReady(),
        backupExpiry.verifyReady(),
        (erasureAdapters.find((adapter) => adapter.resourceKind === 'redis_keys') as RedisTenantKeysErasureAdapter).verifyReady(),
        (erasureAdapters.find((adapter) => adapter.resourceKind === 'steel_sessions') as SteelTenantSessionErasureAdapter).verifyReady(),
      ]);
      await pseudonymizer.pseudonym('tenant', 'governance-adapter-readiness');
    },
    async close(): Promise<void> {
      if (ownQueues) await queueInventory.close();
      if (ownRedis) await redis.quit();
      for (const client of ownedS3Clients) client.destroy();
      if (ownSecrets) secretsManager.destroy();
      for (const client of ownedBackupClients) client.destroy();
    },
  };
}
