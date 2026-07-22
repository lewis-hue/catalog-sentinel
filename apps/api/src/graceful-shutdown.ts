export interface GracefulShutdownDeps {
  close(): Promise<void>;
  flushTelemetry(): Promise<void>;
  log(level: 'info' | 'error', message: string, error?: unknown): void;
  timeoutMs?: number;
  forceExit?: (code: number) => void;
}

/** Idempotent, bounded service shutdown. Fastify's close hook owns queue/Redis/Postgres cleanup;
 * telemetry is flushed alongside it so a rollout does not discard the final spans. */
export function createGracefulShutdown(deps: GracefulShutdownDeps): (reason: string) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return (reason: string): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const timeoutMs = deps.timeoutMs ?? 25_000;
      const forceExit = deps.forceExit ?? ((code: number) => process.exit(code));
      deps.log('info', `graceful shutdown started (${reason})`);
      const timer = setTimeout(() => {
        deps.log('error', `graceful shutdown exceeded ${timeoutMs}ms; forcing exit`);
        forceExit(1);
      }, timeoutMs);
      timer.unref?.();
      try {
        const results = await Promise.allSettled([deps.close(), deps.flushTelemetry()]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        deps.log('info', 'graceful shutdown completed');
      } catch (error) {
        deps.log('error', 'graceful shutdown failed', error);
        forceExit(1);
      } finally {
        clearTimeout(timer);
      }
    })();
    return inFlight;
  };
}
