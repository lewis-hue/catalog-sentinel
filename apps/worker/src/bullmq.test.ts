import { describe, expect, it } from 'vitest';
import { connectionFromUrl } from './bullmq';

describe('worker BullMQ Redis URL transport', () => {
  it('preserves TLS and decoded credentials for managed Redis', () => {
    expect(connectionFromUrl('rediss://worker%20user:s%2Fcret@cache.example:6380')).toEqual({
      host: 'cache.example',
      port: 6380,
      username: 'worker user',
      password: 's/cret',
      tls: {},
    });
  });

  it('keeps plaintext local Redis explicit and rejects unrelated schemes', () => {
    expect(connectionFromUrl('redis://127.0.0.1:6379')).toEqual({ host: '127.0.0.1', port: 6379 });
    expect(() => connectionFromUrl('http://cache.example')).toThrow(/redis:\/\/ or rediss:\/\//i);
  });
});
