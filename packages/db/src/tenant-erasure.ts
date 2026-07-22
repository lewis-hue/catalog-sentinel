import { createHmac, randomUUID } from 'node:crypto';
import type {
  GovernanceActor,
  GovernanceSqlClient,
  GovernanceSqlPool,
  TenantErasureRequestRecord,
  TenantErasureStepRecord,
} from './governance-types';
import {
  GovernanceAuthorizationError,
  GovernanceConflictError,
  GovernanceValidationError,
} from './governance-types';

/** Ordered so remote/ephemeral data is destroyed before its durable lookup records. */
export const PRODUCTION_TENANT_ERASURE_RESOURCES = [
  'steel_sessions',
  'identity_memberships',
  'secret_references',
  'object_storage_objects',
  'queue_jobs',
  'redis_keys',
  'postgres_tenant_rows',
  'observability_records',
  'backup_expiry',
  'audit_legal_record',
] as const;

export type TenantErasureResource = typeof PRODUCTION_TENANT_ERASURE_RESOURCES[number];
const LEGAL_HOLD_RESOURCES: readonly TenantErasureResource[] = ['backup_expiry', 'audit_legal_record'];

export interface ClaimedTenantErasure extends TenantErasureRequestRecord {
  tenantId: string;
  leaseToken: string;
}

export interface TenantErasureRepository {
  request(actor: GovernanceActor, input: { idempotencyKey: string; reason: string }): Promise<TenantErasureRequestRecord>;
  get(actor: GovernanceActor, requestId: string): Promise<TenantErasureRequestRecord | null>;
  claim(options: { limit: number; leaseMs: number }): Promise<ClaimedTenantErasure[]>;
  renew(requestId: string, leaseToken: string, leaseMs: number): Promise<boolean>;
  startStep(requestId: string, leaseToken: string, resourceKind: TenantErasureResource): Promise<TenantErasureStepRecord | null>;
  checkpointStep(input: {
    requestId: string;
    leaseToken: string;
    resourceKind: TenantErasureResource;
    checkpoint: Record<string, unknown>;
    deletedCount: bigint;
  }): Promise<boolean>;
  finishStep(input: {
    requestId: string;
    leaseToken: string;
    resourceKind: TenantErasureResource;
    deletedCount: bigint;
    checkpoint: Record<string, unknown>;
    legalBasis?: string;
  }): Promise<boolean>;
  retry(requestId: string, leaseToken: string, error: string, retryAfterMs: number): Promise<boolean>;
  complete(requestId: string, leaseToken: string): Promise<boolean>;
}

export interface TenantPseudonymizer {
  readonly keyVersion: string;
  pseudonym(domain: 'tenant' | 'subject', value: string): Promise<string>;
}

/** HMAC implementation for deployments whose key is supplied by a secret manager. */
export class HmacTenantPseudonymizer implements TenantPseudonymizer {
  readonly keyVersion: string;
  private readonly key: Buffer;

  constructor(key: string | Uint8Array, keyVersion: string) {
    this.key = Buffer.from(key);
    this.keyVersion = validateShort(keyVersion, 'pseudonymKeyVersion', 100);
    if (this.key.byteLength < 32) throw new GovernanceValidationError('Erasure pseudonym HMAC key must contain at least 32 bytes.');
  }

  async pseudonym(domain: 'tenant' | 'subject', value: string): Promise<string> {
    return createHmac('sha256', this.key).update(`${domain}\0${value}`, 'utf8').digest('hex');
  }
}

