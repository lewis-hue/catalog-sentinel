/**
 * Token-bucket rate limiter applied per adapter (PRD §K/§L "enforce per-platform
 * rate limits"). Deterministic and injectable-clock friendly for tests. Every
 * external adapter path gates through a limiter so we never hammer a platform.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerMinute: number,
    private readonly burst: number = ratePerMinute,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedMin = (t - this.lastRefill) / 60_000;
    if (elapsedMin <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedMin * this.ratePerMinute);
    this.lastRefill = t;
  }

  /** Non-blocking check: true (and consumes a token) if capacity is available. */
  tryRemove(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** Milliseconds until `cost` tokens are available. */
  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.ratePerMinute) * 60_000);
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}
