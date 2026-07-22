import type { Pool } from 'pg';
import type { CandidateScope, CandidateStore, StoredCandidate } from '@sentinel/contracts';

/**
 * DURABLE, tenant-scoped endpoint-candidate store.
 *
 * Candidates are the automatic answer to "which endpoint serves catalog data?" — the thing that
 * replaces an operator reading raw logs after every dashboard change. Keeping them in process
 * memory undid that: an admin querying replica B saw nothing for a scan that ran on replica A,
 * and a restart erased the evidence from the run you were trying to diagnose.
 *
 * SAFETY PROPERTIES
 *  - Every write carries `{tenantId, scanId}` explicitly. There is no ambient "current scan" — a
 *    shared mutable cursor is how concurrent scans contaminate each other.
 *  - Every read is filtered by tenant AND scan, so one tenant can never see another's endpoints.
 *  - Sanitized SHAPE only: method, host, masked path, query KEY names, GraphQL operation name,
 *    schema KEY names, hashes, sizes, counts. The table has no column that could hold a value,
 *    a cookie, an authorization header, a token or a response body.
 */
export class PostgresCandidateStore implements CandidateStore {
  constructor(
    private readonly pool: Pool,
    private readonly distributor = 'DISTROKID',
    /** Bound per scan so a pathological page can't write unbounded rows. */
    private readonly maxPerScan = 200,
  ) {}

  /**
   * `write` matches the `CandidateSink` shape used by the extractor. It is intentionally
   * best-effort at the call site: recording a candidate must never fail a user's catalogue read.
   */
  async write(c: CandidateLike, scope: CandidateScope): Promise<void> {
    // Enforce the cap for NEW fingerprints only — an existing row must still be updatable, or a
    // busy scan would stop counting observations for endpoints it already knows about.
    const countRes = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2`,
      [scope.tenantId, scope.scanId],
    );
    const existingCount = Number(countRes.rows[0]?.n ?? '0');
    if (existingCount >= this.maxPerScan) {
      const known = await this.pool.query(
        `SELECT 1 FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2 AND "fingerprint" = $3`,
        [scope.tenantId, scope.scanId, c.fingerprint],
      );
      if (known.rowCount === 0) return;
    }

    await this.pool.query(
      `INSERT INTO "DistributorEndpointCandidate" (
         "id", "tenantId", "scanId", "distributor", "fingerprint",
         "method", "host", "maskedPath", "queryKeys", "operationName",
         "schemaKeys", "schemaHash", "score", "observations", "distinctPayloads",
         "variesPerRelease", "sizeBytes", "firstSeenAt", "lastSeenAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 1, false, $13, $14, $14
       )
       ON CONFLICT ("tenantId", "scanId", "fingerprint") DO UPDATE SET
         "score" = GREATEST("DistributorEndpointCandidate"."score", EXCLUDED."score"),
         "observations" = "DistributorEndpointCandidate"."observations" + 1,
         "schemaKeys" = EXCLUDED."schemaKeys",
         "schemaHash" = EXCLUDED."schemaHash",
         "sizeBytes" = EXCLUDED."sizeBytes",
         "lastSeenAt" = EXCLUDED."lastSeenAt"`,
      [
        scope.tenantId, scope.scanId, this.distributor, c.fingerprint,
        c.identity.method, c.identity.host, c.identity.pathPattern, c.identity.queryKeys,
        c.identity.graphqlOperationName ?? null,
        // Drop redaction markers before persisting — a masked key name is noise, not a key.
        c.schemaKeys.filter((k) => k !== '{redacted}').slice(0, 60),
        c.schemaHash, c.score, c.bodyBytes, c.observedAt,
      ],
    );
  }

  async list(tenantId: string, scanId: string): Promise<StoredCandidate[]> {
    const res = await this.pool.query<CandidateRow>(
      `SELECT * FROM "DistributorEndpointCandidate"
       WHERE "tenantId" = $1 AND "scanId" = $2
       ORDER BY "score" DESC, "observations" DESC`,
      [tenantId, scanId],
    );
    return res.rows.map(toStored);
  }

  async clear(tenantId: string, scanId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2`,
      [tenantId, scanId],
    );
  }
}

/** The subset of the extractor's `NetworkCandidate` this store persists. */
export interface CandidateLike {
  fingerprint: string;
  descriptor: string;
  identity: { method: string; host: string; pathPattern: string; queryKeys: string[]; graphqlOperationName?: string };
  schemaKeys: string[];
  schemaHash: string;
  score: number;
  bodyBytes: number;
  observedAt: string;
  releaseId?: string;
  status?: number;
  contentType?: string;
}

interface CandidateRow {
  fingerprint: string;
  method: string;
  host: string;
  maskedPath: string;
  queryKeys: string[] | null;
  operationName: string | null;
  schemaKeys: string[] | null;
  schemaHash: string | null;
  score: number;
  observations: number;
  sizeBytes: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function toStored(row: CandidateRow): StoredCandidate {
  const q = row.queryKeys ?? [];
  return {
    fingerprint: row.fingerprint,
    descriptor: `${row.method} ${row.host}${row.maskedPath}${q.length ? `?${q.join('&')}` : ''}`,
    method: row.method,
    host: row.host,
    pathPattern: row.maskedPath,
    queryKeys: q,
    ...(row.operationName ? { graphqlOperationName: row.operationName } : {}),
    // Not persisted — an HTTP status/content-type of a single observation says nothing useful
    // once a candidate has been seen many times.
    status: 200,
    contentType: 'application/json',
    score: row.score,
    schemaKeys: row.schemaKeys ?? [],
    schemaHash: row.schemaHash ?? '',
    bodyBytes: row.sizeBytes ?? 0,
    observations: row.observations,
    releaseIds: [],
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}
