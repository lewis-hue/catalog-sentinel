import { describe, it, expect } from 'vitest';
import {
  ResilientSearchProvider,
  createSerperSearch,
  createSearchProvider,
  assertSearchProviderConfig,
  searchBackendFrom,
} from './search-provider';
import type { FetchLike } from './types';

describe('createSearchProvider (selection + compliant fallback)', () => {
  it('uses Serper (hosted SERP API) when SERPER_API_KEY is set', () => {
    const p = createSearchProvider({ SERPER_API_KEY: 'k' });
    expect(p?.provider).toBe('serper');
    // A Serper provider is NOT self-hosted (hosted SERP API).
    expect(p?.getCapabilities().selfHosted).toBe(false);
    expect(p?.getCapabilities().authoritative).toBe(false);
  });

  it('ignores a legacy Brave key entirely (Brave removed); no Serper key means official APIs only', () => {
    expect(createSearchProvider({ BRAVE_SEARCH_API_KEY: 'k' } as unknown as Record<string, string>)).toBeNull();
  });

  it('returns null when no web backend is configured (official APIs only)', () => {
    expect(createSearchProvider({})).toBeNull();
  });

  it('honours an explicit SEARCH_PROVIDER pin', () => {
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper' })).toBeNull(); // pinned but no key
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper', SERPER_API_KEY: 'k' })?.provider).toBe('serper');
    // duckduckgo remains the keyless dev-only fallback (usually blocked from servers).
    expect(createSearchProvider({ SEARCH_PROVIDER: 'duckduckgo' })?.provider).toBe('duckduckgo');
  });

  it('rejects unsupported provider names during startup validation, including the removed Brave and SearXNG', () => {
    expect(() => assertSearchProviderConfig({ SEARCH_PROVIDER: 'unsupported' })).toThrow(/must be/);
    expect(() => assertSearchProviderConfig({ SEARCH_PROVIDER: 'brave' })).toThrow(/must be/);
    expect(() => assertSearchProviderConfig({ SEARCH_PROVIDER: 'searxng' })).toThrow(/must be/);
  });

  it('pins Serper and validates its key at startup', () => {
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper' })).toBeNull(); // pinned but no key
    expect(createSearchProvider({ SEARCH_PROVIDER: 'serper', SERPER_API_KEY: 'k' })?.provider).toBe('serper');
    expect(() => assertSearchProviderConfig({ SEARCH_PROVIDER: 'serper' })).toThrow(/SERPER_API_KEY/);
  });
});

describe('createSerperSearch (request + parse)', () => {
  it('POSTs {q} with the API-key header and maps organic results, honoring site: queries', async () => {
    const seen: { url?: string; init?: { method?: string; headers?: Record<string, string>; body?: string } } = {};
    const fetchImpl: FetchLike = async (url, init) => {
      seen.url = url; seen.init = init as { method?: string; headers?: Record<string, string>; body?: string };
      return { ok: true, status: 200, json: async () => ({ organic: [{ link: 'https://music.youtube.com/watch?v=abc', title: 'Heartless', snippet: 'Vizy' }, { title: 'no link, skipped' }] }), text: async () => '' };
    };
    const results = await createSerperSearch('secret-key', fetchImpl)('"Heartless" Vizy site:music.youtube.com');
    expect(seen.url).toBe('https://google.serper.dev/search');
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.headers?.['X-API-KEY']).toBe('secret-key');
    expect(JSON.parse(seen.init?.body ?? '{}').q).toBe('"Heartless" Vizy site:music.youtube.com');
    expect(results).toHaveLength(1); // the entry without a link is dropped
    expect(results[0]).toEqual({ url: 'https://music.youtube.com/watch?v=abc', title: 'Heartless', description: 'Vizy' });
  });

  it('throws on a non-2xx (quota / invalid key) so the breaker trips → unverifiable downstream', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' });
    await expect(createSerperSearch('k', fetchImpl)('q')).rejects.toThrow(/Serper 429/);
  });

  it('falls back to the default endpoint when passed an empty string (compose ${VAR:-} passthrough)', async () => {
    // Regression: SERPER_ENDPOINT="" once slipped through `?? default` and made every call
    // fetch('') → "Failed to parse URL from " → breaker open → all web stores unverifiable.
    let calledUrl = '';
    const fetchImpl: FetchLike = async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ organic: [] }), text: async () => '' }; };
    await createSerperSearch('k', fetchImpl, { endpoint: '' })('q');
    expect(calledUrl).toBe('https://google.serper.dev/search');
  });
});

describe('ResilientSearchProvider (rate limit + breaker + cache)', () => {
  it('caches identical queries (no second upstream call)', async () => {
    let calls = 0;
    const p = new ResilientSearchProvider('serper', async () => { calls++; return [{ url: 'u', title: 't', description: '' }]; }, { minIntervalMs: 0, cacheTtlMs: 60_000 });
    await p.search('same');
    await p.search('same');
    expect(calls).toBe(1);
  });

  it('opens the circuit breaker after the failure threshold, then fails fast', async () => {
    let calls = 0;
    let t = 0;
    const p = new ResilientSearchProvider('serper', async () => { calls++; throw new Error('down'); }, { minIntervalMs: 0, cacheTtlMs: 0, failureThreshold: 3, breakerResetMs: 1000, nowMs: () => t });
    for (let i = 0; i < 3; i++) { t += 1; expect(await p.search(`q${i}`)).toEqual([]); }
    expect(p.getHealth().breaker).toBe('open');
    expect(p.getHealth().healthy).toBe(false);
    const before = calls;
    expect(await p.search('q-open')).toEqual([]); // fails fast, no upstream call
    expect(calls).toBe(before);
    // After the reset window, a half-open trial is allowed.
    t += 2000;
    expect(p.getHealth().breaker).toBe('half-open');
  });

  it('adapts to a SearchBackend for the resolver', async () => {
    const testSearch = async (query: string) => query === 'q' ? [{ url: 'u', title: 't', description: '' }] : [];
    const p = new ResilientSearchProvider('serper', testSearch, { minIntervalMs: 0 });
    const backend = searchBackendFrom(p);
    expect(await backend('q')).toHaveLength(1);
  });

  it('serializes CONCURRENT calls at the rate limit (no burst) so parallel callers stay compliant', async () => {
    const fires: number[] = [];
    const p = new ResilientSearchProvider('serper', async () => { fires.push(Date.now()); return []; }, { minIntervalMs: 30, cacheTtlMs: 0 });
    await Promise.all(['a', 'b', 'c', 'd'].map((q) => p.search(q)));
    expect(fires).toHaveLength(4);
    // 4 concurrent calls spaced 30ms → slots at ~0/30/60/90ms; the last fires ≥ ~60ms after the first.
    expect(Math.max(...fires) - Math.min(...fires)).toBeGreaterThanOrEqual(60);
  });
});
