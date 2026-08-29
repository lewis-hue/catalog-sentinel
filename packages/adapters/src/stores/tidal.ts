import {
  normalizeArtist,
  normalizeIsrc,
  normalizeTitle,
  normalizeStoreCatalogLimit,
  type FetchLike,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type StoreTrack,
} from './types';
import { fetchWithRetry, type HttpRetryOptions } from './http-retry';

interface TidalOptions {
  clientId?: string;
  clientSecret?: string;
  profileUrl?: string;
  countryCode?: string;
  retry?: HttpRetryOptions;
}

/**
 * TIDAL store-presence provider, official TIDAL API v2 (openapi.tidal.com, JSON:API),
 * client-credentials OAuth2.
 *   - POST auth.tidal.com/v1/oauth2/token (client_credentials)      → bearer token
 *   - GET  /v2/searchResults/{q}?include=artists                    → resolve artist id
 *   - GET  /v2/artists/{id}/relationships/tracks?include=tracks     → tracks (ISRC in attributes)
 * Requires TIDAL_CLIENT_ID + TIDAL_CLIENT_SECRET from developer.tidal.com.
 */
export class TidalStoreProvider implements StoreCatalogProvider {
  readonly store = 'TIDAL';
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly api = 'https://openapi.tidal.com/v2';
  private readonly authUrl = 'https://auth.tidal.com/v1/oauth2/token';
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly profileUrl?: string;
  private readonly country: string;
  private readonly retry: HttpRetryOptions;
  private token: { value: string; expiresAt: number } | null = null;
  private lastError: string | null = null;

