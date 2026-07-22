import { describe, expect, it, vi } from 'vitest';
import { assertStandaloneRedisTopology } from './redis-client';

describe('assertStandaloneRedisTopology', () => {
  it('accepts a cluster-disabled Redis server', async () => {
    const redis = { info: vi.fn(async () => '# Cluster\r\ncluster_enabled:0\r\n') };
    await expect(assertStandaloneRedisTopology(redis as never)).resolves.toBeUndefined();
    expect(redis.info).toHaveBeenCalledWith('cluster');
  });

  it('fails startup for a cluster-mode-enabled endpoint', async () => {
    const redis = { info: vi.fn(async () => '# Cluster\r\ncluster_enabled:1\r\n') };
    await expect(assertStandaloneRedisTopology(redis as never)).rejects.toThrow(/Redis Cluster is unsupported/i);
  });

  it('fails closed when topology cannot be established', async () => {
    const redis = { info: vi.fn(async () => '# Server\r\nredis_version:7.4.0\r\n') };
    await expect(assertStandaloneRedisTopology(redis as never)).rejects.toThrow(/cluster_enabled/i);
  });
});
