import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import IORedis from 'ioredis';
import { present, type ReleaseExtractionOutcome } from '@sentinel/browser-assist';
import {
  SnapshotPrincipalMismatchError,
  TieredSnapshotCheckpointStore,
  type SnapshotCheckpointBinding,
  type SnapshotRedis,
} from './snapshot-store';

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? process.env.REDIS_TEST_URL;
const runNonce = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const snapshotIds: string[] = [];

const binding = (suffix: string, tenantId = `tenant-${runNonce}`): SnapshotCheckpointBinding => ({
  tenantId,
  connectionId: `${tenantId}:distrokid`,
  snapshotId: `checkpoint-${suffix}-${runNonce}`,
  distributor: 'distrokid',
});

const outcome = (releaseId: string): ReleaseExtractionOutcome => ({
  kind: 'COMPLETED',
  release: {
    distributorReleaseId: releaseId,
    title: `Release ${releaseId}`,
    primaryArtist: 'Integration Artist',
    upc: present(`UPC-${releaseId}`, 'NETWORK_JSON', 'integration-v1'),
    // The query is intentionally credential-shaped. A durable checkpoint must strip it.
    artworkUrl: present(`https://cdn.example.test/${releaseId}.jpg?token=raw-secret-${releaseId}`, 'NETWORK_JSON', 'integration-v1'),
    releaseDate: present('2026-01-01', 'NETWORK_JSON', 'integration-v1'),
    tracks: [{ title: `Track ${releaseId}`, isrc: present(`ISRC-${releaseId}`, 'NETWORK_JSON', 'integration-v1') }],
  },
  source: 'NETWORK_JSON',
  elapsedMs: 4,
});

/** Wrap the real Pool only to observe statement parameter counts. SQL still executes against real
 * PostgreSQL; this proves large catalogues are split into bounded inserts. */
function observedPool(pool: Pool, parameterCounts: number[]): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) as unknown : value;
      }
      return async (): Promise<PoolClient> => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty !== 'query') return Reflect.get(clientTarget, clientProperty, clientReceiver) as unknown;
            return async (text: string, values?: unknown[]): Promise<QueryResult> => {
              if (text.includes('INSERT INTO "DistroKidCheckpoint')) parameterCounts.push(values?.length ?? 0);
              return clientTarget.query(text, values);
            };
          },
        }) as PoolClient;
      };
    },
  });
}

