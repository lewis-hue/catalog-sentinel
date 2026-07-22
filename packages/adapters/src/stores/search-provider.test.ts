import { describe, it, expect } from 'vitest';
import {
  ResilientSearchProvider,
  createSearxngSearch,
  createSearchProvider,
  assertSearchProviderConfig,
  searchBackendFrom,
} from './search-provider';
import type { FetchLike } from './types';

describe('createSearchProvider (selection + compliant fallback)', () => {
  it('defaults to SearXNG (self-hosted) when SEARXNG_URL is set', () => {
    const p = createSearchProvider({ SEARXNG_URL: 'http://searxng:8080' });
    expect(p?.provider).toBe('searxng');
    expect(p?.getCapabilities().selfHosted).toBe(true);
    expect(p?.getCapabilities().authoritative).toBe(false);
  });

  it('falls back to Brave when only a Brave key is set', () => {
    expect(createSearchProvider({ BRAVE_SEARCH_API_KEY: 'k' })?.provider).toBe('brave');
  });

  it('prefers SearXNG over Brave when both are configured', () => {
    expect(createSearchProvider({ SEARXNG_URL: 'http://searxng:8080', BRAVE_SEARCH_API_KEY: 'k' })?.provider).toBe('searxng');
  });

  it('returns null when no web backend is configured (official APIs only)', () => {
    expect(createSearchProvider({})).toBeNull();
  });

  it('honours an explicit SEARCH_PROVIDER pin', () => {
    expect(createSearchProvider({ SEARCH_PROVIDER: 'searxng' })).toBeNull(); // pinned but no URL
    expect(createSearchProvider({ SEARCH_PROVIDER: 'brave', BRAVE_SEARCH_API_KEY: 'k' })?.provider).toBe('brave');
  });

  it('rejects unsupported provider names during startup validation', () => {
    expect(() => assertSearchProviderConfig({ SEARCH_PROVIDER: 'unsupported' })).toThrow(/must be/);
  });
});

describe('createSearxngSearch (request + parse)', () => {
  it('calls the internal JSON endpoint and maps results', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ results: [{ url: 'https://open.spotify.com/track/x', title: 'Icy Love', content: 'by Lewis KE' }, { title: 'no url — skipped' }] }), text: async () => '' };
    };
    const search = createSearxngSearch('http://searxng:8080/', fetchImpl);
    const results = await search('"Icy Love" Lewis KE');
    expect(calledUrl).toContain('http://searxng:8080/search?q=');
    expect(calledUrl).toContain('format=json');
    expect(results).toHaveLength(1); // the entry without a url is dropped
    expect(results[0]).toEqual({ url: 'https://open.spotify.com/track/x', title: 'Icy Love', description: 'by Lewis KE' });
  });

  it('throws on non-200 so the breaker can trip', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => '' });
    await expect(createSearxngSearch('http://searxng:8080', fetchImpl)('q')).rejects.toThrow(/429/);
  });
});

describe('ResilientSearchProvider (rate limit + breaker + cache)', () => {
  it('caches identical queries (no second upstream call)', async () => {
    let calls = 0;
    const p = new ResilientSearchProvider('searxng', async () => { calls++; return [{ url: 'u', title: 't', description: '' }]; }, { minIntervalMs: 0, cacheTtlMs: 60_000 });
    await p.search('same');
    await p.search('same');
    expect(calls).toBe(1);
  });

  it('opens the circuit breaker after the failure threshold, then fails fast', async () => {
    let calls = 0;
    let t = 0;
    const p = new ResilientSearchProvider('searxng', async () => { calls++; throw new Error('down'); }, { minIntervalMs: 0, cacheTtlMs: 0, failureThreshold: 3, breakerResetMs: 1000, nowMs: () => t });
    for (let i = 0; i < 3; i++) { t += 1; expect(await p.search(`q${i}`)).toEqual([]); }
    expect(p.getHealth().breaker).toBe('open');
    expect(p.getHealth().healthy).toBe(false);
    const before = calls;
    expect(await p.search('q-open')).toEqual([]); // fails fast — no upstream call
    expect(calls).toBe(before);
    // After the reset window, a half-open trial is allowed.
    t += 2000;
    expect(p.getHealth().breaker).toBe('half-open');
  });

  it('adapts to a SearchBackend for the resolver', async () => {
    const testSearch = async (query: string) => query === 'q' ? [{ url: 'u', title: 't', description: '' }] : [];
    const p = new ResilientSearchProvider('searxng', testSearch, { minIntervalMs: 0 });
    const backend = searchBackendFrom(p);
    expect(await backend('q')).toHaveLength(1);
  });
});
