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

/**
 * TIDAL store-presence provider — official TIDAL API v2 (openapi.tidal.com, JSON:API),
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
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    opts: { clientId?: string; clientSecret?: string; profileUrl?: string; countryCode?: string } = {},
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly delayMs = 150,
  ) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.profileUrl = opts.profileUrl;
    this.country = opts.countryCode ?? 'US';
    this.needsCredential = !(opts.clientId && opts.clientSecret);
  }

  static artistIdFromProfileUrl(url: string): string | null {
    const m = url.match(/tidal\.com\/(?:browse\/)?artist\/(\d+)/i);
    return m ? (m[1] ?? null) : null;
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
    const warnings: string[] = [];
    const artist = await this.resolveArtist(artistName);
    if (!artist) return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: [`No exact TIDAL artist found for "${artistName}"; absence cannot be verified.`],
    };

    const limit = normalizeStoreCatalogLimit(opts.limit);
    const tracks: StoreTrack[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    let total: number | null = null;
    let complete = true;
    let next: string | null = `${this.api}/artists/${encodeURIComponent(artist.id)}/relationships/tracks?countryCode=${this.country}&include=tracks&page[limit]=20`;
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
        warnings.push('TIDAL catalog page request failed; the catalog is incomplete.');
        break;
      }
      const included = (page?.included ?? []).filter((resource) => resource.type === 'tracks');
      const relationships = Array.isArray(page.data) ? page.data.filter((resource) => resource.type === 'tracks') : [];
      const selectedRelationships = relationships.slice(0, limit - fetched);
      const selectedIds = new Set(selectedRelationships.map((resource) => String(resource.id)));
      const selected = relationships.length
        ? included.filter((resource) => selectedIds.has(String(resource.id)))
        : included.slice(0, limit - fetched);
      const examined = relationships.length ? selectedRelationships.length : selected.length;
      fetched += examined;
      if (typeof page.meta?.total === 'number') total = page.meta.total;
      const pageTruncated = relationships.length > selectedRelationships.length || (!relationships.length && included.length > selected.length);
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
    if (!complete && !warnings.some((warning) => /incomplete/i.test(warning))) warnings.push('TIDAL catalog was capped before every page was fetched; the catalog is incomplete.');
    if (tracks.length === 0 && complete) warnings.push('TIDAL returned the artist but no tracks.');
    return { store: this.store, method: this.method, artist, tracks, pagination: { total, fetched, complete }, warnings };
  }

  private async resolveArtist(name: string): Promise<{ id: string; name: string; url: string } | null> {
    const fromUrl = this.profileUrl ? TidalStoreProvider.artistIdFromProfileUrl(this.profileUrl) : null;
    if (fromUrl) return { id: fromUrl, name, url: `https://tidal.com/browse/artist/${fromUrl}` };
    const doc = await this.getJson<TidalDoc>(`${this.api}/searchResults/${encodeURIComponent(name)}?countryCode=${this.country}&include=artists`);
    const artists = (doc?.included ?? []).filter((r) => r.type === 'artists');
    const exact = artists.find((a) => normalizeArtist(a.attributes?.name ?? '') === normalizeArtist(name));
    return exact?.id ? { id: String(exact.id), name: exact.attributes?.name ?? name, url: `https://tidal.com/browse/artist/${exact.id}` } : null;
  }

  private async getToken(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    if (!this.clientId || !this.clientSecret) return null;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    try {
      const resp = await this.fetchImpl(this.authUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body: 'grant_type=client_credentials' });
      if (!resp.ok) return null;
      const j = (await resp.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) return null;
      this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
      return this.token.value;
    } catch {
      return null;
    }
  }

  private async getJson<T>(url: string): Promise<T | null> {
    const token = await this.getToken();
    if (!token) return null;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    try {
      const resp = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.api+json' } });
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}

interface TidalResource { id?: string | number; type?: string; attributes?: { title?: string; name?: string; isrc?: string; releaseDate?: string } }
interface TidalDoc { data?: TidalResource | TidalResource[]; included?: TidalResource[]; links?: { next?: string | null }; meta?: { total?: number } }

function validatedTidalCursor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://openapi.tidal.com');
    return url.protocol === 'https:' && url.hostname === 'openapi.tidal.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