  constructor(
    opts: TidalOptions = {},
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly delayMs = 150,
  ) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.profileUrl = opts.profileUrl;
    this.country = opts.countryCode ?? 'US';
    this.retry = opts.retry ?? {};
    this.needsCredential = !(opts.clientId && opts.clientSecret);
  }

  static artistIdFromProfileUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !['tidal.com', 'www.tidal.com'].includes(parsed.hostname.toLowerCase())) return null;
      const m = /^\/(?:browse\/)?artist\/(\d+)\/?$/.exec(parsed.pathname);
      return m?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    if (this.needsCredential) {
      return {
        store: this.store,
        method: this.method,
        artist: null,
        tracks: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: ['TIDAL API credentials are not configured.'],
      };
    }
    this.lastError = null;
    const warnings: string[] = [];
    const resolvedArtist = await this.resolveArtist(artistName);
    if (!resolvedArtist) return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: [this.lastError
        ? `TIDAL API request failed (${this.lastError}); absence cannot be verified.`
        : `No exact TIDAL artist found for "${artistName}"; absence cannot be verified.`],
    };

    const limit = normalizeStoreCatalogLimit(opts.limit);
    const { profileAnchored, ...artist } = resolvedArtist;
    const tracks: StoreTrack[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    let total: number | null = null;
    let complete = true;
    let unusableTrackResources = 0;
    // TIDAL's current JSON:API contract requires collapseBy and exposes cursor pagination only.
    // `NONE` returns every available item; deduplication below converges editions by ISRC/title.
    let next: string | null = `${this.api}/artists/${encodeURIComponent(artist.id)}/relationships/tracks?collapseBy=NONE&countryCode=${this.country}&include=tracks`;
    const visited = new Set<string>();
    while (next && fetched < limit) {
      if (visited.has(next)) {
        complete = false;
        warnings.push('TIDAL returned a repeated pagination cursor; the catalog is incomplete.');
        break;
      }
      visited.add(next);
      const page: TidalDoc | null = await this.getJson<TidalDoc>(next);
      if (!page) {
        complete = false;
        warnings.push(`TIDAL catalog page request failed${this.lastError ? ` (${this.lastError})` : ''}; the catalog is incomplete.`);
        break;
      }
      if (!Array.isArray(page.data)) {
        complete = false;
        warnings.push('TIDAL catalog response omitted its relationship data array; the catalog is incomplete.');
        break;
      }
      const included = (page?.included ?? []).filter((resource) => resource.type === 'tracks');
      const relationships = page.data.filter((resource) => resource.type === 'tracks');
      const selectedRelationships = relationships.slice(0, limit - fetched);
      const includedById = new Map(included.map((resource) => [String(resource.id), resource]));
      const selected = selectedRelationships.flatMap((relationship) => {
        const resource = includedById.get(String(relationship.id));
        if (!resource?.attributes?.title?.trim()) {
          unusableTrackResources++;
          complete = false;
          return [];
        }
        return [resource];
      });
      const examined = selectedRelationships.length;
      fetched += examined;
      if (typeof page.meta?.total === 'number') total = page.meta.total;
      const pageTruncated = relationships.length > selectedRelationships.length;
      for (const r of selected) {
        const a = r.attributes ?? {};
        const title = a.title ?? '';
        if (!title) continue;
        const isrc = normalizeIsrc(a.isrc);
        const key = isrc ?? normalizeTitle(title);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          title,
          primaryArtist: artist.name,
          album: null,
          isrc,
          url: `https://tidal.com/browse/track/${r.id}`,
          releaseDate: a.releaseDate ?? null,
          artworkUrl: null,
        });
      }
      const nl = validatedTidalCursor(page?.links?.next);
      if (page?.links?.next && !nl) {
        complete = false;
        warnings.push('TIDAL returned an invalid pagination cursor; the catalog is incomplete.');
        next = null;
        break;
      }
      if (pageTruncated || (fetched >= limit && Boolean(nl))) {
        complete = false;
        next = null;
        break;
      }
      if (examined === 0 && nl) {
        complete = false;
        warnings.push('TIDAL pagination did not advance; the catalog is incomplete.');
        next = null;
        break;
      }
      next = nl;
    }
    if (next || (total !== null && fetched < total)) complete = false;
    if (unusableTrackResources > 0) {
      warnings.push(`TIDAL omitted usable track metadata for ${unusableTrackResources} catalog relationship${unusableTrackResources === 1 ? '' : 's'}; the catalog is incomplete.`);
    }
    if (!profileAnchored) {
      complete = false;
      warnings.push('TIDAL artist identity was resolved by name only; the catalogue is incomplete for absence decisions until an exact TIDAL_PROFILE_URL is configured.');
    }
    if (!complete && !warnings.some((warning) => /incomplete/i.test(warning))) warnings.push('TIDAL catalog was capped before every page was fetched; the catalog is incomplete.');
    if (tracks.length === 0 && complete) warnings.push('TIDAL returned the artist but no tracks.');
    return { store: this.store, method: this.method, artist, tracks, pagination: { total, fetched, complete }, warnings };
  }

  private async resolveArtist(name: string): Promise<{ id: string; name: string; url: string; profileAnchored: boolean } | null> {
    const fromUrl = this.profileUrl ? TidalStoreProvider.artistIdFromProfileUrl(this.profileUrl) : null;
    if (fromUrl) {
      const profile = await this.getJson<TidalDoc>(`${this.api}/artists/${encodeURIComponent(fromUrl)}?countryCode=${this.country}`);
      const resource = profile?.data && !Array.isArray(profile.data) && profile.data.type === 'artists'
        ? profile.data
        : null;
      const profileName = resource?.attributes?.name?.trim();
      if (resource?.id && profileName && normalizeArtist(profileName) === normalizeArtist(name)) {
        return { id: String(resource.id), name: profileName, url: `https://tidal.com/browse/artist/${resource.id}`, profileAnchored: true };
      }
    }
    const doc = await this.getJson<TidalDoc>(`${this.api}/searchResults/${encodeURIComponent(name)}?countryCode=${this.country}&include=artists`);
    const artists = (doc?.included ?? []).filter((r) => r.type === 'artists');
    const exact = artists.find((a) => normalizeArtist(a.attributes?.name ?? '') === normalizeArtist(name));
    return exact?.id ? { id: String(exact.id), name: exact.attributes?.name ?? name, url: `https://tidal.com/browse/artist/${exact.id}`, profileAnchored: false } : null;
  }

  private async getToken(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    if (!this.clientId || !this.clientSecret) return null;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    try {
      const resp = await fetchWithRetry(this.fetchImpl, this.authUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body: 'grant_type=client_credentials' }, this.retry);
      if (!resp.ok) {
        this.lastError = `OAuth HTTP ${resp.status}`;
        return null;
      }
      const j = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) {
        this.lastError = 'OAuth response omitted access_token';
        return null;
      }
      this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
      return this.token.value;
    } catch (error) {
      this.lastError = `OAuth request ${error instanceof Error ? error.name : 'failed'}`;
      return null;
    }
  }

  private async getJson<T>(url: string): Promise<T | null> {
    const token = await this.getToken();
    if (!token) {
      this.lastError ??= 'OAuth token unavailable';
      return null;
    }
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    try {
      let resp = await fetchWithRetry(this.fetchImpl, url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' } }, this.retry);
      if (resp.status === 401) {
        await resp.text().catch(() => '');
        this.token = null;
        const refreshed = await this.getToken();
        if (!refreshed) {
          this.lastError = 'OAuth token refresh failed after HTTP 401';
          return null;
        }
        resp = await fetchWithRetry(this.fetchImpl, url, { headers: { Authorization: `Bearer ${refreshed}`, Accept: 'application/vnd.api+json' } }, this.retry);
      }
      if (!resp.ok) {
        this.lastError = `HTTP ${resp.status}`;
        return null;
      }
      return (await resp.json()) as T;
    } catch (error) {
      this.lastError = `request ${error instanceof Error ? error.name : 'failed'}`;
      return null;
    }
  }
}

interface TidalResource { id?: string | number; type?: string; attributes?: { title?: string; name?: string; isrc?: string; releaseDate?: string } }
interface TidalDoc { data?: TidalResource | TidalResource[]; included?: TidalResource[]; links?: { next?: string | null }; meta?: { total?: number } }

function validatedTidalCursor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    // TIDAL returns root-relative links such as `/artists/...`, even though the
    // public API is mounted below `/v2`. Preserve the opaque cursor query while
    // restoring that prefix, and reject any cursor that could leave the API.
    const normalized = value.startsWith('/') && !value.startsWith('/v2/')
      ? `/v2${value}`
      : value;
    const url = new URL(normalized, 'https://openapi.tidal.com/v2/');
    return url.origin === 'https://openapi.tidal.com' && url.pathname.startsWith('/v2/')
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
