import type { FetchLike } from './types';
import { createDuckDuckGoSearch, type SearchBackend, type SearchResult } from './web-search';

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

export type SearchProviderName = 'duckduckgo' | 'serper';

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
  /** Self-hosted versus a third-party search API (Serper is third-party). */
  selfHosted: boolean;
  /** Best-effort evidence only, never a source of truth for platform presence. */
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
 *  - a circuit breaker (fail fast when upstream is unhealthy, never hammer it),
 *  - an in-process TTL cache (dedupe queries and cut load).
 * A query that errors or trips the open breaker returns [], callers treat an empty
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
    // Cache hit, no upstream call, no rate-limit spend.
    if (this.cacheTtl > 0) {
      const hit = this.cache.get(query);
      if (hit && now - hit.at < this.cacheTtl) return hit.results;
    }
    // Circuit breaker open → fail fast (return empty → UNVERIFIABLE downstream).
    if (this.breakerState() === 'open') return [];

    // Rate limit: reserve the next slot ATOMICALLY (the read-then-write below has no `await`
    // between it, so it's indivisible in JS's single thread). Concurrent callers each grab a
    // DISTINCT slot spaced by minInterval instead of all reading the same `nextAllowedAt` and
    // bursting — which is what lets the caller parallelize tracks without exceeding the rate.
    const slot = Math.max(now, this.nextAllowedAt);
    this.nextAllowedAt = slot + this.minInterval;
    const wait = slot - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

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
 * Serper.dev search backend, a hosted Google SERP API (real results, honors `site:`, no
 * proxy/CAPTCHA fight). The reliable, scalable web-verification path for large/obscure catalogues.
 * POST {q} with an X-API-KEY header; a non-2xx
 * (quota/invalid key) throws so the circuit breaker + UNVERIFIABLE-downstream behaviour kick in.
 */
