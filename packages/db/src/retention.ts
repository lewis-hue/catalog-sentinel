import { randomUUID } from 'node:crypto';
import type {
  GovernanceActor,
  GovernanceSqlClient,
  GovernanceSqlPool,
  RetentionPolicyRecord,
  RetentionRunRecord,
} from './governance-types';
import {
  GovernanceAuthorizationError,
  GovernanceConflictError,
  GovernanceValidationError,
} from './governance-types';

export const RETENTION_RESOURCE_KINDS = [
  'catalog_snapshots',
  'scan_history',
  'evidence_artifacts',
  'browser_state',
  'invitation_records',
  'operational_jobs',
] as const;

export type RetentionResourceKind = typeof RETENTION_RESOURCE_KINDS[number];

export interface RetentionPolicyWriter {
  setTenantPolicy(actor: GovernanceActor, input: {
    resourceKind: RetentionResourceKind;
    retentionDays: number;
    deletionGraceDays: number;
    enabled: boolean;
    nextRunAt: string;
    expectedVersion: number | null;
  }): Promise<RetentionPolicyRecord>;
}

export interface RetentionSchedulerRepository extends RetentionPolicyWriter {
  scheduleDue(now: string, cadenceMs: number, limit: number): Promise<RetentionRunRecord[]>;
  claimRuns(options: { limit: number; leaseMs: number }): Promise<RetentionRunRecord[]>;
  saveBatch(input: {
    runId: string;
    leaseToken: string;
    cursor: Record<string, unknown>;
    deletedCount: bigint;
    done: boolean;
  }): Promise<boolean>;
  retryRun(runId: string, leaseToken: string, error: string, retryAfterMs: number): Promise<boolean>;
}

interface PolicyRow {
  id: string;
  tenantId: string | null;
  resourceKind: RetentionResourceKind;
  retentionDays: number;
  deletionGraceDays: number;
  enabled: boolean;
  version: number;
  nextRunAt: Date | string;
  updatedBySubjectId: string;
}

interface RunRow {
  id: string;
  policyId: string;
  tenantId: string | null;
  resourceKind: RetentionResourceKind;
  status: RetentionRunRecord['status'];
  cutoffAt: Date | string;
  cursor: Record<string, unknown> | null;
  deletedCount: bigint | number | string;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  lastError: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapPolicy(row: PolicyRow): RetentionPolicyRecord {
  return { ...row, nextRunAt: iso(row.nextRunAt) };
}

function mapRun(row: RunRow): RetentionRunRecord {
  return {
    ...row,
    cutoffAt: iso(row.cutoffAt),
    cursor: row.cursor ?? {},
    deletedCount: BigInt(row.deletedCount),
    leaseExpiresAt: row.leaseExpiresAt === null ? null : iso(row.leaseExpiresAt),
  };
}

async function transaction<T>(pool: GovernanceSqlPool, work: (client: GovernanceSqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    let releaseError: Error | undefined;
    try { await client.query('ROLLBACK'); } catch { releaseError = error; }
    client.release(releaseError);
    throw error;
  }
}

/** Durable policy scheduler and leased run state. It deliberately has no timer of its own. */
export class PostgresRetentionRepository implements RetentionSchedulerRepository {
  constructor(private readonly pool: GovernanceSqlPool) {}

  async setTenantPolicy(actor: GovernanceActor, input: {
    resourceKind: RetentionResourceKind;
    retentionDays: number;
    deletionGraceDays: number;
    enabled: boolean;
    nextRunAt: string;
    expectedVersion: number | null;
  }): Promise<RetentionPolicyRecord> {
    if (!RETENTION_RESOURCE_KINDS.includes(input.resourceKind)) throw new GovernanceValidationError('Unsupported retention resource kind.');
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3_650) {
      throw new GovernanceValidationError('retentionDays must be an integer from 1 through 3650.');
    }
    if (!Number.isInteger(input.deletionGraceDays) || input.deletionGraceDays < 0 || input.deletionGraceDays > 365) {
      throw new GovernanceValidationError('deletionGraceDays must be an integer from 0 through 365.');
    }
    const nextRunAt = new Date(input.nextRunAt);
    if (!Number.isFinite(nextRunAt.getTime())) throw new GovernanceValidationError('nextRunAt must be an ISO timestamp.');