describe.skipIf(!DATABASE_URL || !REDIS_URL)('tiered DistroKid checkpoints - real PostgreSQL + Redis', () => {
  let pool: Pool;
  let redis: IORedis;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    redis = new IORedis(REDIS_URL!, { maxRetriesPerRequest: 2 });
    // Dedicated logical DB: FLUSHDB below models regional cache loss without disturbing BullMQ
    // integration suites that run concurrently on DB 0.
    await redis.select(14);
    await redis.flushdb();
  });

  afterAll(async () => {
    for (const snapshotId of snapshotIds) {
      await pool.query('DELETE FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId"=$1', [snapshotId]).catch(() => undefined);
    }
    await redis.flushdb().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it('rehydrates after a mid-scan Redis flush and resumes 1,100 releases without duplicates', async () => {
    const scope = binding('flush');
    snapshotIds.push(scope.snapshotId);
    const parameterCounts: number[] = [];
    const store = new TieredSnapshotCheckpointStore(
      redis as unknown as SnapshotRedis,
      observedPool(pool, parameterCounts),
      { postgresBatchSize: 37 },
    );
    await store.bindSnapshot(scope);

    const refs = Array.from({ length: 1_100 }, (_, index) => ({
      releaseId: `R${String(index).padStart(4, '0')}`,
      dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${index}`,
      title: `Release ${index}`,
    }));
    const plan = Array.from({ length: 55 }, (_, chunk) => refs.slice(chunk * 20, chunk * 20 + 20).map((ref) => ref.releaseId));
    await store.putIndex(scope.snapshotId, refs);
    await store.putPassPlan(scope.snapshotId, 1, plan);
    await store.putProgress({
      ...scope,
      status: 'RUNNING', expectedReleases: refs.length, completedReleases: 500,
      failedReleases: 0, chunkCount: plan.length, completedChunks: Array.from({ length: 25 }, (_, index) => index),
      startedAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:01:00.000Z',
    });
    await store.putOutcomes(scope.snapshotId, refs.slice(0, 500).map((ref) => outcome(ref.releaseId)));
    for (let chunk = 0; chunk < 25; chunk += 1) await store.markChunkComplete(scope.snapshotId, 1, chunk);

    // Real Redis cache loss after half the catalogue. PostgreSQL remains untouched.
    await redis.flushdb();

    // A new store instance models a worker in the replacement region/process.
    const resumed = new TieredSnapshotCheckpointStore(redis as unknown as SnapshotRedis, pool, { postgresBatchSize: 41 });
    await resumed.bindSnapshot(scope);
    expect(await resumed.getIndex(scope.snapshotId)).toHaveLength(1_100);
    expect(await resumed.getPassPlan(scope.snapshotId, 1)).toEqual(plan);
    expect(await resumed.completedChunks(scope.snapshotId, 1)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    const recovered = await resumed.getOutcomes(scope.snapshotId);
    expect(recovered).toHaveLength(500);

    const alreadyDone = new Set(recovered.map((entry) => entry.kind === 'COMPLETED' ? entry.release.distributorReleaseId : entry.distributorReleaseId));
    const remaining = refs.filter((ref) => !alreadyDone.has(ref.releaseId));
    expect(remaining).toHaveLength(600);
    await resumed.putOutcomes(scope.snapshotId, remaining.map((ref) => outcome(ref.releaseId)));
    // Duplicate delivery after a worker crash is an upsert, not a second row.
    await resumed.putOutcomes(scope.snapshotId, [outcome('R0000'), outcome('R1099')]);

    const all = await resumed.getOutcomes(scope.snapshotId);
    const releaseIds = all.map((entry) => entry.kind === 'COMPLETED' ? entry.release.distributorReleaseId : entry.distributorReleaseId);
    expect(all).toHaveLength(1_100);
    expect(new Set(releaseIds).size).toBe(1_100);
    const durableCount = await pool.query(
      'SELECT count(*)::int AS count FROM "DistroKidCheckpointOutcome" WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3',
      [scope.tenantId, scope.connectionId, scope.snapshotId],
    );
    expect(durableCount.rows[0]?.count).toBe(1_100);

    // 1,100 rows at a configured batch size of 37 must create multiple bounded statements.
    // The index insert has nine parameters per row, including expectedTrackCount.
    expect(parameterCounts.filter((count) => count > 100).length).toBeGreaterThan(2);
    expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(37 * 9);
  }, 45_000);

  it('rejects cross-tenant rebinding and persists only normalized, non-secret checkpoint data', async () => {
    const scope = binding('isolation', `tenant-a-${runNonce}`);
    snapshotIds.push(scope.snapshotId);
    const store = new TieredSnapshotCheckpointStore(redis as unknown as SnapshotRedis, pool);
    await store.bindSnapshot(scope);
    await store.putIndex(scope.snapshotId, [{
      releaseId: 'R-secret',
      dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R-secret&token=do-not-store&cookie=also-secret',
    }]);
    const withUnknownTransportFields = Object.assign(outcome('R-secret'), {
      rawResponse: '{"access_token":"do-not-store"}',
      cookies: ['session=do-not-store'],
    }) as ReleaseExtractionOutcome;
    await store.putOutcomes(scope.snapshotId, [withUnknownTransportFields]);
    await store.putOutcomes(scope.snapshotId, [{
      kind: 'FAILED', distributorReleaseId: 'R-failed', reason: 'REQUEST_FAILED',
      detail: 'Bearer do-not-store from raw response', elapsedMs: 1,
    }]);

    const wrongPrincipal = new TieredSnapshotCheckpointStore(redis as unknown as SnapshotRedis, pool);
    await expect(wrongPrincipal.bindSnapshot({
      ...scope, tenantId: `tenant-b-${runNonce}`, connectionId: `tenant-b-${runNonce}:distrokid`,
    })).rejects.toBeInstanceOf(SnapshotPrincipalMismatchError);

    const rawRows = await pool.query(
      `SELECT "dashboardUrl" AS value FROM "DistroKidCheckpointIndex" WHERE "snapshotId"=$1
       UNION ALL SELECT "outcome"::text AS value FROM "DistroKidCheckpointOutcome" WHERE "snapshotId"=$1`,
      [scope.snapshotId],
    );
    const serialized = rawRows.rows.map((row) => String(row.value)).join('\n');
    expect(serialized).not.toContain('do-not-store');
    expect(serialized).not.toContain('rawResponse');
    expect(serialized).not.toContain('cookies');
    expect(serialized).not.toMatch(/[?&](?:token|cookie)=/i);
    expect(serialized).toContain('checkpointed failure: REQUEST_FAILED');
  }, 20_000);
});
