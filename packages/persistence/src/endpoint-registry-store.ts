import type { Pool } from 'pg';
import type {
  DistributorEndpointProfile, EndpointRegistryStore, EndpointRole,
  EndpointStatus, RegistryScope,
} from '@sentinel/contracts';

/**
 * DURABLE, tenant-scoped endpoint registry.
 *
 * Replaces `InMemoryEndpointRegistryStore` in production. The in-memory one is correct for tests
 * and wrong for a deployment in two specific ways:
 *
 *  1. A restart forgets every promotion. The registry's whole job is to remember which endpoint
 *     works so production stops guessing — memory that evaporates on deploy doesn't do that, and
 *     each restart silently reverts extraction to shape-guessing until it revalidates.
 *  2. Two replicas disagree. Worker A promotes an endpoint to ACTIVE while worker B still has it
 *     as CANDIDATE, so the same account extracts differently depending on which worker picked up
 *     the chunk — a bug that reproduces only under concurrency.
 *
 * Every read and write is filtered by `tenantId` AND `distributor`. The unique key
 * `(tenantId, distributor, fingerprint)` is what makes concurrent promotion safe: two workers
 * observing the same endpoint converge on one row instead of racing to insert two.
 *
 * Stores endpoint SHAPE only — method, host, masked path, query KEY names, GraphQL operation
 * name, schema KEY names and hashes. The schema has nowhere to put a value, a cookie, a token or
 * a response body.
 */
export class PostgresEndpointRegistryStore implements EndpointRegistryStore {
  constructor(private readonly pool: Pool) {}

  async get(scope: RegistryScope, fingerprint: string): Promise<DistributorEndpointProfile | null> {
    const res = await this.pool.query<ProfileRow>(
      `SELECT * FROM "DistributorEndpointProfile"
       WHERE "tenantId" = $1 AND "distributor" = $2 AND "fingerprint" = $3`,
      [scope.tenantId, scope.distributor, fingerprint],
    );
    const row = res.rows[0];
    return row ? toProfile(row) : null;
  }

  async list(scope: RegistryScope): Promise<DistributorEndpointProfile[]> {
    const res = await this.pool.query<ProfileRow>(
      `SELECT * FROM "DistributorEndpointProfile"
       WHERE "tenantId" = $1 AND "distributor" = $2
       ORDER BY "lastSeenAt" DESC`,
      [scope.tenantId, scope.distributor],
    );
    return res.rows.map(toProfile);
  }

  async put(profile: DistributorEndpointProfile): Promise<void> {
    // Upsert on the natural key. Concurrent workers observing the same endpoint must converge on
    // one row; an insert-or-fail here would turn a normal race into a job failure.
    await this.pool.query(
      `INSERT INTO "DistributorEndpointProfile" (
         "id", "tenantId", "distributor", "fingerprint", "role", "status",
         "method", "host", "maskedPath", "queryKeys", "operationName",
         "schemaHash", "schemaKeys", "parserVersion",
         "successCount", "failureCount", "candidateScore", "validationCount", "schemaDriftCount",
         "firstSeenAt", "lastSeenAt", "promotedAt", "degradedAt"
       ) VALUES (
         gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
       )
       ON CONFLICT ("tenantId", "distributor", "fingerprint") DO UPDATE SET
         "role" = EXCLUDED."role",
         "status" = EXCLUDED."status",
         "method" = EXCLUDED."method",
         "host" = EXCLUDED."host",
         "maskedPath" = EXCLUDED."maskedPath",
         "queryKeys" = EXCLUDED."queryKeys",
         "operationName" = EXCLUDED."operationName",
         "schemaHash" = EXCLUDED."schemaHash",
         "schemaKeys" = EXCLUDED."schemaKeys",
         "parserVersion" = EXCLUDED."parserVersion",
         "successCount" = EXCLUDED."successCount",
         "failureCount" = EXCLUDED."failureCount",
         "candidateScore" = EXCLUDED."candidateScore",
         "validationCount" = EXCLUDED."validationCount",
         "schemaDriftCount" = EXCLUDED."schemaDriftCount",
         "lastSeenAt" = EXCLUDED."lastSeenAt",
         "promotedAt" = COALESCE("DistributorEndpointProfile"."promotedAt", EXCLUDED."promotedAt"),
         "degradedAt" = EXCLUDED."degradedAt"`,
      [
        profile.tenantId, profile.distributor, profile.fingerprint, profile.role, profile.status,
        profile.method, profile.hostPattern, profile.pathPattern, profile.queryKeyShape,
        profile.graphqlOperationName ?? null,
        profile.schemaHash,
        // These were previously written as an empty array and a hard-coded zero — the table
        // promised more than the repository preserved, so a restart silently dropped the endpoint's
        // schema shape and reset its drift history to "never happened".
        profile.schemaKeys ?? [],
        profile.parserVersion,
        profile.successfulCaptures, profile.failedCaptures,
        profile.candidateScore, profile.candidateScore,
        profile.schemaDriftCount ?? 0,
        profile.firstSeenAt, profile.lastSeenAt,
        profile.approvedAt ?? null,
        profile.status === 'DEGRADED' ? profile.lastSeenAt : null,
      ],
    );
  }
}

interface ProfileRow {
  id: string;
  tenantId: string;
  distributor: string;
  fingerprint: string;
  role: string;
  status: string;
  method: string;
  host: string;
  maskedPath: string;
  queryKeys: string[] | null;
  operationName: string | null;
  schemaHash: string | null;
  schemaKeys: string[] | null;
  parserVersion: string | null;
  successCount: number;
  failureCount: number;
  candidateScore: number;
  validationCount: number;
  schemaDriftCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  promotedAt: Date | null;
  retiredAt?: Date | null;
}

function toProfile(row: ProfileRow): DistributorEndpointProfile {
  return {
    id: row.id,
    tenantId: row.tenantId,
    distributor: row.distributor,
    role: row.role as EndpointRole,
    fingerprint: row.fingerprint,
    method: row.method,
    hostPattern: row.host,
    pathPattern: row.maskedPath,
    queryKeyShape: row.queryKeys ?? [],
    ...(row.operationName ? { graphqlOperationName: row.operationName } : {}),
    schemaHash: row.schemaHash ?? '',
    schemaKeys: row.schemaKeys ?? [],
    parserVersion: row.parserVersion ?? '',
    candidateScore: row.candidateScore,
    successfulCaptures: row.successCount,
    failedCaptures: row.failureCount,
    schemaDriftCount: row.schemaDriftCount,
    status: row.status as EndpointStatus,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ...(row.promotedAt ? { approvedAt: row.promotedAt.toISOString() } : {}),
  };
}
