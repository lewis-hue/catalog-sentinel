import {
  normalizeIsrc,
  normalizeArtist,
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

/**
 * Deezer store-presence provider, REAL public API, no credentials.
 *   - GET /search/artist?q=…   → resolve the artist id (pick the most-followed exact match)
 *   - GET /artist/{id}/albums  → the artist's releases (paginated)
 *   - GET /album/{id}/tracks   → each release's tracks (incl. ISRC + links)
 *   - GET /track/isrc:{isrc}   → artist-agnostic ISRC lookup (wrong-profile)
 * The older `/search?q=artist:"…"` track query is deliberately NOT used for the catalog: Deezer's
 * free-text search returns unrelated songs (and nothing for many major artists), which produced
 * empty catalogues and false "not live" verdicts. Walking the albums returns the real catalogue.
 * Docs: https://developers.deezer.com/api  (public, unauthenticated for reads)
 */
export class DeezerStoreProvider implements StoreCatalogProvider, IsrcLookupProvider, TitleSearchProvider {
  readonly store = 'Deezer';
  readonly method = 'api' as const;
  readonly needsCredential = false;
  private readonly base = 'https://api.deezer.com';

  constructor(private readonly fetchImpl: FetchLike = defaultFetch, private readonly delayMs = 120) {}

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    const warnings: string[] = [];
    const artist = await this.resolveArtist(artistName);
    if (!artist) {
      return {
        store: this.store,
        method: this.method,
        artist: null,
        tracks: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: [`No exact Deezer artist found for "${artistName}"; absence cannot be verified.`],
      };
    }

    const limit = normalizeStoreCatalogLimit(opts.limit);

    // 1) Enumerate the artist's releases (paginated album list).
    const albums: DeezerAlbum[] = [];
    let albumsComplete = true;
    let albumNext: string | null = `${this.base}/artist/${encodeURIComponent(artist.id)}/albums?limit=100`;
    const visitedAlbumPages = new Set<string>();
    while (albumNext) {
      if (visitedAlbumPages.has(albumNext) || albums.length >= 500) { albumsComplete = false; break; }
      visitedAlbumPages.add(albumNext);
      const page = await this.getJson<{ data?: DeezerAlbum[]; next?: string | null }>(albumNext);
      if (!page) { albumsComplete = false; break; }
      for (const a of page.data ?? []) { if (a?.id != null) albums.push(a); }
      albumNext = validatedDeezerCursor(page.next);
    }

    // 2) Read each release's tracks (these carry the ISRC the free-text search lacked). Albums are
    //    read with bounded concurrency so a prolific artist stays fast without breaching Deezer's
    //    rate limit; a hard album cap keeps the worst case bounded. Then keep only this artist's
    //    tracks, dedupe by ISRC or title, in album order, honouring the track limit.
    const MAX_ALBUMS = 80;
    const cappedAlbums = albums.length > MAX_ALBUMS;
    const scope = albums.slice(0, MAX_ALBUMS);
    const perAlbum = new Array<DeezerTrack[] | null>(scope.length);
    let requestFailed = false;
    let nextAlbum = 0;
    const readAlbum = async (): Promise<void> => {
      for (;;) {
        const i = nextAlbum++;
        const album = scope[i];
        if (!album) return;
        const res = await this.getJson<{ data?: DeezerTrack[] }>(`${this.base}/album/${encodeURIComponent(String(album.id))}/tracks?limit=200`);
        if (!res) { requestFailed = true; perAlbum[i] = null; } else { perAlbum[i] = res.data ?? []; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, scope.length) }, () => readAlbum()));

    const seen = new Set<string>();
    const tracks: StoreTrack[] = [];
    let cappedByLimit = false;
    for (let i = 0; i < scope.length && !cappedByLimit; i++) {
      const album = scope[i];
      if (!album) continue;
      for (const track of perAlbum[i] ?? []) {
        // Album tracks may include features credited to other artists; keep only this artist's.
        if (track.artist?.id && String(track.artist.id) !== artist.id) continue;
        const key = normalizeIsrc(track.isrc) ?? (normalizeTitle(track.title ?? '') || String(track.id));
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          title: track.title ?? track.title_short ?? '',
          primaryArtist: track.artist?.name ?? artist.name,
          album: album.title ?? track.album?.title ?? null,
          isrc: normalizeIsrc(track.isrc),
          url: track.link ?? (track.id ? `https://www.deezer.com/track/${track.id}` : null),
          releaseDate: album.release_date ?? null,
          artworkUrl: album.cover_medium ?? album.cover ?? track.album?.cover_medium ?? track.album?.cover ?? null,
        });
        if (tracks.length >= limit) { cappedByLimit = true; break; }
      }
    }

    const complete = albumsComplete && !requestFailed && !cappedAlbums && !cappedByLimit;
    if (requestFailed) warnings.push('A Deezer album track request failed; the catalog is incomplete.');
    else if (!albumsComplete) warnings.push('Deezer album pagination was incomplete; the catalog is incomplete.');
    else if (cappedAlbums) warnings.push(`Deezer artist has more than ${MAX_ALBUMS} releases; only the newest were read, so the catalog is incomplete.`);
    else if (cappedByLimit) warnings.push(`Deezer catalog reached the configured ${limit}-track limit before every release was read; the catalog is incomplete.`);
    else if (tracks.length === 0) warnings.push(`Deezer resolved the artist but returned no released tracks for "${artistName}".`);
    return { store: this.store, method: this.method, artist, tracks, pagination: { total: tracks.length, fetched: tracks.length, complete }, warnings };
  }

  /** Artist-agnostic ISRC lookup (exact): GET /track/isrc:{isrc}. Basis of
   *  wrong-profile detection, returns whichever artist the ISRC is credited to. */
  async lookupIsrc(isrc: string): Promise<IsrcLookupResult> {
    const norm = normalizeIsrc(isrc);
    if (!norm) return { found: false, artist: null, title: null, url: null, artworkUrl: null };
    const t = await this.getJson<DeezerTrack & { error?: unknown }>(`${this.base}/track/isrc:${norm}`);
    if (!t) throw new Error('Deezer ISRC lookup request failed.');
    if ((t as { error?: unknown }).error || !t.id) {
      return { found: false, artist: null, title: null, url: null, artworkUrl: null };
    }
    return {
      found: true,
      artist: t.artist?.name ?? null,
      title: t.title ?? null,
      url: t.link ?? `https://www.deezer.com/track/${t.id}`,
      artworkUrl: t.album?.cover_medium ?? t.album?.cover ?? null,
    };
  }

  /** Confirm a song exists on Deezer by artist + title (for tracks with no ISRC). */
  async searchTitle(artist: string, title: string): Promise<TitleSearchResult> {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const res = await this.getJson<{ data?: DeezerTrack[] }>(`${this.base}/search?q=${q}&limit=10`);
    if (!res) throw new Error('Deezer title search request failed.');
    const want = normalizeTitle(title);
    const hit = (res?.data ?? []).find((t) => normalizeTitle(t.title ?? '') === want && sameArtist(t.artist?.name, artist));
    return hit ? { found: true, url: hit.link ?? (hit.id ? `https://www.deezer.com/track/${hit.id}` : null) } : { found: false, url: null };
  }

  private async resolveArtist(name: string): Promise<{ id: string; name: string; url: string } | null> {
    const res = await this.getJson<{ data?: DeezerArtist[] }>(`${this.base}/search/artist?q=${encodeURIComponent(name)}&limit=25`);
    const list = res?.data ?? [];
    // Deezer commonly has several artists sharing a name; pick the exact-name match with the most
    // fans (the canonical one) rather than whichever the search happened to rank first.
    const best = list
      .filter((a) => normalizeArtist(a.name ?? '') === normalizeArtist(name))
      .sort((a, b) => (b.nb_fan ?? 0) - (a.nb_fan ?? 0))[0];
    if (!best) return null;
    return { id: String(best.id), name: best.name ?? name, url: best.link ?? `https://www.deezer.com/artist/${best.id}` };
  }

  private async getJson<T>(url: string): Promise<T | null> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}

interface DeezerArtist { id: number | string; name?: string; link?: string; nb_fan?: number }
interface DeezerAlbum { id: number | string; title?: string; cover?: string; cover_medium?: string; release_date?: string }
interface DeezerTrack {
  id: number | string;
  title?: string;
  title_short?: string;
  isrc?: string;
  link?: string;
  artist?: DeezerArtist;
  album?: { title?: string; cover?: string; cover_medium?: string };
}

function validatedDeezerCursor(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'api.deezer.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;
