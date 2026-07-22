import { createHash } from 'node:crypto';

export interface RateLimitRedis {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface FixedWindowPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const TAKE_FIXED_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

function positiveInt(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/**
 * Redis-atomic fixed-window limiter for operations that create durable or billable resources.
 * The principal is hashed before becoming a Redis key so user/tenant identifiers are not copied
 * into operational key names. Redis failures are deliberately surfaced to the caller; production
 * routes fail closed instead of silently dropping abuse protection.
 */
export async function consumeFixedWindow(
  redis: RateLimitRedis,
  prefix: string,
  bucket: string,
  principal: string,
  policy: FixedWindowPolicy,
): Promise<RateLimitDecision> {
  const limit = positiveInt(policy.limit, 'rate limit');
  const windowMs = positiveInt(policy.windowMs, 'rate limit window');
  const digest = createHash('sha256').update(principal).digest('hex');
  const key = `${prefix}:${bucket}:${digest}`;
  const raw = await redis.eval(TAKE_FIXED_WINDOW, 1, key, String(windowMs));
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('invalid Redis rate-limit response');
  const count = Number(raw[0]);
  const ttlMs = Number(raw[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) throw new Error('invalid Redis rate-limit response');
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, ttlMs) / 1000)),
  };
}

export function productionRateLimitConfig(env: NodeJS.ProcessEnv = process.env): {
  prefix: string;
  consent: FixedWindowPolicy;
  connect: FixedWindowPolicy;
} {
  const read = (name: string, fallback: number, maximum: number): number => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
    }
    return value;
  };
  return {
    prefix: env.API_RATE_LIMIT_PREFIX?.trim() || 'sentinel:api-rate-limit',
    consent: {
      limit: read('CONSENT_CREATE_RATE_LIMIT', 20, 10_000),
      windowMs: read('CONSENT_CREATE_RATE_WINDOW_MS', 3_600_000, 86_400_000),
    },
    connect: {
      limit: read('STEEL_SESSION_START_RATE_LIMIT', 3, 1_000),
      windowMs: read('STEEL_SESSION_START_RATE_WINDOW_MS', 900_000, 86_400_000),
    },
  };
}
