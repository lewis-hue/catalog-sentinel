import {
  normalizeArtist,
  normalizeIsrc,
  normalizeTitle,
  normalizeStoreCatalogLimit,
  sameArtist,
  type FetchLike,
  type IsrcLookupProvider,
  type IsrcLookupResult,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type StoreTrack,
  type TitleSearchProvider,
  type TitleSearchResult,
} from './types';
import { fetchWithRetry, type HttpRetryOptions } from './http-retry';

export interface SpotifyOptions {
  /** SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET from a free developer.spotify.com app. */
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: FetchLike;
  nowMs?: () => number;
  retry?: HttpRetryOptions;
}

/**
 * Spotify store provider — REAL Web API. Client-credentials auth (a free Spotify
 * app: client id + secret). Implements all three checks:
 *   - listArtistCatalog : GET /v1/search?q=artist:"…"&type=track  (tracks + ISRC + open.spotify.com URL)
 *   - lookupIsrc        : GET /v1/search?q=isrc:…&type=track       (exact, artist-agnostic → wrong-profile)
 *   - searchTitle       : GET /v1/search?q=track:"…" artist:"…"    (confirms existence, returns the track link)
 * Docs: https://developer.spotify.com/documentation/web-api
 */
export class SpotifyStoreProvider implements StoreCatalogProvider, IsrcLookupProvider, TitleSearchProvider {
  readonly store = 'Spotify';
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly retry: HttpRetryOptions;
  private token: { value: string; expiresAtMs: number } | null = null;
  /** Last API-level error (e.g. Spotify's "Premium required for the owner"), surfaced as a warning. */
  private lastError: string | null = null;