interface ErasureRow {
  id: string;
  tenantId: string | null;
  tenantHash: string;
  requestedBySubjectHash: string;
  pseudonymKeyVersion: string;
  idempotencyKey: string;
  reason: string;
  status: TenantErasureRequestRecord['status'];
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  lastError: string | null;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

interface ErasureStepRow {
  id: string;
  requestId: string;
  resourceKind: string;
  status: TenantErasureStepRecord['status'];
  deletedCount: bigint | string | number;
  checkpoint: Record<string, unknown> | null;
  legalBasis: string | null;
  lastError: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function mapStep(row: ErasureStepRow): TenantErasureStepRecord {
  return {
    ...row,
    deletedCount: BigInt(row.deletedCount),
    checkpoint: row.checkpoint ?? {},
    startedAt: nullableIso(row.startedAt),
    completedAt: nullableIso(row.completedAt),
  };
}

function validateShort(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || [...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new GovernanceValidationError(`${label} is invalid.`);
  }
  return normalized;
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

/** SQL-backed request/lease state. It never receives adapters or infrastructure credentials. */
export class PostgresTenantErasureRepository implements TenantErasureRepository {
  private readonly pseudonymizer: TenantPseudonymizer;

  constructor(
    private readonly pool: GovernanceSqlPool,
    pseudonymizerOrKey: TenantPseudonymizer | string | Uint8Array,
    pseudonymKeyVersion = 'v1',
  ) {
    this.pseudonymizer = typeof pseudonymizerOrKey === 'string' || pseudonymizerOrKey instanceof Uint8Array
      ? new HmacTenantPseudonymizer(pseudonymizerOrKey, pseudonymKeyVersion)
      : pseudonymizerOrKey;
    validateShort(this.pseudonymizer.keyVersion, 'pseudonymKeyVersion', 100);
  }

  async request(actor: GovernanceActor, input: { idempotencyKey: string; reason: string }): Promise<TenantErasureRequestRecord> {
    const idempotencyKey = validateShort(input.idempotencyKey, 'idempotencyKey', 200);
    const reason = validateShort(input.reason, 'reason', 1_000);
    const tenantHash = await this.pseudonymizer.pseudonym('tenant', actor.tenantId);
    const subjectHash = await this.pseudonymizer.pseudonym('subject', actor.subjectId);
    return transaction(this.pool, async (client) => {
      // First-login provisioning takes the same per-tenant advisory lock. Whichever operation
      // commits first becomes authoritative, so provisioning cannot race past an erasure request.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`tenant-erasure:${actor.tenantId}`]);
      const authority = await client.query<{ role: string }>(
        `SELECT "role" FROM "OrganizationMembership"
         WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE' FOR SHARE`,
        [actor.tenantId, actor.subjectId],
      );
      if (authority.rows[0]?.role !== 'OWNER') throw new GovernanceAuthorizationError('Only an active organization owner can request tenant erasure.');

      const inserted = await client.query<ErasureRow>(
        `INSERT INTO "TenantErasureRequest"
           ("id", "tenantId", "tenantHash", "requestedBySubjectHash", "pseudonymKeyVersion", "idempotencyKey", "reason",
            "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', clock_timestamp(), clock_timestamp())
         ON CONFLICT ("tenantHash", "idempotencyKey") DO NOTHING RETURNING *`,
        [`erase_${randomUUID()}`, actor.tenantId, tenantHash, subjectHash, this.pseudonymizer.keyVersion, idempotencyKey, reason],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<ErasureRow>(
          `SELECT * FROM "TenantErasureRequest" WHERE "tenantHash" = $1 AND "idempotencyKey" = $2 FOR SHARE`,
          [tenantHash, idempotencyKey],
        );
        row = existing.rows[0];
        if (!row || row.reason !== reason) throw new GovernanceConflictError('The idempotency key is bound to a different erasure request.');
      } else {
        for (const resourceKind of PRODUCTION_TENANT_ERASURE_RESOURCES) {
          await client.query(
            `INSERT INTO "TenantErasureStep"
               ("id", "requestId", "resourceKind", "status", "updatedAt")
             VALUES ($1, $2, $3, 'PENDING', clock_timestamp())`,
            [`erasestep_${randomUUID()}`, row.id, resourceKind],
          );
        }
      }
      return this.loadRequest(client, row);
    });
  }

  async get(actor: GovernanceActor, requestIdValue: string): Promise<TenantErasureRequestRecord | null> {
    const requestId = validateShort(requestIdValue, 'requestId', 255);
    const tenantHash = await this.pseudonymizer.pseudonym('tenant', actor.tenantId);
    const subjectHash = await this.pseudonymizer.pseudonym('subject', actor.subjectId);
    return transaction(this.pool, async (client) => {
      const result = await client.query<ErasureRow>(
        `SELECT * FROM "TenantErasureRequest"
         WHERE "id" = $1 AND "tenantHash" = $2`,
        [requestId, tenantHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      // postgres_tenant_rows intentionally destroys membership. The original verified requester
      // remains able to fetch the retained receipt through its KMS-HMAC subject binding; other
      // authorized viewers still require a current OWNER/ADMIN/AUDITOR membership.
      if (row.requestedBySubjectHash !== subjectHash) {
        const member = await client.query(
          `SELECT 1 FROM "OrganizationMembership"
           WHERE "tenantId" = $1 AND "subjectId" = $2 AND "status" = 'ACTIVE' AND "role" IN ('OWNER', 'ADMIN', 'AUDITOR')`,
          [actor.tenantId, actor.subjectId],
        );
        if ((member.rowCount ?? 0) !== 1) throw new GovernanceAuthorizationError();
      }
      return this.loadRequest(client, row);
    });
  }

  async claim(options: { limit: number; leaseMs: number }): Promise<ClaimedTenantErasure[]> {
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
    const leaseMs = Math.max(5_000, Math.floor(options.leaseMs));
    const leaseToken = randomUUID();
    return transaction(this.pool, async (client) => {
      const result = await client.query<ErasureRow>(
        `WITH due AS (
           SELECT "id" FROM "TenantErasureRequest"
           WHERE "status" IN ('PENDING', 'FAILED', 'RUNNING') AND "availableAt" <= clock_timestamp()
             AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
           ORDER BY "availableAt", "createdAt", "id"
           FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE "TenantErasureRequest" AS request SET
           "status" = 'RUNNING', "attempts" = request."attempts" + 1,
           "leaseToken" = $2, "leaseExpiresAt" = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
           "startedAt" = COALESCE(request."startedAt", clock_timestamp()), "lastError" = NULL,
           "updatedAt" = clock_timestamp()
         FROM due WHERE request."id" = due."id" RETURNING request.*`,
        [limit, leaseToken, leaseMs],
      );
      const claimed: ClaimedTenantErasure[] = [];
      for (const row of result.rows) {
        const mapped = await this.loadRequest(client, row);
        if (!mapped.tenantId || !mapped.leaseToken) throw new GovernanceConflictError('Claimed erasure is missing live tenant lease state.');
        claimed.push({ ...mapped, tenantId: mapped.tenantId, leaseToken: mapped.leaseToken });
      }
      return claimed;
    });
  }

  async renew(requestId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    return this.executeCas(
      `UPDATE "TenantErasureRequest" SET
         "leaseExpiresAt" = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
         "updatedAt" = clock_timestamp()
       WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'RUNNING'
         AND "leaseExpiresAt" > clock_timestamp()`,
      [requestId, leaseToken, Math.max(5_000, Math.floor(leaseMs))],
    );
  }

  async startStep(requestId: string, leaseToken: string, resourceKind: TenantErasureResource): Promise<TenantErasureStepRecord | null> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<ErasureStepRow>(
        `UPDATE "TenantErasureStep" AS step SET
           "status" = 'RUNNING', "startedAt" = COALESCE(step."startedAt", clock_timestamp()),
           "lastError" = NULL, "updatedAt" = clock_timestamp()
         FROM "TenantErasureRequest" AS request
         WHERE step."requestId" = request."id" AND request."id" = $1 AND request."leaseToken" = $2
           AND request."status" = 'RUNNING' AND request."leaseExpiresAt" > clock_timestamp()
           AND step."resourceKind" = $3 AND step."status" IN ('PENDING', 'FAILED', 'RUNNING')
         RETURNING step.*`,
        [requestId, leaseToken, resourceKind],
      );
      return result.rows[0] ? mapStep(result.rows[0]) : null;
    });
  }

  async checkpointStep(input: {
    requestId: string;
    leaseToken: string;
    resourceKind: TenantErasureResource;
    checkpoint: Record<string, unknown>;
    deletedCount: bigint;
  }): Promise<boolean> {
    return this.stepCas(input, 'PENDING');
  }

  async finishStep(input: {
    requestId: string;
    leaseToken: string;
    resourceKind: TenantErasureResource;
    deletedCount: bigint;
    checkpoint: Record<string, unknown>;
    legalBasis?: string;
  }): Promise<boolean> {
    if (input.legalBasis !== undefined && !input.legalBasis.trim()) {
      throw new GovernanceValidationError('A legal-hold outcome requires a non-empty legal basis.');
    }
    if (input.legalBasis && !LEGAL_HOLD_RESOURCES.includes(input.resourceKind)) {
      throw new GovernanceValidationError(`Legal-hold completion is not permitted for ${input.resourceKind}.`);
    }
    return this.stepCas(input, input.legalBasis ? 'SKIPPED_LEGAL_HOLD' : 'SUCCEEDED');
  }

  async retry(requestId: string, leaseToken: string, error: string, retryAfterMs: number): Promise<boolean> {
    return this.executeCas(
      `UPDATE "TenantErasureRequest" SET "status" = 'FAILED',
         "availableAt" = clock_timestamp() + ($3::double precision * interval '1 millisecond'),
         "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastError" = $4, "updatedAt" = clock_timestamp()
       WHERE "id" = $1 AND "leaseToken" = $2 AND "status" = 'RUNNING'
         AND "leaseExpiresAt" > clock_timestamp()`,
      [requestId, leaseToken, Math.max(0, Math.floor(retryAfterMs)), error.slice(0, 2_048)],
    );
  }

  async complete(requestId: string, leaseToken: string): Promise<boolean> {
    return this.executeCas(
      `UPDATE "TenantErasureRequest" AS request SET
         "status" = 'SUCCEEDED', "tenantId" = NULL, "completedAt" = clock_timestamp(),
         "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL,
         "resultSummary" = jsonb_build_object(
           'resourceCount', (SELECT count(*) FROM "TenantErasureStep" WHERE "requestId" = request."id"),
           'deletedCount', (SELECT COALESCE(sum("deletedCount"), 0) FROM "TenantErasureStep" WHERE "requestId" = request."id"),
           'legalHoldCount', (SELECT count(*) FROM "TenantErasureStep" WHERE "requestId" = request."id" AND "status" = 'SKIPPED_LEGAL_HOLD')
         ), "updatedAt" = clock_timestamp()
       WHERE request."id" = $1 AND request."leaseToken" = $2 AND request."status" = 'RUNNING'
         AND request."leaseExpiresAt" > clock_timestamp()
         AND NOT EXISTS (
           SELECT 1 FROM "TenantErasureStep" WHERE "requestId" = request."id"
             AND "status" NOT IN ('SUCCEEDED', 'SKIPPED_LEGAL_HOLD')
         )
         AND (SELECT count(*) FROM "TenantErasureStep" WHERE "requestId" = request."id") = $3`,
      [requestId, leaseToken, PRODUCTION_TENANT_ERASURE_RESOURCES.length],
    );
  }

  private async loadRequest(client: GovernanceSqlClient, row: ErasureRow): Promise<TenantErasureRequestRecord> {
    const steps = await client.query<ErasureStepRow>(
      `SELECT * FROM "TenantErasureStep" WHERE "requestId" = $1 ORDER BY "id"`,
      [row.id],
    );
    const order = new Map(PRODUCTION_TENANT_ERASURE_RESOURCES.map((kind, index) => [kind, index]));
    const mappedSteps = steps.rows.map(mapStep).sort((a, b) => (order.get(a.resourceKind as TenantErasureResource) ?? 999) - (order.get(b.resourceKind as TenantErasureResource) ?? 999));
    return {
      ...row,
      leaseExpiresAt: nullableIso(row.leaseExpiresAt),
      createdAt: iso(row.createdAt),
      completedAt: nullableIso(row.completedAt),
      steps: mappedSteps,
    };
  }

  private async stepCas(
    input: { requestId: string; leaseToken: string; resourceKind: TenantErasureResource; checkpoint: Record<string, unknown>; deletedCount: bigint; legalBasis?: string },
    status: 'PENDING' | 'SUCCEEDED' | 'SKIPPED_LEGAL_HOLD',
  ): Promise<boolean> {
    return this.executeCas(
      `UPDATE "TenantErasureStep" AS step SET
         "status" = $4::"GovernanceStepStatus", "deletedCount" = step."deletedCount" + $5::bigint,
         "checkpoint" = $6::jsonb, "legalBasis" = $7, "completedAt" = CASE WHEN $4 = 'PENDING' THEN NULL ELSE clock_timestamp() END,
         "updatedAt" = clock_timestamp()
       FROM "TenantErasureRequest" AS request
       WHERE step."requestId" = request."id" AND request."id" = $1 AND request."leaseToken" = $2
         AND request."status" = 'RUNNING' AND request."leaseExpiresAt" > clock_timestamp()
         AND step."resourceKind" = $3 AND step."status" = 'RUNNING'`,
      [input.requestId, input.leaseToken, input.resourceKind, status, input.deletedCount.toString(), JSON.stringify(input.checkpoint), input.legalBasis?.trim() ?? null],
    );
  }

  private async executeCas(sql: string, values: readonly unknown[]): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(sql, values);
      return (result.rowCount ?? 0) === 1;
    });
  }
}

