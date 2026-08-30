import {
  DISTROKID_JOB_SCHEMA_VERSION,
  DISTROKID_SESSION_CLEANUP_GRACE_MS,
  catalogIndexJobSchema,
  type CatalogIndexJob,
} from '@sentinel/contracts';

/** Narrow structural SQL surface shared by pg.Pool and focused tests. */
export interface DistroKidRecoverySqlPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface DistroKidRecoveryRepository {
  /**
   * Persist before Redis submission. On an idempotent replay, the first durable ciphertext and
   * deadline win so randomized envelope encryption cannot create two authorities for one scan.
   */
  prepare(job: CatalogIndexJob): Promise<CatalogIndexJob>;
  /** Includes expired rows: recovery must terminalize/release them, not silently forget them. */
  list(limit?: number): Promise<CatalogIndexJob[]>;
  /** Clear reconnect authority only after Steel is terminally released (or already expired). */
  clear(job: Pick<CatalogIndexJob, 'tenantId' | 'connectionId' | 'snapshotId'>): Promise<boolean>;
}

interface RecoveryRow extends Record<string, unknown> {
  tenantId: string;
  connectionId: string;
  snapshotId: string;
  distributor: string;
  artists: string[];
  consentId: string;
  steelSessionId: string;
  sessionExpiresAt: Date | string;
  deadlineAt: Date | string;
  schemaVersion: number;
}

const rowProjection = `
  "userId" AS "tenantId", "connectionId", "snapshotId", "distributor",
  "recoveryArtists" AS "artists",
  "recoveryConsentId" AS "consentId",
  "recoverySteelSessionIdEncrypted" AS "steelSessionId",
  "recoverySessionExpiresAt" AS "sessionExpiresAt",
  "recoveryDeadlineAt" AS "deadlineAt",
  "recoverySchemaVersion" AS "schemaVersion"`;

const dateIso = (value: Date | string): string => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid durable DistroKid recovery timestamp');
  return parsed.toISOString();
};

function validatedRecoveryJob(raw: unknown, nowMs?: number): CatalogIndexJob {
  const parsed = catalogIndexJobSchema.parse(raw);
  if (parsed.distributor !== 'distrokid') throw new Error('durable DistroKid recovery envelope has the wrong distributor');
  if (!parsed.consentId) {
    throw new Error('durable DistroKid recovery envelope requires a durable consent binding');
  }
  if (!parsed.steelSessionId || !/^v[12]\./.test(parsed.steelSessionId) || parsed.steelSessionId.length > 16_384) {
    throw new Error('durable DistroKid recovery requires an application-envelope-encrypted Steel handle');
  }
  if (!parsed.sessionExpiresAt || !parsed.deadlineAt) {
    throw new Error('durable DistroKid recovery requires the actual session expiry and immutable deadline');
  }
  const expiry = Date.parse(parsed.sessionExpiresAt);
  const deadline = Date.parse(parsed.deadlineAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(deadline)
      || deadline > expiry - DISTROKID_SESSION_CLEANUP_GRACE_MS) {
    throw new Error('durable DistroKid recovery deadline does not preserve the Steel cleanup reserve');
  }
  if ((parsed.schemaVersion ?? 0) !== DISTROKID_JOB_SCHEMA_VERSION) {
    throw new Error('durable DistroKid recovery schema version is unsupported');
  }
  if (nowMs !== undefined && expiry <= nowMs) {
    throw new Error('cannot create durable recovery authority for an expired Steel session');
  }
  return parsed;
}

function fromRow(row: RecoveryRow): CatalogIndexJob {
  return validatedRecoveryJob({
    tenantId: row.tenantId,
    connectionId: row.connectionId,
    snapshotId: row.snapshotId,
    distributor: row.distributor,
    artists: row.artists,
    consentId: row.consentId,
    // Per-user isolation collapsed the workspace binding into the owning subject: the durable
    // envelope keys off userId (projected as tenantId), and the scan id-namespace is that same
    // subject. No separate workspace column survives, so derive the slot from the subject.
    artistWorkspaceId: row.tenantId,
    steelSessionId: row.steelSessionId,
    sessionExpiresAt: dateIso(row.sessionExpiresAt),
    deadlineAt: dateIso(row.deadlineAt),
    schemaVersion: Number(row.schemaVersion),
  });
}

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

function sameImmutablePrincipal(existing: CatalogIndexJob, proposed: CatalogIndexJob): boolean {
  return existing.tenantId === proposed.tenantId
    && existing.connectionId === proposed.connectionId
    && existing.snapshotId === proposed.snapshotId
    && existing.distributor === proposed.distributor
    && sameStrings(existing.artists, proposed.artists)
    && existing.consentId === proposed.consentId
    && existing.sessionExpiresAt === proposed.sessionExpiresAt;
}

export class DistroKidRecoveryPrincipalMismatchError extends Error {
  constructor() {
    super('durable DistroKid recovery envelope does not match its immutable tenant/principal binding');
    this.name = 'DistroKidRecoveryPrincipalMismatchError';
  }
}

