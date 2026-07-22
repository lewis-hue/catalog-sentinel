import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asPgPoolLike, createPgPool } from './pg-client';
import { PostgresSearchStore } from './postgres-search-store';
import { asRedisLike, createRedis } from './redis-client';
import { RedisSearchStore, type CatalogResultLike, type SearchPageCursor, type SearchRecord } from './search-store';

const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeInfrastructure = enabled ? describe : describe.skip;
const suffix = randomUUID();
const tenantId = `pagination-${suffix}`;
const ownerUserId = `owner-${suffix}`;
const prefix = `sentinel:test:pagination:${suffix}`;
const recordIds = Array.from({ length: 205 }, (_, index) => `search_infra_${suffix}_${String(index).padStart(3, '0')}`);

const result: CatalogResultLike = {
  artist: 'History integration fixture',
  stores: [],
  profiles: [],
  tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: '2026-07-22T00:00:00.000Z',
  warnings: [],
  note: '',
};

let pgPool: ReturnType<typeof createPgPool>;
let redis: ReturnType<typeof createRedis>;
let postgresStore: PostgresSearchStore;
let redisStore: RedisSearchStore;

function record(id: string): SearchRecord {
  return {
    id,
    revision: 1,
    tenantId,
    ownerUserId,
    artistWorkspaceId: `aw-${suffix}`,
    createdAt: '2026-07-22T12:00:00.000Z',
    artist: id,
    distributor: 'distrokid',
    platforms: [],
    song: null,
    result,
  };
}

async function collect(store: PostgresSearchStore | RedisSearchStore): Promise<string[]> {
  const ids: string[] = [];
  let after: SearchPageCursor | undefined;
  do {
    const page = await store.pageForOwner(tenantId, ownerUserId, { limit: 29, ...(after ? { after } : {}) });
    ids.push(...page.items.map((item) => item.id));
    after = page.nextCursor;
  } while (after);
  return ids;
}

describeInfrastructure('real Redis/Postgres search history pagination', () => {
  beforeAll(async () => {
    pgPool = createPgPool(process.env.DATABASE_URL!);
    redis = createRedis(process.env.REDIS_URL!);
    postgresStore = new PostgresSearchStore(asPgPoolLike(pgPool));
    redisStore = new RedisSearchStore(asRedisLike(redis), prefix);
    for (const id of recordIds) {
      const fixture = record(id);
      await postgresStore.put(fixture);
      await redisStore.put(fixture);
    }
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    for (const id of recordIds) {
      await postgresStore.delete(id, tenantId, ownerUserId);
      await redisStore.delete(id, tenantId, ownerUserId);
    }
    redis.disconnect();
    await pgPool.end();
  }, 60_000);

  it('returns the same complete deterministic sequence from both backends beyond row 200', async () => {
    const postgresIds = await collect(postgresStore);
    const redisIds = await collect(redisStore);
    expect(postgresIds).toHaveLength(205);
    expect(new Set(postgresIds).size).toBe(205);
    expect(redisIds).toEqual(postgresIds);
    expect(postgresIds[0]).toBe(recordIds.at(-1));
    expect(postgresIds.at(-1)).toBe(recordIds[0]);
  }, 30_000);
});
