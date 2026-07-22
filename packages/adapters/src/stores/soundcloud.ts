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
 * SoundCloud store-presence provider — official SoundCloud API (api.soundcloud.com),
 * client-credentials OAuth2.
 *   - POST /oauth/token (client_credentials)      → bearer token
 *   - GET  /resolve?url={profileUrl}              → resolve the artist's user id
 *   - GET  /users/{id}/tracks?linked_partitioning → the artist's tracks (paginated)
 * ISRC comes from each track's publisher_metadata. Requires SOUNDCLOUD_CLIENT_ID +
 * SOUNDCLOUD_CLIENT_SECRET (note: SoundCloud API app registration is currently gated;
 * existing credentials work).
 */
export class SoundCloudStoreProvider implements StoreCatalogProvider {
  readonly store = 'SoundCloud';
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly base = 'https://api.soundcloud.com';
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly profileUrl?: string;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    opts: { clientId?: string; clientSecret?: string; profileUrl?: string } = {},
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly delayMs = 150,
  ) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.profileUrl = opts.profileUrl;
    this.needsCredential = !(opts.clientId && opts.clientSecret);
  }

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    if (this.needsCredential) {
      return {
        store: this.store,
        method: this.method,
        artist: null,
        tracks: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: ['SoundCloud API credentials are not configured.'],
      };
    }
    const warnings: string[] = [];
    const user = await this.resolveUser(artistName);
    if (!user) return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: [`No exact SoundCloud user found for "${artistName}"; absence cannot be verified.`],
    };

    const limit = normalizeStoreCatalogLimit(opts.limit);
    const tracks: StoreTrack[] = [];
    const seen = new Set<string>();
    let fetched = 0;
    let complete = true;
    let url: string | null = `${this.base}/users/${encodeURIComponent(user.id)}/tracks?limit=50&linked_partitioning=true`;
    const visited = new Set<string>();
    while (url && fetched < limit) {
      if (visited.has(url)) {
        complete = false;
        warnings.push('SoundCloud returned a repeated pagination cursor; the catalog is incomplete.');
        break;
      }
      visited.add(url);
      const page: ScPage | null = await this.getJson<ScPage>(url);
      if (!page) {
        complete = false;
        warnings.push('SoundCloud catalog page request failed; the catalog is incomplete.');
        break;
      }
      const rows = page?.collection ?? [];
      const selected = rows.slice(0, limit - fetched);
      fetched += selected.length;
      const pageTruncated = selected.length < rows.length;
      for (const t of selected) {
        const title = t.title ?? '';
        if (!title) continue;
        const isrc = normalizeIsrc(t.publisher_metadata?.isrc);
        const key = isrc ?? normalizeTitle(title);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          title,
          primaryArtist: t.publisher_metadata?.artist ?? t.user?.username ?? user.name,
          album: t.publisher_metadata?.album_title ?? null,
          isrc,
          url: t.permalink_url ?? null,
          releaseDate: (t.display_date ?? t.created_at ?? '').slice(0, 10) || null,
          artworkUrl: t.artwork_url ?? null,
        });
      }
      const nextUrl = validatedSoundCloudCursor(page.next_href);
      if (page.next_href && !nextUrl) {
        complete = false;
        warnings.push('SoundCloud returned an invalid pagination cursor; the catalog is incomplete.');
        url = null;
        break;
      }
      if (pageTruncated || (fetched >= limit && Boolean(nextUrl))) {
        complete = false;
        url = null;
        break;
      }
      if (rows.length === 0 && nextUrl) {
        complete = false;
        warnings.push('SoundCloud pagination did not advance; the catalog is incomplete.');
        url = null;
        break;
      }
      url = nextUrl;
    }
    if (url) complete = false;
    if (!complete && !warnings.some((warning) => /incomplete/i.test(warning))) warnings.push('SoundCloud catalog was capped before every page was fetched; the catalog is incomplete.');
    if (tracks.length === 0 && complete) warnings.push('SoundCloud returned the user but no tracks.');
    return { store: this.store, method: this.method, artist: user, tracks, pagination: { total: null, fetched, complete }, warnings };
  }

  private async resolveUser(name: string): Promise<{ id: string; name: string; url: string } | null> {
    // Prefer an explicit profile URL (exact), else search users by name.
    if (this.profileUrl) {
      const r = await this.getJson<ScUser>(`${this.base}/resolve?url=${encodeURIComponent(this.profileUrl)}`);
      if (r?.id) return { id: String(r.id), name: r.username ?? name, url: r.permalink_url ?? this.profileUrl };
    }
    const list = await this.getJson<ScUser[] | ScPage<ScUser>>(`${this.base}/users?q=${encodeURIComponent(name)}&limit=5`);
    const arr = Array.isArray(list) ? list : list?.collection ?? [];
    const exact = arr.find((u) => normalizeArtist(u.username ?? '') === normalizeArtist(name));
    return exact?.id ? { id: String(exact.id), name: exact.username ?? name, url: exact.permalink_url ?? `${this.base}/users/${exact.id}` } : null;
  }

  private async getToken(): Promise<string | null> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    if (!this.clientId || !this.clientSecret) return null;
    const body = `grant_type=client_credentials&client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`;
    try {
      const resp = await this.fetchImpl(`${this.base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' }, body });
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
      const resp = await this.fetchImpl(url, { headers: { Authorization: `OAuth ${token}`, Accept: 'application/json; charset=utf-8' } });
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}

interface ScUser { id?: number | string; username?: string; permalink_url?: string }
interface ScPage<T = ScTrack> { collection?: T[]; next_href?: string | null }
interface ScTrack {
  title?: string;
  permalink_url?: string;
  artwork_url?: string;
  created_at?: string;
  display_date?: string;
  user?: { username?: string };
  publisher_metadata?: { isrc?: string; artist?: string; album_title?: string };
}

function validatedSoundCloudCursor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.soundcloud.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