    return transaction(this.pool, async (client) => {
      const authority = await client.query<{ role: string }>(
        `SELECT "role" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE' FOR SHARE`,
        [actor.tenantId, actor.subjectId],
      );
      if (!['OWNER', 'ADMIN'].includes(authority.rows[0]?.role ?? '')) throw new GovernanceAuthorizationError();

      const scopeKey = `tenant:${actor.tenantId}`;
      const existing = await client.query<PolicyRow>(
        `SELECT * FROM "RetentionPolicy" WHERE "scopeKey" = $1 AND "resourceKind" = $2 FOR UPDATE`,
        [scopeKey, input.resourceKind],
      );
      let result;
      if (!existing.rows[0]) {
        if (input.expectedVersion !== null) throw new GovernanceConflictError('Retention policy version does not match.');
        result = await client.query<PolicyRow>(
          `INSERT INTO "RetentionPolicy"
             ("id", "tenantId", "scopeKey", "resourceKind", "retentionDays", "deletionGraceDays",
              "enabled", "version", "nextRunAt", "updatedBySubjectId", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::timestamptz, $9, clock_timestamp(), clock_timestamp())
           RETURNING *`,
          [`retention_${randomUUID()}`, actor.tenantId, scopeKey, input.resourceKind, input.retentionDays,
            input.deletionGraceDays, input.enabled, nextRunAt.toISOString(), actor.subjectId],
        );
      } else {
        if (input.expectedVersion !== existing.rows[0].version) throw new GovernanceConflictError('Retention policy version does not match.');
        result = await client.query<PolicyRow>(
          `UPDATE "RetentionPolicy" SET "retentionDays" = $3, "deletionGraceDays" = $4,
             "enabled" = $5, "nextRunAt" = $6::timestamptz, "updatedBySubjectId" = $7,
             "version" = "version" + 1, "updatedAt" = clock_timestamp()
           WHERE "scopeKey" = $1 AND "resourceKind" = $2 RETURNING *`,
          [scopeKey, input.resourceKind, input.retentionDays, input.deletionGraceDays,
            input.enabled, nextRunAt.toISOString(), actor.subjectId],
        );
      }
      return mapPolicy(result.rows[0]!);
    });
  }

  async scheduleDue(nowValue: string, cadenceMsValue: number, limitValue: number): Promise<RetentionRunRecord[]> {
    const now = new Date(nowValue);
    if (!Number.isFinite(now.getTime())) throw new GovernanceValidationError('Scheduler time must be an ISO timestamp.');
    const cadenceMs = Math.max(60_000, Math.floor(cadenceMsValue));
    const limit = Math.max(1, Math.min(100, Math.floor(limitValue)));
    return transaction(this.pool, async (client) => {
      const due = await client.query<PolicyRow>(
        `SELECT * FROM "RetentionPolicy"
         WHERE "enabled" = true AND "nextRunAt" <= $1::timestamptz
         ORDER BY "nextRunAt", "id" FOR UPDATE SKIP LOCKED LIMIT $2`,
        [now.toISOString(), limit],
      );
      const runs: RetentionRunRecord[] = [];
      for (const policy of due.rows) {
        const scheduledFor = iso(policy.nextRunAt);
        const cutoff = new Date(now.getTime() - (policy.retentionDays + policy.deletionGraceDays) * 86_400_000);
        const inserted = await client.query<RunRow>(
          `INSERT INTO "RetentionRun"
             ("id", "policyId", "tenantId", "idempotencyKey", "status", "cutoffAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, 'PENDING', $5::timestamptz, clock_timestamp(), clock_timestamp())
           ON CONFLICT ("policyId", "idempotencyKey") DO UPDATE SET "updatedAt" = "RetentionRun"."updatedAt"
           RETURNING *, $6::text AS "resourceKind"`,
          [`retentionrun_${randomUUID()}`, policy.id, policy.tenantId, scheduledFor, cutoff.toISOString(), policy.resourceKind],
        );
        runs.push(mapRun(inserted.rows[0]!));
        await client.query(
          `UPDATE "RetentionPolicy" SET "nextRunAt" = $2::timestamptz + ($3::double precision * interval '1 millisecond'),
             "updatedAt" = clock_timestamp() WHERE "id" = $1`,
          [policy.id, scheduledFor, cadenceMs],
        );
      }
      return runs;
    });
  }

