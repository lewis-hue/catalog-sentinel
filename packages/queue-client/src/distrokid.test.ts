import { describe, expect, it } from 'vitest';
import type { CatalogIndexJob } from '@sentinel/contracts';
import { connectionFromUrl, withDistroKidDeadline } from './distrokid';

const JOB: CatalogIndexJob = {
  tenantId: 't1', connectionId: 'c1', snapshotId: 's1', distributor: 'distrokid', artists: ['Artist'],
};

describe('DistroKid producer wall-clock budget', () => {
  it('anchors one deadline and leaves cleanup time inside the actual Steel lease', () => {
    const now = 1_000_000;
    const result = withDistroKidDeadline({
      ...JOB, sessionExpiresAt: new Date(now + 20 * 60_000).toISOString(),
    }, {
      env: { NODE_ENV: 'production', CATALOG_READ_MAX_DURATION_MS: '600000' },
      now: () => now,
    });
    expect(result.deadlineAt).toBe(new Date(now + 600_000).toISOString());
    expect(Date.parse(result.deadlineAt!)).toBeLessThan(Date.parse(result.sessionExpiresAt!));
  });

  it('rejects production jobs without the actual Steel expiry', () => {
    expect(() => withDistroKidDeadline(JOB, {
      env: { NODE_ENV: 'production', CATALOG_READ_MAX_DURATION_MS: '600000' }, now: () => 1_000_000,
    })).toThrow(/actual Steel session expiry/i);
  });

  it('rejects a lease that cannot provide the full configured budget plus cleanup', () => {
    const now = 1_000_000;
    expect(() => withDistroKidDeadline({
      ...JOB, sessionExpiresAt: new Date(now + 600_001).toISOString(),
    }, {
      env: { NODE_ENV: 'production', CATALOG_READ_MAX_DURATION_MS: '600000' }, now: () => now,
    })).toThrow(/full configured catalogue-read budget/i);
  });

  it('preserves an existing recovery deadline without demanding a fresh full lease', () => {
    const anchoredAt = 1_000_000;
    const original = withDistroKidDeadline({
      ...JOB, sessionExpiresAt: new Date(anchoredAt + 700_000).toISOString(),
    }, {
      env: { NODE_ENV: 'production', CATALOG_READ_MAX_DURATION_MS: '600000' },
      now: () => anchoredAt,
    });
    const replayed = withDistroKidDeadline(original, {
      env: { NODE_ENV: 'production', CATALOG_READ_MAX_DURATION_MS: '600000' },
      now: () => anchoredAt + 30_000,
    });
    expect(replayed.deadlineAt).toBe(original.deadlineAt);
  });
});

describe('BullMQ Redis URL transport', () => {
  it('preserves rediss TLS and decodes credentials', () => {
    expect(connectionFromUrl('rediss://queue%20user:p%40ss@redis.example:6380')).toEqual({
      host: 'redis.example',
      port: 6380,
      username: 'queue user',
      password: 'p@ss',
      tls: {},
    });
  });

  it('rejects non-Redis schemes', () => {
    expect(() => connectionFromUrl('https://redis.example')).toThrow(/redis:\/\/ or rediss:\/\//i);
  });
});
