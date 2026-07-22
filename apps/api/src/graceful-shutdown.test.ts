import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from './graceful-shutdown';

afterEach(() => vi.useRealTimers());

describe('API graceful shutdown', () => {
  it('is idempotent and closes Fastify resources plus telemetry once', async () => {
    const close = vi.fn(async () => undefined);
    const flushTelemetry = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({ close, flushTelemetry, log: vi.fn() });

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    expect(second).toBe(first);
    await first;
    expect(close).toHaveBeenCalledOnce();
    expect(flushTelemetry).toHaveBeenCalledOnce();
  });

  it('forces a nonzero exit when cleanup exceeds its rollout budget', async () => {
    vi.useFakeTimers();
    const forceExit = vi.fn();
    const shutdown = createGracefulShutdown({
      close: () => new Promise<void>(() => undefined),
      flushTelemetry: async () => undefined,
      log: vi.fn(),
      timeoutMs: 100,
      forceExit,
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(101);
    expect(forceExit).toHaveBeenCalledWith(1);
  });
});
