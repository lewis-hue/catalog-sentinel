import { Redis } from 'ioredis';
import type { RedisLike } from './search-store';

/**
 * Shared Redis client (ioredis). Used both as the SearchStore backend (records shared
 * across the API + workers) and — via connectionFromUrl in bullmq.ts — as the BullMQ
 * broker. `maxRetriesPerRequest: null` is required by BullMQ and harmless for the store.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** ioredis structurally satisfies the store's minimal RedisLike surface. */
export function asRedisLike(redis: Redis): RedisLike {
  return redis as unknown as RedisLike;
}

/**
 * This deployment uses a single-node ioredis client and several multi-key Lua scripts.
 * A cluster endpoint would accept the TCP connection and fail later with MOVED/CROSSSLOT,
 * after work had already been admitted. Probe the actual server topology during startup.
 */
export async function assertStandaloneRedisTopology(
  redis: Pick<Redis, 'info'>,
): Promise<void> {
  const info = await redis.info('cluster');
  const enabled = /^cluster_enabled:(\d+)\s*$/m.exec(info)?.[1];
  if (enabled === undefined) throw new Error('Redis INFO cluster did not report cluster_enabled');
  if (enabled !== '0') {
    throw new Error('Redis Cluster is unsupported by this deployment; configure a cluster-disabled Redis endpoint');
  }
}