export function createSerperSearch(apiKey: string, fetchImpl: FetchLike = defaultFetch, opts: { timeoutMs?: number; endpoint?: string; gl?: string; hl?: string; num?: number } = {}): (query: string) => Promise<SearchResult[]> {
  // `||` not `??`: an empty-string endpoint (e.g. SERPER_ENDPOINT="" from a compose `${VAR:-}`
  // passthrough) must fall back to the default, or fetch('') throws "Failed to parse URL from ".
  const endpoint = opts.endpoint || 'https://google.serper.dev/search';
  const timeoutMs = opts.timeoutMs ?? 8000;
  return async (query: string) => {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: opts.num ?? 10, gl: opts.gl ?? 'us', hl: opts.hl ?? 'en' }),
        ...(controller ? { signal: controller.signal } : {}),
      } as Parameters<FetchLike>[1]);
      if (!resp.ok) throw new Error(`Serper ${resp.status}`);
      const data = (await resp.json()) as { organic?: Array<{ link?: string; title?: string; snippet?: string }> };
      return (data.organic ?? []).filter((r) => r.link).map((r) => ({ url: r.link!, title: r.title ?? '', description: r.snippet ?? '' }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export interface SearchProviderConfig {
  // Index signature so NodeJS.ProcessEnv is directly assignable (avoids TS weak-type error).
  [key: string]: string | undefined;
  SEARCH_PROVIDER?: string;
  ENABLE_WEB_SEARCH_STORES?: string;
  // Serper.dev (hosted SERP API), the reliable web-verification backend for scale.
  SERPER_API_KEY?: string;
  SERPER_ENDPOINT?: string;
  SERPER_NUM?: string;
  SERPER_TIMEOUT_MS?: string;
  SERPER_MAX_RPS?: string;
  SERPER_CACHE_TTL_SECONDS?: string;
  SERPER_CIRCUIT_BREAKER_FAILURE_THRESHOLD?: string;
  SERPER_CIRCUIT_BREAKER_RESET_SECONDS?: string;
}

/**
 * Pick the search provider from config:
 *   1. Serper (hosted Google SERP API) when SERPER_API_KEY is set, the production backend.
 *   2. null (web verification off), the scan still runs on official APIs only.
 * SEARCH_PROVIDER pins an explicit backend ('serper' | 'duckduckgo'); 'duckduckgo' is a keyless
 * dev-only fallback (usually blocked from servers). Returns null when no web backend is available.
 */
export function createSearchProvider(env: SearchProviderConfig = process.env as SearchProviderConfig, fetchImpl: FetchLike = defaultFetch): SearchProvider | null {
  const pinned = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  const serperOn = Boolean(env.SERPER_API_KEY);

  const rpsToInterval = (rps?: string, dflt = 1100): number => {
    const n = Number(rps);
    if (!(Number.isFinite(n) && n > 0)) return dflt;
    const ms = 1000 / n;
    return ms < 1 ? 0 : Math.ceil(ms); // sub-ms spacing → no throttle (very high rps)
  };

  // Serper handles its own proxy/CAPTCHA fleet, so we can drive it at a healthy rate.
  const serperRes: ResilienceOptions & { selfHosted?: boolean } = {
    selfHosted: false,
    minIntervalMs: rpsToInterval(env.SERPER_MAX_RPS, 100), // ~10 rps default; raise for higher plans
    cacheTtlMs: (Number(env.SERPER_CACHE_TTL_SECONDS) || 3600) * 1000,
    failureThreshold: Number(env.SERPER_CIRCUIT_BREAKER_FAILURE_THRESHOLD) || 6,
    breakerResetMs: (Number(env.SERPER_CIRCUIT_BREAKER_RESET_SECONDS) || 30) * 1000,
  };
  const serper = (): SearchProvider =>
    new ResilientSearchProvider('serper', createSerperSearch(env.SERPER_API_KEY!, fetchImpl, {
      timeoutMs: Number(env.SERPER_TIMEOUT_MS) || 8000,
      endpoint: env.SERPER_ENDPOINT,
      // Grouped `site: OR` queries fan across ~10 domains, so ask for more results per query to give
      // each domain room to surface (Serper bills per query, not per result, up to 100).
      num: Number(env.SERPER_NUM) || 30,
    }), serperRes);

  if (pinned === 'serper') return env.SERPER_API_KEY ? serper() : null;
  if (pinned === 'duckduckgo') return new ResilientSearchProvider('duckduckgo', wrapNoThrow(createDuckDuckGoSearch(fetchImpl)), { minIntervalMs: 1500, cacheTtlMs: 300_000 });

  // Auto: use Serper (reliable, scalable) when a key is present; else official APIs only. A buyer
  // supplies SERPER_API_KEY and web verification becomes reliable with no code change.
  if (serperOn) return serper();
  return null;
}

/**
 * Fail fast on an explicitly-pinned-but-misconfigured search provider. Called at
 * startup. Only throws when SEARCH_PROVIDER names a backend whose required config is
 * missing, auto mode (unset) never throws (it degrades to official-APIs-only).
 */
export function assertSearchProviderConfig(env: SearchProviderConfig = process.env as SearchProviderConfig): void {
  const pinned = (env.SEARCH_PROVIDER ?? '').toLowerCase();
  if (pinned && !['duckduckgo', 'serper'].includes(pinned)) {
    throw new Error('SEARCH_PROVIDER must be serper or duckduckgo.');
  }
  if (pinned === 'serper' && !env.SERPER_API_KEY) {
    throw new Error('SEARCH_PROVIDER=serper but SERPER_API_KEY is not set.');
  }
}

/** Adapt a SearchProvider to the resolver's SearchBackend function type. */
export function searchBackendFrom(provider: SearchProvider): SearchBackend {
  return (query) => provider.search(query);
}

/** createDuckDuckGoSearch already swallows errors; wrap defensively so the breaker sees real
 *  throws (e.g. a future backend that rejects). */
function wrapNoThrow(backend: SearchBackend): (query: string) => Promise<SearchResult[]> {
  return async (query) => backend(query);
}
