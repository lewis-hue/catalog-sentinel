/**
 * Distributed lock, per distributor CONNECTION.
 *
 * Concurrency rules for browser-driven extraction:
 *  - ACROSS customer accounts: concurrent (different sessions, no shared rate limit).
 *  - WITHIN one distributor account: 1–2 at most. The dashboard is a heavy SPA and hammering it
 *    from several tabs is exactly what caused the timeouts; it also risks tripping rate limits
 *    on a real user's account.
 *
 * The lock is held by ONE worker for one connection, with a TTL so a crashed worker's lock
 * expires instead of wedging the queue forever.
 */

export interface LockRedis {
  set(key: string, value: string, mode: 'PX', duration: number, flag: 'NX'): Promise<unknown>;
  get(key: string): Promise<string | null>;
  /**
   * Redis server-side Lua (the EVAL command), NOT JavaScript eval. Used for the standard
   * atomic compare-and-delete release, so we can never delete a lock another worker now owns.
   */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Atomic release: delete the key only if we still own it. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Atomic extend: only the owner may renew the TTL. */
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface HeldLock {
  key: string;
  token: string;
  /** Renew while a long chunk is still running (prevents TTL expiry mid-work). */
  extend(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
}

/** Default lock TTL. Renewal must run well inside this, see {@link startLockHeartbeat}. */
export const LOCK_TTL_MS = 120_000;

/**
 * Renew a held lock on a TIMER, independent of how work is progressing.
 *
 * Renewal used to happen only when a checkpoint batch was written, every 10 releases. One
 * release taking longer than the 120s TTL (a heavy SPA page, a slow retry, a stalled navigation)
 * would let the lock expire mid-chunk while we were still driving the browser. A second worker
 * could then take the same account and read it concurrently: the exact thing the lock exists to
 * prevent, happening precisely when the account is slowest and least able to take double traffic.
 *
 * `onLost` fires when renewal fails, which means someone else may now hold the lock. The caller
 * must ABORT rather than continue: continuing would be the concurrent read we were avoiding.
 */
export function startLockHeartbeat(
  lock: HeldLock,
  opts: { ttlMs?: number; onLost: (reason: string) => void; log?: (msg: string, extra?: Record<string, unknown>) => void } ,
): { stop(): void } {
  const ttlMs = opts.ttlMs ?? LOCK_TTL_MS;
  // Renew at a third of the TTL: two consecutive failures can be tolerated before expiry, so a
  // single blip doesn't hand the account to another worker.
  const everyMs = Math.max(1_000, Math.floor(ttlMs / 3));
  let stopped = false;
  let renewing = false;
  let lastConfirmedAt = Date.now();

  const timer = setInterval(() => {
    if (!stopped && Date.now() - lastConfirmedAt >= ttlMs) {
      stopped = true;
      clearInterval(timer);
      opts.onLost('lock renewal could not be confirmed before its TTL expired');
      return;
    }
    if (renewing) return;
    renewing = true;
    void (async () => {
      if (stopped) return;
      try {
        const ok = await lock.extend(ttlMs);
        if (!ok && !stopped) {
          stopped = true;
          clearInterval(timer);
          opts.onLost('lock no longer held (expired or taken by another worker)');
        } else if (ok) {
          lastConfirmedAt = Date.now();
        }
      } catch (err) {
        // A renewal error is not yet a lost lock, Redis may blip. The NEXT tick decides, and the
        // third-of-TTL cadence leaves room for that.
        opts.log?.('lock renewal failed; will retry', { error: err instanceof Error ? err.name : 'Error' });
      } finally {
        renewing = false;
      }
    })();
  }, everyMs);
  timer.unref?.();

  return { stop() { stopped = true; clearInterval(timer); } };
}

export class ConnectionLock {
  constructor(
    private readonly redis: LockRedis,
    private readonly ttlMs = 120_000,
    private readonly newToken: () => string = () => `${process.pid}-${Math.random().toString(36).slice(2)}-${Date.now()}`,
  ) {}

  private key(tenantId: string, connectionId: string): string {
    return `dk:lock:conn:${tenantId}:${connectionId}`;
  }

  /** Try to take the lock. Returns null when another worker holds it (caller should defer). */
  async acquire(tenantId: string, connectionId: string): Promise<HeldLock | null> {
    const key = this.key(tenantId, connectionId);
    const token = this.newToken();
    const ok = await this.redis.set(key, token, 'PX', this.ttlMs, 'NX');
    if (ok === null || ok === undefined) return null; // held elsewhere
    const redis = this.redis;
    return {
      key,
      token,
      async extend(ttlMs: number): Promise<boolean> {
        const res = await redis.eval(EXTEND_SCRIPT, 1, key, token, String(ttlMs));
        return res === 1 || res === '1';
      },
      async release(): Promise<void> {
        await redis.eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
      },
    };
  }
}

/** In-memory lock for tests / single-process runs. */
export class InMemoryConnectionLock {
  private readonly held = new Map<string, string>();
  async acquire(tenantId: string, connectionId: string): Promise<HeldLock | null> {
    const key = `${tenantId}:${connectionId}`;
    if (this.held.has(key)) return null;
    const token = Math.random().toString(36).slice(2);
    this.held.set(key, token);
    const held = this.held;
    return {
      key,
      token,
      async extend(): Promise<boolean> { return held.get(key) === token; },
      async release(): Promise<void> { if (held.get(key) === token) held.delete(key); },
    };
  }
}

/** Exponential backoff with FULL JITTER, avoids retry storms synchronizing across workers. */
export function backoffWithJitter(attempt: number, baseMs = 1000, maxMs = 60_000, rand: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * exp);
}