  async claimRuns(options: { limit: number; leaseMs: number }): Promise<RetentionRunRecord[]> {
    const leaseToken = randomUUID();
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const leaseMs = Math.max(5_000, Math.floor(options.leaseMs));
    return transaction(this.pool, async (client) => {
      const result = await client.query<RunRow>(
        `WITH due AS (
           SELECT run."id" FROM "RetentionRun" AS run
           WHERE run."status" IN ('PENDING', 'FAILED', 'RUNNING') AND run."availableAt" <= clock_timestamp()
             AND (run."leaseExpiresAt" IS NULL OR run."leaseExpiresAt" <= clock_timestamp())
           ORDER BY run."availableAt", run."createdAt", run."id"
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE "RetentionRun" AS run SET "status" = 'RUNNING', "attempts" = run."attempts" + 1,
           "leaseToken" = $2, "leaseExpiresAt" = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
           "startedAt" = COALESCE(run."startedAt", clock_timestamp()), "lastError" = NULL, "updatedAt" = clock_timestamp()
         FROM due, "RetentionPolicy" AS policy
         WHERE run."id" = due."id" AND policy."id" = run."policyId"
         RETURNING run.*, policy."resourceKind"`,
        [limit, leaseToken, leaseMs],
      );
      return result.rows.map(mapRun);
    });
  }

  async saveBatch(input: {
    runId: string;
    leaseToken: string;
    cursor: Record<string, unknown>;
    deletedCount: bigint;
    done: boolean;
  }): Promise<boolean> {
    if (input.deletedCount < 0n) throw new GovernanceValidationError('Retention deletion count cannot be negative.');
    return this.cas(
      `UPDATE "RetentionRun" SET "cursor" = $3::jsonb, "deletedCount" = "deletedCount" + $4::bigint,
         "status" = CASE WHEN $5 THEN 'SUCCEEDED'::"GovernanceJobStatus" ELSE 'PENDING'::"GovernanceJobStatus" END,
         "completedAt" = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
         "availableAt" = CASE WHEN $5 THEN "availableAt" ELSE clock_timestamp() END,
         "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
       WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'RUNNING' AND "leaseExpiresAt" > clock_timestamp()`,
      [input.runId, input.leaseToken, JSON.stringify(input.cursor), input.deletedCount.toString(), input.done],
    );
  }

  async retryRun(runId: string, leaseToken: string, error: string, retryAfterMs: number): Promise<boolean> {
    return this.cas(
      `UPDATE "RetentionRun" SET "status" = 'FAILED',
         "availableAt" = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
         "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastError" = $4, "updatedAt" = clock_timestamp()
       WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'RUNNING'
         AND "leaseExpiresAt" > clock_timestamp()`,
      [runId, leaseToken, Math.max(0, Math.floor(retryAfterMs)), error.slice(0, 2_048)],
    );
  }

  private async cas(sql: string, values: readonly unknown[]): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(sql, values);
      return (result.rowCount ?? 0) === 1;
    });
  }
}

export interface RetentionAdapter {
  readonly resourceKind: RetentionResourceKind;
  /** Must be idempotent: a process can terminate after deletion but before its checkpoint commit. */
  deleteBefore(input: {
    tenantId: string | null;
    cutoffAt: string;
    cursor: Record<string, unknown>;
  }): Promise<{ done: boolean; deletedCount: bigint; cursor: Record<string, unknown> }>;
}

export class RetentionWorker {
  private readonly adapters: Map<RetentionResourceKind, RetentionAdapter>;

  constructor(private readonly repository: RetentionSchedulerRepository, adapters: readonly RetentionAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.resourceKind, adapter]));
    if (this.adapters.size !== adapters.length) throw new GovernanceValidationError('Retention adapters must have unique resource kinds.');
  }

  async process(run: RetentionRunRecord): Promise<'completed' | 'checkpointed' | 'retried'> {
    if (!run.leaseToken) throw new GovernanceValidationError('A claimed retention run requires a lease token.');
    const adapter = this.adapters.get(run.resourceKind as RetentionResourceKind);
    if (!adapter) {
      await this.repository.retryRun(run.id, run.leaseToken, `No production adapter for ${run.resourceKind}.`, 300_000);
      return 'retried';
    }
    try {
      const result = await adapter.deleteBefore({ tenantId: run.tenantId, cutoffAt: run.cutoffAt, cursor: run.cursor });
      if (result.deletedCount < 0n) throw new GovernanceValidationError('Retention adapter returned a negative deletion count.');
      if (!await this.repository.saveBatch({ runId: run.id, leaseToken: run.leaseToken, ...result })) {
        throw new GovernanceConflictError('Retention lease was lost while saving its outcome.');
      }
      return result.done ? 'completed' : 'checkpointed';
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await this.repository.retryRun(run.id, run.leaseToken, error.message, 30_000);
      return 'retried';
    }
  }
}
