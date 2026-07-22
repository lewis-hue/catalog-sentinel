import {
  normalizeTitle,
  type FetchLike,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type TitleSearchProvider,
  type TitleSearchResult,
} from './types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

/** One web-search result. */
export interface SearchResult { url: string; title: string; description: string }
/** Pluggable search backend. A real Search API (structured JSON) is reliable;
 *  search-engine HTML scraping is blocked from servers, so it's a weak fallback. */
export type SearchBackend = (query: string) => Promise<SearchResult[]>;

/**
 * Brave Search API backend — REAL, reliable, structured. Needs BRAVE_SEARCH_API_KEY
 * (free tier at api.search.brave.com). This is the recommended backend for accurate
 * web confirmation on no-API stores. Docs: https://brave.com/search/api/
 */
export function createBraveSearch(apiKey: string, fetchImpl: FetchLike = defaultFetch, opts: { minIntervalMs?: number; nowMs?: () => number } = {}): SearchBackend {
  // Brave's free tier is 1 query/sec — serialize calls with a minimum spacing.
  const minInterval = opts.minIntervalMs ?? 1100;
  const now = opts.nowMs ?? (() => Date.now());
  let nextAllowedAt = 0;
  return async (query) => {
    const wait = Math.max(0, nextAllowedAt - now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = now() + minInterval;
    try {
      const resp = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, {
        headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as { web?: { results?: Array<{ url: string; title?: string; description?: string }> } };
      return (data.web?.results ?? []).map((r) => ({ url: r.url, title: r.title ?? '', description: r.description ?? '' }));
    } catch {
      return [];
    }
  };
}

/** DuckDuckGo HTML backend (no key). Often blocked from server IPs — weak fallback. */
export function createDuckDuckGoSearch(fetchImpl: FetchLike = defaultFetch): SearchBackend {
  return async (query) => {
    try {
      const resp = await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA } });
      if (!resp.ok) return [];
      const html = await resp.text();
      const out: SearchResult[] = [];
      const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < 12) out.push({ url: decodeDdg(m[1]!), title: stripTags(m[2]!), description: '' });
      return out;
    } catch {
      return [];
    }
  };
}

export interface WebPlatformConfig {
  store: string;
  domains: string[];
  /** URL pattern that identifies a single track/song page on this platform. */
  trackPathRe: RegExp;
}

/**
 * Confirmation for stores WITHOUT a public API: find the song via a search backend,
 * then VERIFY. Accuracy over coverage — "found" only when a track page on the
 * platform's own domain has text matching BOTH the exact title and the artist. A
 * miss is reported by the scan as `unverifiable`, never a false `not live`.
 */
export class WebSearchStore implements StoreCatalogProvider, TitleSearchProvider {
  readonly store: string;
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly search: SearchBackend;
  private readonly fetchImpl: FetchLike;
  private readonly verifyByPage: boolean;

  constructor(private readonly cfg: WebPlatformConfig, opts: { search?: SearchBackend; fetchImpl?: FetchLike; verifyByPage?: boolean } = {}) {
    this.store = cfg.store;
    this.fetchImpl = opts.fetchImpl ?? defaultFetch;
    this.search = opts.search ?? createDuckDuckGoSearch(this.fetchImpl);
    // Reliable backends (Brave) give trustworthy title/description, so a page fetch
    // isn't required; enable it for extra strictness when desired.
    this.verifyByPage = opts.verifyByPage ?? false;
    this.needsCredential = false;
  }

  async listArtistCatalog(): Promise<StoreArtistCatalog> {
    return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: ['Web search is confirmation-only and cannot enumerate a complete artist catalog.'],
    };
  }

  async searchTitle(artist: string, title: string): Promise<TitleSearchResult> {
    let candidates = this.candidatesFrom(await this.search(`"${title}" ${artist} site:${this.cfg.domains[0]}`));
    // Broaden if the site: query surfaced nothing (some domains index poorly).
    if (candidates.length === 0) {
      candidates = this.candidatesFrom(await this.search(`"${title}" ${artist} ${this.store}`));
    }
    for (const c of candidates) {
      // 1) Verify from the search result's own title + description.
      if (verifyText(`${c.title} ${c.description}`, title, artist)) return { found: true, url: c.url };
      // 2) Fallback: fetch the track page and verify its real metadata (higher recall,
      //    same precision — the page must still contain both the title and the artist).
      if (this.verifyByPage) {
        const meta = await this.fetchPageMeta(c.url);
        if (meta && verifyText(`${meta.ogTitle} ${meta.ogDescription} ${meta.pageTitle} ${meta.ld}`, title, artist)) return { found: true, url: c.url };
      }
    }
    return { found: false, url: null };
  }

  private candidatesFrom(results: SearchResult[]): SearchResult[] {
    return results.filter((r) => this.onDomain(r.url) && this.cfg.trackPathRe.test(r.url)).slice(0, 5);
  }

  private onDomain(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return this.cfg.domains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  }

  private async fetchPageMeta(url: string): Promise<PageMeta | null> {
    try {
      const resp = await this.fetchImpl(url, { headers: { 'User-Agent': UA } });
      if (!resp.ok) return null;
      const html = (await resp.text()).slice(0, 200_000);
      return {
        ogTitle: metaContent(html, 'og:title'),
        ogDescription: metaContent(html, 'og:description'),
        pageTitle: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim(),
        ld: (html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []).join(' ').slice(0, 40_000),
      };
    } catch {
      return null;
    }
  }
}

