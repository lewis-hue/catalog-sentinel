import type { FetchLike } from './types';
import { createBraveSearch, createDuckDuckGoSearch, type SearchBackend, type SearchResult } from './web-search';

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export type SearchProviderName = 'searxng' | 'brave' | 'duckduckgo';

export interface SearchProviderHealth {
  provider: SearchProviderName;
  /** false while the circuit breaker is open (failing fast, not calling upstream). */
  healthy: boolean;
  breaker: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  lastError?: string;
  lastCheckedAt?: string;
}

export interface SearchProviderCapabilities {
  provider: SearchProviderName;
  /** Self-hosted (SearXNG) versus a third-party search API. */
  selfHosted: boolean;
  /** Best-effort evidence only — never a source of truth for platform presence. */
  authoritative: false;
  maxRps: number;
}

export interface SearchProvider {
  readonly provider: SearchProviderName;
  search(query: string): Promise<SearchResult[]>;
  getHealth(): SearchProviderHealth;
  getCapabilities(): SearchProviderCapabilities;
}

export interface ResilienceOptions {
  /** Minimum ms between upstream calls (per-provider rate limit). */
  minIntervalMs?: number;
  /** Open the breaker after this many consecutive failures. */
  failureThreshold?: number;
  /** How long the breaker stays open before a half-open trial. */
  breakerResetMs?: number;
  /** In-process result cache TTL (dedupes repeated queries within a scan). 0 disables. */
  cacheTtlMs?: number;
  nowMs?: () => number;
}

/**
 * Wraps a raw search function with the compliant resilience the policy requires:
 *  - a per-provider rate limit (spacing, NOT evasion),
 *  - a circuit breaker (fail fast when upstream is unhealthy — never hammer it),
 *  - an in-process TTL cache (dedupe queries and cut load).
 * A query that errors or trips the open breaker returns [] — callers treat an empty
 * result as UNVERIFIABLE, never a confirmed "missing". No proxy/Tor/anti-bot logic.
 */
export class ResilientSearchProvider implements SearchProvider {
  readonly provider: SearchProviderName;
  private readonly raw: (query: string) => Promise<SearchResult[]>;
  private readonly minInterval: number;
  private readonly failureThreshold: number;
  private readonly breakerResetMs: number;
  private readonly cacheTtl: number;
  private readonly now: () => number;
  private readonly selfHosted: boolean;

  private nextAllowedAt = 0;
  private failures = 0;
  private breakerOpenUntil = 0;
  private lastError: string | undefined;
  private lastCheckedAt: string | undefined;
  private readonly cache = new Map<string, { at: number; results: SearchResult[] }>();

  constructor(provider: SearchProviderName, raw: (query: string) => Promise<SearchResult[]>, opts: ResilienceOptions & { selfHosted?: boolean } = {}) {
    this.provider = provider;
    this.raw = raw;
    this.minInterval = opts.minIntervalMs ?? 1100;
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.breakerResetMs = opts.breakerResetMs ?? 30_000;
    this.cacheTtl = opts.cacheTtlMs ?? 5 * 60_000;
    this.now = opts.nowMs ?? (() => Date.now());
    this.selfHosted = opts.selfHosted ?? false;
  }

  async search(query: string): Promise<SearchResult[]> {
    const now = this.now();
    // Cache hit — no upstream call, no rate-limit spend.
    if (this.cacheTtl > 0) {
      const hit = this.cache.get(query);
      if (hit && now - hit.at < this.cacheTtl) return hit.results;
    }
    // Circuit breaker open → fail fast (return empty → UNVERIFIABLE downstream).
    if (this.breakerState() === 'open') return [];

    // Rate limit: space calls out (compliant spacing, not evasion).
    const wait = Math.max(0, this.nextAllowedAt - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nextAllowedAt = this.now() + this.minInterval;

    this.lastCheckedAt = new Date(this.now()).toISOString();
    try {
      const results = await this.raw(query);
      this.failures = 0;
      this.breakerOpenUntil = 0;
      this.lastError = undefined;
      if (this.cacheTtl > 0) this.cache.set(query, { at: this.now(), results });
      return results;
    } catch (err) {
      this.failures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.failures >= this.failureThreshold) this.breakerOpenUntil = this.now() + this.breakerResetMs;
      return [];
    }
  }