export interface TenantErasureBatchResult {
  done: boolean;
  deletedCount: bigint;
  checkpoint: Record<string, unknown>;
  /** A retained record is terminal only when a documented legal basis is supplied. */
  legalBasis?: string;
}

export interface TenantErasureAdapter {
  readonly resourceKind: TenantErasureResource;
  /** Must be idempotent: a process can terminate after deletion but before its checkpoint commit. */
  erase(input: {
    requestId: string;
    tenantId: string;
    checkpoint: Record<string, unknown>;
  }): Promise<TenantErasureBatchResult>;
}

/** Executes one durable batch. A scheduler repeatedly calls this; crashes resume from checkpoint. */
export class TenantErasureOrchestrator {
  private readonly adapters: Map<TenantErasureResource, TenantErasureAdapter>;

  constructor(private readonly repository: TenantErasureRepository, adapters: readonly TenantErasureAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.resourceKind, adapter]));
    const duplicateCount = adapters.length - this.adapters.size;
    const missing = PRODUCTION_TENANT_ERASURE_RESOURCES.filter((kind) => !this.adapters.has(kind));
    const unknown = [...this.adapters.keys()].filter((kind) => !PRODUCTION_TENANT_ERASURE_RESOURCES.includes(kind));
    if (duplicateCount > 0 || missing.length > 0 || unknown.length > 0) {
      throw new GovernanceValidationError(`Erasure adapter inventory mismatch (missing=${missing.join(',') || 'none'}, unknown=${unknown.join(',') || 'none'}, duplicates=${duplicateCount}).`);
    }
  }

  async processOne(claim: ClaimedTenantErasure, leaseMs = 60_000): Promise<'completed' | 'checkpointed' | 'retried'> {
    const step = claim.steps.find((candidate) => !['SUCCEEDED', 'SKIPPED_LEGAL_HOLD'].includes(candidate.status));
    if (!step) {
      if (!await this.repository.complete(claim.id, claim.leaseToken)) throw new GovernanceConflictError('Erasure completion lease was lost.');
      return 'completed';
    }
    const adapter = this.adapters.get(step.resourceKind as TenantErasureResource)!;
    if (!await this.repository.renew(claim.id, claim.leaseToken, leaseMs)) throw new GovernanceConflictError('Erasure lease was lost.');
    const started = await this.repository.startStep(claim.id, claim.leaseToken, adapter.resourceKind);
    if (!started) throw new GovernanceConflictError('Erasure step could not be leased.');
    try {
      const result = await adapter.erase({ requestId: claim.id, tenantId: claim.tenantId, checkpoint: started.checkpoint });
      if (result.deletedCount < 0n) throw new GovernanceValidationError('Erasure adapters cannot report a negative deletion count.');
      if (result.legalBasis && !result.done) throw new GovernanceValidationError('A legal-hold outcome must be terminal.');
      const saved = result.done
        ? await this.repository.finishStep({ requestId: claim.id, leaseToken: claim.leaseToken, resourceKind: adapter.resourceKind, ...result })
        : await this.repository.checkpointStep({ requestId: claim.id, leaseToken: claim.leaseToken, resourceKind: adapter.resourceKind, ...result });
      if (!saved) throw new GovernanceConflictError('Erasure step lease was lost while saving its outcome.');
      if (!result.done) {
        await this.repository.retry(claim.id, claim.leaseToken, 'Resource has another deletion batch.', 0);
        return 'checkpointed';
      }
      const terminalAfterThis = claim.steps.every((candidate) => candidate.id === step.id || ['SUCCEEDED', 'SKIPPED_LEGAL_HOLD'].includes(candidate.status));
      if (terminalAfterThis) {
        if (!await this.repository.complete(claim.id, claim.leaseToken)) throw new GovernanceConflictError('Erasure completion lease was lost.');
        return 'completed';
      }
      await this.repository.retry(claim.id, claim.leaseToken, 'Continuing with the next erasure resource.', 0);
      return 'checkpointed';
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await this.repository.retry(claim.id, claim.leaseToken, error.message, 30_000);
      return 'retried';
    }
  }
}

