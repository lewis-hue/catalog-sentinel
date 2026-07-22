import { InMemorySearchStore, RedisSearchStore, type SearchStore } from './search-store';
import { PostgresSearchStore } from './postgres-search-store';
import { TieredSearchStore } from './tiered-search-store';
import { createRedis, asRedisLike } from './redis-client';
import { createPgPool, asPgPoolLike } from './pg-client';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

export interface BuiltSearchStore {
  store: SearchStore;
  /** Human label of the tiers in use (for startup logging). */
  kind: string;
  /** Underlying clients, exposed for health probes (null when that tier is off). */
  redis: Redis | null;
  pgPool: Pool | null;
  close(): Promise<void>;
}

/**
 * Assemble the runtime search store from the canonical migration-owned database:
 *   - DATABASE_URL + REDIS_URL → Postgres source of truth with a Redis hot cache.
 *   - DATABASE_URL only        → Postgres source of truth without a hot cache.
 *   - neither                  → isolated test memory only.
 * Redis is never accepted as the durable tier, and process-local storage is
 * unavailable outside an explicit `NODE_ENV=test` process.
 */
export function buildSearchStore(env: NodeJS.ProcessEnv = process.env, log: (m: string, e?: Record<string, unknown>) => void = () => {}): BuiltSearchStore {
  const isolatedTest = env.NODE_ENV === 'test';
  const useRedis = env.DEEP_SCAN_DISPATCH === 'bullmq' && Boolean(env.REDIS_URL);
  const redis = useRedis && env.REDIS_URL ? createRedis(env.REDIS_URL) : null;
  const redisPrefix = env.SEARCH_STORE_PREFIX ?? `sentinel:${env.NODE_ENV ?? 'development'}:search`;
  const hot: SearchStore | null = redis
    ? new RedisSearchStore(asRedisLike(redis), redisPrefix)
    : isolatedTest
      ? new InMemorySearchStore()
      : null;

  const pgUrl = env.DATABASE_URL;
  const pool = pgUrl ? createPgPool(pgUrl) : null;
  const durable = pool ? new PostgresSearchStore(asPgPoolLike(pool)) : null;
  if (!durable && !isolatedTest) {
    try { redis?.disconnect(); } catch { /* ignore cleanup errors while failing startup */ }
    throw new Error('DATABASE_URL is required; search history cannot use process-memory or Redis-only runtime persistence.');
  }

  let store: SearchStore;
  let kind: string;
  if (durable && redis && hot) { store = new TieredSearchStore(hot, durable, log); kind = 'tiered(redis+postgres)'; }
  else if (durable) { store = durable; kind = 'postgres'; }
  else if (isolatedTest && hot) { store = hot; kind = redis ? 'test-redis' : 'test-memory'; }
  else { throw new Error('Search-store composition invariant failed.'); }

  return {
    store,
    kind,
    redis,
    pgPool: pool,
    close: async () => {
      try { redis?.disconnect(); } catch { /* ignore */ }
      try { await pool?.end(); } catch { /* ignore */ }
    },
  };
}
