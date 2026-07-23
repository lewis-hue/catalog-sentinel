import { describe, expect, it } from 'vitest';
import { fetchWithRetry } from './http-retry';
import type { FetchLike } from './types';

describe('fetchWithRetry', () => {
  it('retries a transient response and honors a bounded Retry-After value', async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchImpl: FetchLike = async () => {
      calls++;
      return calls === 1
        ? {
            ok: false,
            status: 429,
            headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '2' : null },
            json: async () => ({}),
            text: async () => '',
          }
        : { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    };
    const response = await fetchWithRetry(fetchImpl, 'https://example.test', undefined, {
      sleep: async (delayMs) => { delays.push(delayMs); },
      maxDelayMs: 5_000,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it('retries transport errors but never retries a non-transient client error', async () => {
    let transportCalls = 0;
    const recovered = await fetchWithRetry(async () => {
      transportCalls++;
      if (transportCalls === 1) throw new TypeError('network unavailable');
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }, 'https://example.test', undefined, { sleep: async () => undefined });
    expect(recovered.status).toBe(200);
    expect(transportCalls).toBe(2);

    let clientErrorCalls = 0;
    const clientError = await fetchWithRetry(async () => {
      clientErrorCalls++;
      return { ok: false, status: 400, json: async () => ({}), text: async () => '' };
    }, 'https://example.test', undefined, { sleep: async () => undefined });
    expect(clientError.status).toBe(400);
    expect(clientErrorCalls).toBe(1);
  });

  it('caps attempts, Retry-After delay, and each individual request duration', async () => {
    let calls = 0;
    const delays: number[] = [];
    const exhausted = await fetchWithRetry(async () => {
      calls++;
      return {
        ok: false,
        status: 503,
        headers: { get: () => '60' },
        json: async () => ({}),
        text: async () => '',
      };
    }, 'https://example.test', undefined, {
      maxAttempts: 99,
      maxDelayMs: 100,
      sleep: async (delayMs) => { delays.push(delayMs); },
    });
    expect(exhausted.status).toBe(503);
    expect(calls).toBe(5);
    expect(delays).toEqual([100, 100, 100, 100]);

    const started = Date.now();
    await expect(fetchWithRetry((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }), 'https://example.test', undefined, { maxAttempts: 1, timeoutMs: 5 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
