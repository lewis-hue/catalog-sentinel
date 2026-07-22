import { describe, expect, it } from 'vitest';
import { consumeFixedWindow, productionRateLimitConfig, type RateLimitRedis } from './rate-limit';

class FakeRedis implements RateLimitRedis {
  readonly calls: string[][] = [];
  count = 0;
  async eval(_script: string, _keys: number, ...args: string[]): Promise<unknown> {
    this.calls.push(args);
    this.count += 1;
    return [this.count, 9_500];
  }
}

describe('production resource rate limits', () => {
  it('atomically rejects requests beyond the fixed-window limit and returns retry timing', async () => {
    const redis = new FakeRedis();
    const policy = { limit: 2, windowMs: 10_000 };
    expect((await consumeFixedWindow(redis, 'sentinel:test', 'steel', 'tenant-a:user-a', policy)).allowed).toBe(true);
    expect((await consumeFixedWindow(redis, 'sentinel:test', 'steel', 'tenant-a:user-a', policy)).allowed).toBe(true);
    const rejected = await consumeFixedWindow(redis, 'sentinel:test', 'steel', 'tenant-a:user-a', policy);
    expect(rejected).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 10 });
    expect(redis.calls[0]?.[0]).not.toContain('tenant-a');
    expect(redis.calls[0]?.[0]).not.toContain('user-a');
  });

  it('uses bounded production defaults and rejects disabling values', () => {
    expect(productionRateLimitConfig({}).connect).toEqual({ limit: 3, windowMs: 900_000 });
    expect(() => productionRateLimitConfig({ STEEL_SESSION_START_RATE_LIMIT: '0' })).toThrow(/between 1/i);
    expect(() => productionRateLimitConfig({ CONSENT_CREATE_RATE_WINDOW_MS: 'NaN' })).toThrow(/between 1/i);
  });
});
