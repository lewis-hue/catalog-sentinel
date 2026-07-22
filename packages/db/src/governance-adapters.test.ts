import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  DescribeBackupVaultCommand,
  ListRecoveryPointsByBackupVaultCommand,
  type BackupClient,
} from '@aws-sdk/client-backup';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type { EnvelopeCrypto } from '@sentinel/security';
import type { GovernanceSqlPool } from './governance-types';
import { RETENTION_RESOURCE_KINDS } from './retention';
import { PRODUCTION_TENANT_ERASURE_RESOURCES, type TenantPseudonymizer } from './tenant-erasure';
import {
  BullMqTenantJobInventory,
  AwsBackupFiniteExpiryAdapter,
  createProductionGovernanceAdapters,
  ObservabilityTenantErasureAdapter,
  PostgresResourceRetentionAdapter,
  REQUIRED_GOVERNANCE_QUEUE_NAMES,
  VersionedS3ObjectEraser,
  type AwsSecretTextReader,
} from './governance-adapters';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function sqlPool(query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>): GovernanceSqlPool {
  return {
    async connect() {
      return {
        query: query as never,
        release() {},
      };
    },
  };
}

describe('production governance adapters', () => {
  it('advances PostgreSQL retention only after a bounded resource batch drains', async () => {
    const recorded: (readonly unknown[])[] = [];
    let invocation = 0;
    const pool = sqlPool(async (_sql, values) => {
      recorded.push(values ?? []);
      invocation += 1;
      return { rows: invocation === 1 ? [{ id: '1' }, { id: '2' }] : [] };
    });
    const adapter = new PostgresResourceRetentionAdapter('catalog_snapshots', pool, 2);
    const first = await adapter.deleteBefore({ tenantId: 'tenant-a', cutoffAt: '2026-01-01T00:00:00Z', cursor: {} });
    expect(first).toMatchObject({ done: false, deletedCount: 2n, cursor: { statementIndex: 0 } });
    const second = await adapter.deleteBefore({ tenantId: 'tenant-a', cutoffAt: '2026-01-01T00:00:00Z', cursor: first.cursor });
    expect(second).toMatchObject({ done: false, deletedCount: 0n, cursor: { statementIndex: 1 } });
    expect(recorded.every((values) => values[0] === 'tenant-a' && values[2] === 2)).toBe(true);
  });

  it('deletes and verifies every version of an exact S3 key', async () => {
    const remaining = new Set(['v1', 'v2', 'delete-marker']);
    const client = {
      async send(command: unknown) {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [...remaining].filter((id) => id !== 'delete-marker').map((VersionId) => ({ Key: 'tenant/a.json', VersionId })),
            DeleteMarkers: remaining.has('delete-marker') ? [{ Key: 'tenant/a.json', VersionId: 'delete-marker' }] : [],
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          const objects = command.input.Delete?.Objects ?? [];
          for (const object of objects) if (object.VersionId) remaining.delete(object.VersionId);
          return { Deleted: objects };
        }
        throw new Error('unexpected command');
      },
    } as unknown as S3Client;
    const eraser = new VersionedS3ObjectEraser(client, {
      bucket: 'production-artifacts',
      kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/key-id',
      batchSize: 10,
    });
    await expect(eraser.eraseExactKey('tenant/a.json')).resolves.toBe(3n);
    expect(remaining.size).toBe(0);
    await expect(eraser.eraseExactKey('tenant/a.json')).resolves.toBe(0n);
  });

  it('removes only matching-tenant BullMQ jobs and checkpoints after list compaction', async () => {
    const jobs = [
      { id: 'a', data: { tenantId: 'tenant-a' }, remove: vi.fn(async () => { jobs.splice(jobs.findIndex((job) => job.id === 'a'), 1); }) },
      { id: 'b', data: { tenantId: 'tenant-b' }, remove: vi.fn(async () => undefined) },
    ];
    const queue = {
      async getJobs(_types: unknown, start: number, end: number) { return jobs.slice(start, end + 1); },
      async close() {},
    } as unknown as Queue;
    const inventory = new BullMqTenantJobInventory([queue], 2);
    const result = await inventory.eraseTenantBatch('tenant-a', {});
    expect(result).toMatchObject({ done: false, deletedCount: 1n, checkpoint: { queueIndex: 0, offset: 0 } });
    expect(jobs.map((job) => job.id)).toEqual(['b']);
  });

  it('accepts observability completion only with a request-bound zero-remaining receipt', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { requestId: string; tenantDigest: string };
      return new Response(JSON.stringify({
        status: 'completed',
        requestId: request.requestId,
        tenantDigest: request.tenantDigest,
        deletedCount: 9,
        remainingCount: 0,
        receiptId: 'receipt-1',
        completedAt: '2026-07-23T00:00:00.000Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const secrets = { read: vi.fn(async () => 'token-value') } as unknown as AwsSecretTextReader;
    const adapter = new ObservabilityTenantErasureAdapter(
      new URL('https://observability.example/erase'),
      new URL('https://observability.example/ready'),
      'arn:secret',
      undefined,
      secrets,
      1_000,
    );
    await expect(adapter.erase({ requestId: 'erase-1', tenantId: 'tenant-a', checkpoint: {} })).resolves.toMatchObject({
      done: true,
      deletedCount: 9n,
      checkpoint: { receiptId: 'receipt-1' },
    });
  });

  it('inventories every primary and DR backup vault before recording a finite hold', async () => {
    const backupClient = (region: string, name: string, deleteAfterDays: number) => ({
      async send(command: unknown) {
        if (command instanceof DescribeBackupVaultCommand) {
          return {
            BackupVaultArn: `arn:aws:backup:${region}:123456789012:backup-vault:${name}`,
            Locked: true,
            MinRetentionDays: 35,
            MaxRetentionDays: 3_650,
          };
        }
        if (command instanceof ListRecoveryPointsByBackupVaultCommand) {
          return { RecoveryPoints: [{ Status: 'COMPLETED', CalculatedLifecycle: { DeleteAt: new Date(Date.now() + deleteAfterDays * 86_400_000) } }] };
        }
        throw new Error('unexpected backup command');
      },
    } as unknown as BackupClient);
    const adapter = new AwsBackupFiniteExpiryAdapter([
      { region: 'us-east-1', name: 'primary-vault', client: backupClient('us-east-1', 'primary-vault', 10) },
      { region: 'us-west-2', name: 'recovery-vault', client: backupClient('us-west-2', 'recovery-vault', 20) },
    ], 35, 'approved-backup-policy');
    await expect(adapter.verifyReady()).resolves.toBeUndefined();
    const primary = await adapter.erase({ checkpoint: {} });
    expect(primary).toMatchObject({ done: false, checkpoint: { vaultIndex: 1 } });
    const recovery = await adapter.erase({ checkpoint: primary.checkpoint });
    expect(recovery).toMatchObject({ done: true, checkpoint: { backupVaults: [
      { region: 'us-east-1', name: 'primary-vault' },
      { region: 'us-west-2', name: 'recovery-vault' },
    ] } });
  });

  it('composes exactly one concrete adapter for every production resource', async () => {
    const pool = sqlPool(async () => ({ rows: [], rowCount: 0 }));
    const envelope: EnvelopeCrypto = {
      provider: 'aws-kms',
      async encrypt(value) { return `v2.aws-kms.${Buffer.from(value).toString('base64')}`; },
      async decrypt(value) { return Buffer.from(value.split('.').at(-1)!, 'base64').toString('utf8'); },
    };
    const pseudonymizer: TenantPseudonymizer = {
      keyVersion: 'kms-key',
      async pseudonym(_domain, value) { return createHashForTest(value); },
    };
    const queues = REQUIRED_GOVERNANCE_QUEUE_NAMES.map(() => ({ close: async () => undefined })) as unknown as Queue[];
    const runtime = createProductionGovernanceAdapters(pool, pseudonymizer, {
      NODE_ENV: 'production',
      AWS_REGION: 'us-east-1',
      AWS_ACCOUNT_ID: '123456789012',
      ARTIFACT_S3_BUCKET: 'sentinel-artifacts-prod',
      ARTIFACT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/artifact-key',
      GOVERNANCE_ARTIFACT_BUCKETS: JSON.stringify([{
        region: 'us-east-1',
        name: 'sentinel-artifacts-prod',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/artifact-key',
      }]),
      AUDIT_EXPORT_S3_BUCKET: 'sentinel-audit-prod',
      AUDIT_EXPORT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/audit-key',
      GOVERNANCE_BULLMQ_QUEUES: JSON.stringify(REQUIRED_GOVERNANCE_QUEUE_NAMES),
      REDIS_URL: 'rediss://redis.internal:6379',
      STEEL_CONNECTOR_MODE: 'cloud',
      STEEL_API_KEY: 'steel-key',
      KEYCLOAK_ADMIN_BASE_URL: 'https://identity.example',
      KEYCLOAK_REALM: 'sentinel',
      KEYCLOAK_ERASURE_CLIENT_ID: 'sentinel-erasure',
      KEYCLOAK_ERASURE_CLIENT_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:keycloak',
      OBSERVABILITY_ERASURE_URL: 'https://observability.example/erase',
      OBSERVABILITY_ERASURE_READINESS_URL: 'https://observability.example/ready',
      OBSERVABILITY_ERASURE_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:observability',
      GOVERNANCE_BACKUP_VAULTS: JSON.stringify([{ region: 'us-east-1', name: 'sentinel-production' }]),
      BACKUP_LEGAL_BASIS_REFERENCE: 'retention-policy-v1',
      AUDIT_LEGAL_BASIS_REFERENCE: 'security-audit-policy-v1',
    } as NodeJS.ProcessEnv, {
      s3: {} as S3Client,
      secretsManager: {} as SecretsManagerClient,
      backup: {} as BackupClient,
      redis: {} as Redis,
      envelope,
      queues,
      auditReceiptSigner: { async sign() { return { keyId: 'kms-signing-key', signature: 'signature' }; } },
    });
    expect(runtime.retentionAdapters.map((adapter) => adapter.resourceKind).sort()).toEqual([...RETENTION_RESOURCE_KINDS].sort());
    expect(runtime.erasureAdapters.map((adapter) => adapter.resourceKind)).toEqual(PRODUCTION_TENANT_ERASURE_RESOURCES);
    await runtime.close();
  });
});

function createHashForTest(value: string): string {
  return Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64);
}