interface PageMeta { ogTitle: string; ogDescription: string; pageTitle: string; ld: string }

/** Strict match: the haystack must contain the exact title AND every artist token. */
function verifyText(hay: string, title: string, artist: string): boolean {
  const h = normalizeTitle(hay);
  const wantTitle = normalizeTitle(title);
  if (!wantTitle || !h.includes(wantTitle)) return false;
  const a = normalizeTitle(artist);
  if (!a) return false;
  if (h.includes(a)) return true;
  const tokens = a.split(' ').filter((t) => t.length >= 2);
  return tokens.length > 0 && tokens.every((t) => h.includes(t));
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, '').trim(); }

function metaContent(html: string, prop: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  return (re.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? '').trim();
}

function decodeDdg(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]!); } catch { /* fall through */ } }
  return href.startsWith('//') ? `https:${href}` : href;
}

/**
 * Track-page URL patterns per platform. Spotify + YouTube are here too, so a single
 * Brave key can confirm them by web search (their official APIs remain available and
 * take precedence when their own keys are provided).
 */
export const WEB_PLATFORMS: WebPlatformConfig[] = [
  { store: 'Spotify', domains: ['open.spotify.com'], trackPathRe: /open\.spotify\.com\/track\//i },
  { store: 'YouTube Music', domains: ['music.youtube.com', 'youtube.com', 'youtu.be'], trackPathRe: /(music\.youtube\.com\/watch|youtube\.com\/watch|youtu\.be\/)/i },
  { store: 'Audiomack', domains: ['audiomack.com'], trackPathRe: /audiomack\.com\/[^/]+\/song\//i },
  { store: 'SoundCloud', domains: ['soundcloud.com', 'on.soundcloud.com'], trackPathRe: /soundcloud\.com\/[^/]+\/(?!sets|tracks|albums|reposts|likes|following|followers|popular-tracks)[^/?#]+/i },
  { store: 'Amazon Music', domains: ['music.amazon.com'], trackPathRe: /music\.amazon\.com\/.*(tracks?|albums)\//i },
  { store: 'TIDAL', domains: ['tidal.com'], trackPathRe: /tidal\.com\/(browse\/)?track\/\d+/i },
  { store: 'Boomplay', domains: ['boomplay.com'], trackPathRe: /boomplay\.com\/(songs|share)\//i },
  { store: 'Anghami', domains: ['anghami.com', 'play.anghami.com'], trackPathRe: /anghami\.com\/song\//i },
  { store: 'Pandora', domains: ['pandora.com'], trackPathRe: /pandora\.com\/artist\/.+\/.+\/[A-Za-z0-9]+/i },
  { store: 'Napster', domains: ['napster.com', 'us.napster.com'], trackPathRe: /napster\.com\/.+\/track\//i },
];

/**
 * Resolves a song's presence across MANY platforms with minimal search queries:
 * ONE broad `"artist" "title"` search, distributed to every platform by domain, then
 * a targeted `site:` follow-up ONLY for the platforms the broad search missed. Result
 * is cached per song, so every platform's provider shares the same query budget.
 */
export class WebPresenceResolver {
  private readonly cache = new Map<string, Map<string, string | null>>();
  constructor(
    private readonly search: SearchBackend,
    private readonly platforms: WebPlatformConfig[],
    private readonly opts: { followUpMisses?: boolean } = {},
  ) {}

  async resolve(artist: string, title: string): Promise<Map<string, string | null>> {
    const key = `${normalizeTitle(artist)}|${normalizeTitle(title)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const hits = new Map<string, string | null>();
    // 1) One broad query for the whole song.
    for (const r of await this.search(`"${artist}" "${title}"`)) {
      for (const p of this.platforms) {
        if (hits.get(p.store)) continue;
        if (matches(p, r.url) && verifyText(`${r.title} ${r.description}`, title, artist)) hits.set(p.store, r.url);
      }
    }
    // 2) Targeted follow-up only for platforms the broad search didn't confirm.
    if (this.opts.followUpMisses !== false) {
      for (const p of this.platforms) {
        if (hits.get(p.store)) continue;
        const found = (await this.search(`"${title}" ${artist} site:${p.domains[0]}`)).find(
          (r) => matches(p, r.url) && verifyText(`${r.title} ${r.description}`, title, artist),
        );
        hits.set(p.store, found?.url ?? null);
      }
    }
    for (const p of this.platforms) if (!hits.has(p.store)) hits.set(p.store, null);
    this.cache.set(key, hits);
    return hits;
  }

  /** A TitleSearchProvider for one platform that reads from the shared resolver. */
  providerFor(store: string): TitleSearchProvider {
    return {
      store,
      searchTitle: async (artist, title) => {
        const url = (await this.resolve(artist, title)).get(store) ?? null;
        return { found: Boolean(url), url };
      },
    };
  }
}

function matches(p: WebPlatformConfig, url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return p.domains.some((d) => host === d || host.endsWith(`.${d}`)) && p.trackPathRe.test(url);
  } catch {
    return false;
  }
}