  constructor(private readonly opts: SpotifyOptions = {}) {
    this.needsCredential = !(opts.clientId && opts.clientSecret);
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
    this.now = opts.nowMs ?? (() => Date.now());
    this.retry = opts.retry ?? {};
  }

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    if (this.needsCredential) return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: ['Spotify not configured (set SPOTIFY_CLIENT_ID/SECRET).'],
    };
    this.lastError = null;
    const limit = normalizeStoreCatalogLimit(opts.limit);
    const warnings: string[] = [];
    const seen = new Set<string>();
    const tracks: StoreTrack[] = [];
    let artist: { id: string; name: string; url: string } | null = null;
    let fetched = 0;
    let total: number | null = null;
    let hasMore = true;
    let requestFailed = false;
    const pageSignatures = new Set<string>();
    while (hasMore && fetched < limit) {
      // Spotify reduced the Search endpoint's maximum page size from 50 to 10
      // for Development Mode apps in February 2026. Ten is accepted by both
      // Development and Extended Quota Mode, so use the portable maximum.
      const pageSize = Math.min(10, limit - fetched);
      const data = await this.api<SpotifySearch>(
        `/search?q=${encodeURIComponent(`artist:"${artistName}"`)}&type=track&limit=${pageSize}&offset=${fetched}`,
      );
      if (!data?.tracks) { requestFailed = true; break; }
      const items = data.tracks.items ?? [];
      const pageSignature = JSON.stringify(items.map((track) => [track.external_urls?.spotify, track.external_ids?.isrc, track.name]));
      if (items.length > 0 && pageSignatures.has(pageSignature)) { requestFailed = true; break; }
      if (items.length > 0) pageSignatures.add(pageSignature);
      if (typeof data.tracks.total === 'number') total = data.tracks.total;
      for (const track of items) {
        const primary = track.artists?.[0];
        if (!primary || normalizeArtist(primary.name) !== normalizeArtist(artistName)) continue;
        if (!artist) artist = { id: primary.id, name: primary.name, url: primary.external_urls?.spotify ?? `https://open.spotify.com/artist/${primary.id}` };
        const key = normalizeIsrc(track.external_ids?.isrc) ?? normalizeTitle(track.name);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          title: track.name,
          primaryArtist: primary.name,
          album: track.album?.name ?? null,
          isrc: normalizeIsrc(track.external_ids?.isrc),
          url: track.external_urls?.spotify ?? null,
          releaseDate: track.album?.release_date ?? null,
          artworkUrl: track.album?.images?.[1]?.url ?? track.album?.images?.[0]?.url ?? null,
        });
      }
      fetched += items.length;
      const responseHasNext = Boolean(data.tracks.next);
      if (total !== null && fetched >= total) {
        if (responseHasNext) requestFailed = true;
        hasMore = false;
      } else {
        hasMore = responseHasNext || (total !== null && fetched < total);
      }
      if (items.length === 0 && hasMore) { requestFailed = true; break; }
    }
    const capped = fetched >= limit && hasMore;
    // `/search` is a ranked discovery endpoint, not an exhaustive artist-discography
    // endpoint. Even when its own result window is exhausted, it cannot prove that a
    // missing distributor track is absent from Spotify. Keep the catalogue explicitly
    // incomplete so the reconciliation path performs an exact ISRC/title confirmation.
    const complete = false;
    if (this.lastError) {
      warnings.push(
        /premium/i.test(this.lastError)
          ? 'Spotify Web API requires the app owner to have an active Spotify Premium subscription.'
          : `Spotify API error: ${this.lastError}`,
      );
    } else if (capped) {
      warnings.push(`Spotify catalog reached the configured ${limit}-track limit before every page was fetched; the catalog is incomplete.`);
    } else if (requestFailed) {
      warnings.push('Spotify catalog page request failed or did not advance; the catalog is incomplete.');
    }
    if (!this.lastError && !capped && !requestFailed) {
      warnings.push(artist === null
        ? `No exact Spotify artist catalog was resolved for "${artistName}"; absence cannot be verified.`
        : 'Spotify Search is non-exhaustive; exact per-track verification is required for every catalogue miss.');
    }
    return { store: this.store, method: this.method, artist, tracks, pagination: { total, fetched, complete }, warnings };
  }

  async lookupIsrc(isrc: string): Promise<IsrcLookupResult> {
    const norm = normalizeIsrc(isrc);
    const empty: IsrcLookupResult = { found: false, artist: null, title: null, url: null, artworkUrl: null };
    if (this.needsCredential || !norm) return empty;
    const data = await this.api<SpotifySearch>(`/search?q=${encodeURIComponent(`isrc:${norm}`)}&type=track&limit=1`);
    if (!data) throw new Error('Spotify ISRC lookup request failed.');
    const t = data?.tracks?.items?.[0];
    if (!t) return empty;
    return {
      found: true,
      artist: t.artists?.[0]?.name ?? null,
      title: t.name,
      url: t.external_urls?.spotify ?? null,
      artworkUrl: t.album?.images?.[1]?.url ?? null,
    };
  }

  async searchTitle(artist: string, title: string): Promise<TitleSearchResult> {
    if (this.needsCredential) return { found: false, url: null };
    const data = await this.api<SpotifySearch>(`/search?q=${encodeURIComponent(`track:"${title}" artist:"${artist}"`)}&type=track&limit=10`);
    if (!data) throw new Error('Spotify title search request failed.');
    const want = normalizeTitle(title);
    const hit = (data?.tracks?.items ?? []).find((t) => normalizeTitle(t.name) === want && sameArtist(t.artists?.[0]?.name, artist));
    return hit ? { found: true, url: hit.external_urls?.spotify ?? null } : { found: false, url: null };
  }

  private async api<T>(path: string): Promise<T | null> {
    const token = await this.getToken();
    if (!token) { this.lastError = this.lastError ?? 'Could not obtain a Spotify access token.'; return null; }
    try {
      const url = `https://api.spotify.com/v1${path}`;
      let resp = await fetchWithRetry(this.fetchImpl, url, { headers: { Authorization: `Bearer ${token}` } }, this.retry);
      if (resp.status === 401) {
        await resp.text().catch(() => '');
        this.token = null;
        const refreshed = await this.getToken();
        if (!refreshed) { this.lastError = 'Spotify access-token refresh failed after HTTP 401.'; return null; }
        resp = await fetchWithRetry(this.fetchImpl, url, { headers: { Authorization: `Bearer ${refreshed}` } }, this.retry);
      }
      if (!resp.ok) { this.lastError = `${resp.status} ${(await resp.text().catch(() => '')).slice(0, 180)}`.trim(); return null; }
      return (await resp.json()) as T;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  private async getToken(): Promise<string | null> {
    if (this.token && this.token.expiresAtMs > this.now() + 5000) return this.token.value;
    if (this.needsCredential) return null;
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    try {
      const resp = await fetchWithRetry(this.fetchImpl, 'https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      }, this.retry);
      if (!resp.ok) return null;
      const data = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) return null;
      this.token = { value: data.access_token, expiresAtMs: this.now() + (data.expires_in ?? 3600) * 1000 };
      return this.token.value;
    } catch {
      return null;
    }
  }
}

interface SpotifyArtistRef { id: string; name: string; external_urls?: { spotify?: string } }
interface SpotifyTrack {
  name: string;
  artists?: SpotifyArtistRef[];
  album?: { name?: string; release_date?: string; images?: Array<{ url: string }> };
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
}
interface SpotifySearch { tracks?: { items?: SpotifyTrack[]; total?: number; next?: string | null } }
