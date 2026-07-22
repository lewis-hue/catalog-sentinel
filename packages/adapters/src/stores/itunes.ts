import {
  normalizeArtist,
  normalizeTitle,
  normalizeStoreCatalogLimit,
  sameArtist,
  type FetchLike,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type StoreTrack,
  type TitleSearchProvider,
  type TitleSearchResult,
} from './types';

/**
 * Apple Music / iTunes store-presence provider — REAL public iTunes Search API,
 * no credentials.
 *   - GET /search?term=…&entity=musicArtist → resolve the artist id (exact-name match)
 *   - GET /lookup?id={artistId}&entity=song  → the artist's songs on Apple Music/iTunes
 * The iTunes Search API does not expose ISRC, so matching is by title + artist.
 * Docs: https://performance-partners.apple.com/search-api
 */
export class ItunesStoreProvider implements StoreCatalogProvider, TitleSearchProvider {
  readonly store: string;
  readonly method = 'api' as const;
  readonly needsCredential = false;
  private readonly base = 'https://itunes.apple.com';

  constructor(
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly opts: { country?: string; label?: string } = {},
  ) {
    this.store = opts.label ?? 'Apple Music / iTunes';
  }

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    const country = this.opts.country ?? 'US';
    const artist = await this.resolveArtist(artistName, country);
    if (!artist) {
      return {
        store: this.store,
        method: this.method,
        artist: null,
        tracks: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: [`No exact Apple/iTunes artist found for "${artistName}"; absence cannot be verified.`],
      };
    }

    const requestedLimit = normalizeStoreCatalogLimit(opts.limit);
    // The public Search API has no cursor and accepts at most 200 results. Hitting
    // that upstream cap is explicitly incomplete; supplemental title queries can
    // still prove individual positive matches.
    const limit = Math.min(requestedLimit, 200);
    const res = await this.getJson<{ resultCount?: number; results?: ItunesEntity[] }>(
      `${this.base}/lookup?id=${artist.id}&entity=song&limit=${limit}&country=${country}`,
    );
    const rows = (res?.results ?? []).filter(
      (r) => r.wrapperType === 'track' && r.kind === 'song' && sameArtist(r.artistName, artist.name),
    );
    const seen = new Set<string>();
    const tracks: StoreTrack[] = [];
    for (const r of rows) {
      const key = `${normalizeTitle(r.trackName ?? '')}|${normalizeTitle(r.collectionName ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({
        title: r.trackName ?? '',
        primaryArtist: r.artistName ?? artist.name,
        album: r.collectionName ?? null,
        isrc: null, // iTunes Search API does not expose ISRC
        url: r.trackViewUrl ?? null,
        releaseDate: r.releaseDate ?? null,
        artworkUrl: (r.artworkUrl100 ?? r.artworkUrl60 ?? null)?.replace(/\/\d+x\d+bb\.jpg$/, '/300x300bb.jpg') ?? null,
      });
    }
    const fetched = res?.results?.length ?? 0;
    // iTunes exposes only the returned resultCount, not a total/next cursor. Reaching
    // the requested cap is therefore conservatively treated as truncation.
    const complete = res !== null && typeof res.resultCount === 'number' && res.resultCount < limit;
    const warnings: string[] = [];
    if (res === null) warnings.push('Apple/iTunes catalog request failed; the catalog is incomplete.');
    else if (!complete) warnings.push('Apple/iTunes catalog reached its result cap or omitted resultCount; the catalog is incomplete.');
    if (tracks.length === 0 && complete) warnings.push('Apple/iTunes returned the artist but no songs — catalog may be empty or region-restricted.');
    return { store: this.store, method: this.method, artist, tracks, pagination: { total: null, fetched, complete }, warnings };
  }

  /** Confirm a song exists on Apple/iTunes by artist + title (no ISRC on this API). */
  async searchTitle(artist: string, title: string): Promise<TitleSearchResult> {
    const country = this.opts.country ?? 'US';
    const res = await this.getJson<{ results?: ItunesEntity[] }>(
      `${this.base}/search?term=${encodeURIComponent(`${artist} ${title}`)}&entity=song&limit=25&country=${country}`,
    );
    if (!res) throw new Error('Apple/iTunes title search request failed.');
    const want = normalizeTitle(title);
    const hit = (res?.results ?? []).find(
      (r) => r.wrapperType === 'track' && normalizeTitle(r.trackName ?? '') === want && sameArtist(r.artistName, artist),
    );
    return hit ? { found: true, url: hit.trackViewUrl ?? null } : { found: false, url: null };
  }

  private async resolveArtist(name: string, country: string): Promise<{ id: string; name: string; url: string } | null> {
    const res = await this.getJson<{ results?: ItunesEntity[] }>(
      `${this.base}/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=10&country=${country}`,
    );
    const list = (res?.results ?? []).filter((r) => r.wrapperType === 'artist' || r.artistType === 'Artist');
    const exact = list.find((a) => normalizeArtist(a.artistName ?? '') === normalizeArtist(name));
    if (!exact?.artistId) return null;
    return { id: String(exact.artistId), name: exact.artistName ?? name, url: exact.artistLinkUrl ?? `https://music.apple.com/artist/${exact.artistId}` };
  }

  private async getJson<T>(url: string): Promise<T | null> {
    try {
      const resp = await this.fetchImpl(url);
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}

interface ItunesEntity {
  wrapperType?: string;
  kind?: string;
  artistType?: string;
  artistId?: number | string;
  artistName?: string;
  artistLinkUrl?: string;
  trackName?: string;
  collectionName?: string;
  trackViewUrl?: string;
  releaseDate?: string;
  artworkUrl60?: string;
  artworkUrl100?: string;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>;