  private breakerState(): 'closed' | 'open' | 'half-open' {
    if (this.breakerOpenUntil === 0) return 'closed';
    if (this.now() >= this.breakerOpenUntil) return 'half-open'; // allow a trial call
    return 'open';
  }

  getHealth(): SearchProviderHealth {
    const breaker = this.breakerState();
    return { provider: this.provider, healthy: breaker !== 'open', breaker, consecutiveFailures: this.failures, lastError: this.lastError, lastCheckedAt: this.lastCheckedAt };
  }

  getCapabilities(): SearchProviderCapabilities {
    return { provider: this.provider, selfHosted: this.selfHosted, authoritative: false, maxRps: this.minInterval > 0 ? Math.max(1, Math.round(1000 / this.minInterval)) : 0 };
  }
}

/**
 * SearXNG JSON search backend — self-hosted metasearch. Calls the INTERNAL SearXNG
 * endpoint (`${url}/search?format=json`). Best-effort evidence only. No Tor/proxy/anti-bot
 * logic — if SearXNG is rate-limited or blocked upstream, we back off and return [].
 */
export function createSearxngSearch(searxngUrl: string, fetchImpl: FetchLike = defaultFetch, opts: { timeoutMs?: number } = {}): (query: string) => Promise<SearchResult[]> {
  const base = searxngUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  return async (query: string) => {
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=0&categories=general`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetchImpl(url, { headers: { Accept: 'application/json' }, ...(controller ? { signal: controller.signal } : {}) } as Parameters<FetchLike>[1]);
      if (!resp.ok) throw new Error(`SearXNG ${resp.status}`);
      const data = (await resp.json()) as { results?: Array<{ url?: string; title?: string; content?: string }> };
      return (data.results ?? []).filter((r) => r.url).map((r) => ({ url: r.url!, title: r.title ?? '', description: r.content ?? '' }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export interface SearchProviderConfig {
  // Index signature so NodeJS.ProcessEnv is directly assignable (avoids TS weak-type error).
  [key: string]: string | undefined;
  SEARCH_PROVIDER?: string;
  SEARXNG_URL?: string;
  SEARXNG_TIMEOUT_MS?: string;
  SEARXNG_MAX_RPS?: string;
  SEARXNG_CACHE_TTL_SECONDS?: string;
  SEARXNG_CIRCUIT_BREAKER_FAILURE_THRESHOLD?: string;
  SEARXNG_CIRCUIT_BREAKER_RESET_SECONDS?: string;
  BRAVE_SEARCH_API_KEY?: string;
  BRAVE_MAX_RPS?: string;
  ENABLE_SEARXNG_PROVIDER?: string;
  ENABLE_BRAVE_PROVIDER?: string;
  ENABLE_WEB_SEARCH_STORES?: string;
}

const isOn = (v: string | undefined, dflt = false): boolean => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(v));

/**
 * Pick the search provider from config. Order of preference (compliant fallback):
 *   1. SearXNG (self-hosted) when SEARXNG_URL is set and enabled — the DEFAULT.
 *   2. Brave API when a key is set and enabled — optional fallback.
 *   3. null (web verification off) — the scan still runs on official APIs only.
 * SEARCH_PROVIDER pins an explicit real backend ('searxng' | 'brave' | 'duckduckgo').
 * Returns null when no web backend is available (callers must handle a null provider).
 */
export function createSearchProvider(env: SearchProviderConfig = process.env as SearchProviderConfig, fetchImpl: FetchLike = defaultFetch): SearchProvider | null {
  const pinned = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  const searxngOn = isOn(env.ENABLE_SEARXNG_PROVIDER, true) && Boolean(env.SEARXNG_URL);
  const braveOn = isOn(env.ENABLE_BRAVE_PROVIDER, false) ? Boolean(env.BRAVE_SEARCH_API_KEY) : Boolean(env.BRAVE_SEARCH_API_KEY);

  const rpsToInterval = (rps?: string, dflt = 1100): number => {
    const n = Number(rps);
    if (!(Number.isFinite(n) && n > 0)) return dflt;
    const ms = 1000 / n;
    return ms < 1 ? 0 : Math.ceil(ms); // sub-ms spacing → no throttle (very high rps)
  };
  const searxngRes: ResilienceOptions & { selfHosted?: boolean } = {
    selfHosted: true,
    minIntervalMs: rpsToInterval(env.SEARXNG_MAX_RPS, 500),
    cacheTtlMs: (Number(env.SEARXNG_CACHE_TTL_SECONDS) || 300) * 1000,
    failureThreshold: Number(env.SEARXNG_CIRCUIT_BREAKER_FAILURE_THRESHOLD) || 5,
    breakerResetMs: (Number(env.SEARXNG_CIRCUIT_BREAKER_RESET_SECONDS) || 30) * 1000,
  };
  const searxng = (): SearchProvider =>
    new ResilientSearchProvider('searxng', createSearxngSearch(env.SEARXNG_URL!, fetchImpl, { timeoutMs: Number(env.SEARXNG_TIMEOUT_MS) || 8000 }), searxngRes);
  const brave = (): SearchProvider =>
    new ResilientSearchProvider('brave', wrapNoThrow(createBraveSearch(env.BRAVE_SEARCH_API_KEY!, fetchImpl)), { minIntervalMs: rpsToInterval(env.BRAVE_MAX_RPS, 1100), cacheTtlMs: 300_000 });

  if (pinned === 'searxng') return env.SEARXNG_URL ? searxng() : null;
  if (pinned === 'brave') return env.BRAVE_SEARCH_API_KEY ? brave() : null;
  if (pinned === 'duckduckgo') return new ResilientSearchProvider('duckduckgo', wrapNoThrow(createDuckDuckGoSearch(fetchImpl)), { minIntervalMs: 1500, cacheTtlMs: 300_000 });

  // Auto: SearXNG first (self-hosted default), then Brave, else none.
  if (searxngOn) return searxng();
  if (braveOn) return brave();
  return null;
}

/**
 * Fail fast on an explicitly-pinned-but-misconfigured search provider. Called at
 * startup. Only throws when SEARCH_PROVIDER names a backend whose required config is
 * missing — auto mode (unset) never throws (it degrades to official-APIs-only).
 */
export function assertSearchProviderConfig(env: SearchProviderConfig = process.env as SearchProviderConfig): void {
  const pinned = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (pinned && !['searxng', 'brave', 'duckduckgo'].includes(pinned)) {
    throw new Error('SEARCH_PROVIDER must be searxng, brave, or duckduckgo.');
  }
  if (pinned === 'searxng' && !env.SEARXNG_URL) {
    throw new Error('SEARCH_PROVIDER=searxng but SEARXNG_URL is not set.');
  }
  if (pinned === 'brave' && !env.BRAVE_SEARCH_API_KEY) {
    throw new Error('SEARCH_PROVIDER=brave but BRAVE_SEARCH_API_KEY is not set.');
  }
}

/** Adapt a SearchProvider to the resolver's SearchBackend function type. */
export function searchBackendFrom(provider: SearchProvider): SearchBackend {
  return (query) => provider.search(query);
}

/** createBraveSearch/createDuckDuckGoSearch already swallow errors; wrap defensively so
 *  the breaker sees real throws (e.g. a future backend that rejects). */
function wrapNoThrow(backend: SearchBackend): (query: string) => Promise<SearchResult[]> {
  return async (query) => backend(query);
}
