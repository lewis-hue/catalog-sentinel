import type { FetchLike } from './types';

export interface HttpRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

/**
 * Bounded, standards-aware retry for idempotent provider requests and OAuth token
 * exchanges. It retries only transport failures, 408/425/429, and 5xx responses;
 * authentication and other client errors remain fail-closed.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
  options: HttpRetryOptions = {},
): Promise<Awaited<ReturnType<FetchLike>>> {
  const configuredAttempts = options.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(configuredAttempts)
    ? Math.max(1, Math.min(5, Math.trunc(configuredAttempts)))
    : 3;
  const configuredBaseDelay = options.baseDelayMs ?? 250;
  const baseDelayMs = Number.isFinite(configuredBaseDelay) ? Math.max(0, configuredBaseDelay) : 250;
  const configuredMaxDelay = options.maxDelayMs ?? 10_000;
  const maxDelayMs = Number.isFinite(configuredMaxDelay) ? Math.max(0, configuredMaxDelay) : 10_000;
  const configuredTimeout = options.timeoutMs ?? 15_000;
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1, Math.min(120_000, configuredTimeout))
    : 15_000;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await fetchImpl(url, { ...(init ?? {}), signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!isTransientStatus(response.status) || attempt === maxAttempts) return response;
      // Drain retryable responses so native fetch can reuse the underlying connection.
      await response.text().catch(() => '');
      await sleep(retryDelayMs(response.headers?.get?.('retry-after') ?? null, attempt, baseDelayMs, maxDelayMs, random));
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
      await sleep(retryDelayMs(null, attempt, baseDelayMs, maxDelayMs, random));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Provider request failed after bounded retries.');
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== null) return Math.min(maxDelayMs, retryAfterMs);
  const ceiling = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
  return Math.max(0, Math.round(ceiling * Math.min(1, Math.max(0, random()))));
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}