/** The snapshot already reached a durable terminal state and its Steel authority was cleared. */
export class DistroKidRecoveryAlreadyTerminalError extends Error {
  constructor() {
    super('durable DistroKid snapshot is already terminal');
    this.name = 'DistroKidRecoveryAlreadyTerminalError';
  }
}

export class PostgresDistroKidRecoveryRepository implements DistroKidRecoveryRepository {
  constructor(
    private readonly pool: DistroKidRecoverySqlPool,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: CatalogIndexJob): Promise<CatalogIndexJob> {
    const job = validatedRecoveryJob(input, this.now());
    const result = await this.pool.query<RecoveryRow>(
      `INSERT INTO "DistroKidSnapshotCheckpoint" AS checkpoint (
         "userId", "connectionId", "snapshotId", "distributor",
         "recoveryArtists", "recoveryConsentId",
         "recoverySteelSessionIdEncrypted", "recoverySessionExpiresAt",
         "recoveryDeadlineAt", "recoverySchemaVersion"
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz,$10)
       ON CONFLICT ("snapshotId") DO UPDATE SET
         "recoveryArtists" = COALESCE(checkpoint."recoveryArtists", EXCLUDED."recoveryArtists"),
         "recoveryConsentId" = COALESCE(checkpoint."recoveryConsentId", EXCLUDED."recoveryConsentId"),
         "recoverySteelSessionIdEncrypted" = COALESCE(checkpoint."recoverySteelSessionIdEncrypted", EXCLUDED."recoverySteelSessionIdEncrypted"),
         "recoverySessionExpiresAt" = COALESCE(checkpoint."recoverySessionExpiresAt", EXCLUDED."recoverySessionExpiresAt"),
         "recoveryDeadlineAt" = COALESCE(checkpoint."recoveryDeadlineAt", EXCLUDED."recoveryDeadlineAt"),
         "recoverySchemaVersion" = COALESCE(checkpoint."recoverySchemaVersion", EXCLUDED."recoverySchemaVersion")
       WHERE checkpoint."userId" = EXCLUDED."userId"
         AND checkpoint."connectionId" = EXCLUDED."connectionId"
         AND checkpoint."distributor" = EXCLUDED."distributor"
         AND (
           checkpoint."recoverySteelSessionIdEncrypted" IS NOT NULL
           OR NOT EXISTS (
             SELECT 1 FROM "DistroKidCheckpointTerminal" terminal
              WHERE terminal."userId" = checkpoint."userId"
                AND terminal."connectionId" = checkpoint."connectionId"
                AND terminal."snapshotId" = checkpoint."snapshotId"
           )
         )
       RETURNING ${rowProjection}`,
      [
        job.tenantId, job.connectionId, job.snapshotId, job.distributor, JSON.stringify(job.artists),
        job.consentId, job.steelSessionId,
        job.sessionExpiresAt, job.deadlineAt, job.schemaVersion,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      const state = await this.pool.query<{
        tenantId: string; connectionId: string; distributor: string; terminal: boolean;
      }>(
        `SELECT root."userId" AS "tenantId", root."connectionId", root."distributor",
                EXISTS (
                  SELECT 1 FROM "DistroKidCheckpointTerminal" terminal
                   WHERE terminal."userId" = root."userId"
                     AND terminal."connectionId" = root."connectionId"
                     AND terminal."snapshotId" = root."snapshotId"
                ) AS "terminal"
           FROM "DistroKidSnapshotCheckpoint" root
          WHERE root."snapshotId"=$1`,
        [job.snapshotId],
      );
      const existing = state.rows[0];
      if (existing?.tenantId === job.tenantId
          && existing.connectionId === job.connectionId
          && existing.distributor === job.distributor
          && existing.terminal) {
        throw new DistroKidRecoveryAlreadyTerminalError();
      }
      throw new DistroKidRecoveryPrincipalMismatchError();
    }
    const durable = fromRow(row);
    // Randomized ciphertext and a recomputed deadline may differ on an idempotent API replay.
    // Every principal/session fact must remain identical; then the first durable values win.
    if (!sameImmutablePrincipal(durable, job)) throw new DistroKidRecoveryPrincipalMismatchError();
    return durable;
  }

  async list(limit = 100): Promise<CatalogIndexJob[]> {
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    const result = await this.pool.query<RecoveryRow>(
      `SELECT ${rowProjection}
         FROM "DistroKidSnapshotCheckpoint"
        WHERE "recoverySteelSessionIdEncrypted" IS NOT NULL
        ORDER BY "recoveryDeadlineAt", "snapshotId"
        LIMIT $1`,
      [bounded],
    );
    return result.rows.map(fromRow);
  }

  async clear(job: Pick<CatalogIndexJob, 'tenantId' | 'connectionId' | 'snapshotId'>): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE "DistroKidSnapshotCheckpoint" SET
         "recoveryArtists" = NULL,
         "recoveryConsentId" = NULL,
         "recoverySteelSessionIdEncrypted" = NULL,
         "recoverySessionExpiresAt" = NULL,
         "recoveryDeadlineAt" = NULL,
         "recoverySchemaVersion" = NULL
       WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3
         AND "recoverySteelSessionIdEncrypted" IS NOT NULL`,
      [job.tenantId, job.connectionId, job.snapshotId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