const DIRECT_TENANT_TABLES = [
  'RetentionRun', 'RetentionPolicy', 'ConsentRevocationIntent', 'DistributorLinkRecord',
  'ObjectStorageArtifact', 'ScanEvent', 'DistributorEndpointCandidate', 'DistributorEndpointProfile',
  'DistributorTrackOutcome', 'DistributorReleaseOutcome', 'DistributorExtractionSnapshot',
  'DistributorTrack', 'DistributorRelease', 'DistributorCatalogSnapshot', 'DeepScanCheckpoint',
  'DeepScanRun', 'DistributorConnection', 'BrowserStateRef', 'BrowserLinkSession', 'scan_records',
  'DistroKidSnapshotCheckpoint',
] as const;

const CASCADE_TENANT_TABLES = [
  'User', 'Workspace', 'OrganizationMembership', 'WorkspaceMembership',
  'OrganizationInvitation', 'InvitationWorkspaceGrant', 'AuditLog',
  'DistroKidCheckpointIndex', 'DistroKidCheckpointOutcome', 'DistroKidCheckpointProgress',
  'DistroKidCheckpointChunk', 'DistroKidCheckpointPassPlanChunk', 'DistroKidCheckpointTerminal',
] as const;

const RETAINED_TENANT_TABLES = [
  'security_audit_events', 'audit_chain_heads', 'audit_chain_anchors', 'audit_anchor_outbox',
  'audit_purge_guards', 'TenantErasureRequest',
] as const;

/**
 * Final in-database adapter. It discovers every tenant-bearing table and refuses to delete if a
 * migration introduced one without an explicit policy here. External object/session deletion must
 * complete first; deleting an ObjectStorageArtifact row is not treated as deleting the object.
 */
export class PostgresTenantRowsErasureAdapter implements TenantErasureAdapter {
  readonly resourceKind = 'postgres_tenant_rows' as const;

  constructor(private readonly pool: GovernanceSqlPool) {}

  async erase(input: { tenantId: string; checkpoint: Record<string, unknown> }): Promise<TenantErasureBatchResult> {
    return transaction(this.pool, async (client) => {
      const discovered = await client.query<{ tableName: string }>(
        `SELECT DISTINCT table_name AS "tableName" FROM information_schema.columns
         WHERE table_schema = current_schema() AND column_name IN ('tenantId', 'tenant_id')`,
      );
      const governed = new Set<string>([...DIRECT_TENANT_TABLES, ...CASCADE_TENANT_TABLES, ...RETAINED_TENANT_TABLES]);
      const unknown = discovered.rows.map((row) => row.tableName).filter((table) => !governed.has(table));
      if (unknown.length > 0) {
        throw new GovernanceConflictError(`Refusing incomplete tenant erasure; unclassified tenant tables: ${unknown.sort().join(', ')}.`);
      }

      let deletedCount = 0n;
      for (const table of DIRECT_TENANT_TABLES) {
        const column = table === 'scan_records' ? 'tenant_id' : 'tenantId';
        const result = await client.query(`DELETE FROM "${table}" WHERE "${column}" = $1`, [input.tenantId]);
        deletedCount += BigInt(result.rowCount ?? 0);
      }
      const tenant = await client.query(`DELETE FROM "Tenant" WHERE "id" = $1`, [input.tenantId]);
      deletedCount += BigInt(tenant.rowCount ?? 0);
      return { done: true, deletedCount, checkpoint: { verifiedInventory: true } };
    });
  }
}
