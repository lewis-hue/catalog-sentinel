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
 *   - GET /search/artist?q=…            → resolve the artist id
 *   - GET /search?q=artist:"…"&limit=…  → the artist's tracks (incl. ISRC + links)
 *   - GET /track/isrc:{isrc}            → artist-agnostic ISRC lookup (wrong-profile)
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
    const q = encodeURIComponent(`artist:"${artistName}"`);
    const seen = new Set<string>();
    const tracks: StoreTrack[] = [];
    let fetched = 0;
    let total: number | null = null;
    let next: string | null = `${this.base}/search?q=${q}&limit=${Math.min(100, limit)}`;
    let requestFailed = false;
    let invalidCursor = false;
    const visited = new Set<string>();
    while (next && fetched < limit) {
      if (visited.has(next)) { invalidCursor = true; break; }
      visited.add(next);
      const res = await this.getJson<{ data?: DeezerTrack[]; next?: string | null; total?: number }>(next);
      if (!res) { requestFailed = true; break; }
      if (typeof res.total === 'number') total = res.total;
      const rows = res.data ?? [];
      const selected = rows.slice(0, limit - fetched);
      fetched += selected.length;
      for (const track of selected) {
        // Search can bleed into similarly named artists. Foreign credits do not
        // enter this artist's index, but they still count as fetched upstream rows.
        if (track.artist?.id && artist.id && String(track.artist.id) !== artist.id) continue;
        const key = normalizeIsrc(track.isrc) ?? track.title?.toLowerCase() ?? String(track.id);
        if (seen.has(key)) continue;
        seen.add(key);
        tracks.push({
          title: track.title ?? track.title_short ?? '',
          primaryArtist: track.artist?.name ?? artist.name,
          album: track.album?.title ?? null,
          isrc: normalizeIsrc(track.isrc),
          url: track.link ?? (track.id ? `https://www.deezer.com/track/${track.id}` : null),
          releaseDate: null,
          artworkUrl: track.album?.cover_medium ?? track.album?.cover ?? null,
        });
      }
      if (selected.length < rows.length) break;
      next = validatedDeezerCursor(res.next);
      if (res.next && !next) { invalidCursor = true; break; }
      if (rows.length === 0 && next) { invalidCursor = true; break; }
    }
    const capped = fetched >= limit && ((total !== null && fetched < total) || next !== null);
    const complete = !requestFailed && !invalidCursor && !capped && total !== null && fetched >= total && next === null;
    if (requestFailed) warnings.push('Deezer catalog page request failed; the catalog is incomplete.');
    else if (invalidCursor) warnings.push('Deezer returned an invalid or non-advancing pagination cursor; the catalog is incomplete.');
    else if (capped) warnings.push(`Deezer catalog reached the configured ${limit}-track limit before every page was fetched; the catalog is incomplete.`);
    else if (!complete) warnings.push('Deezer catalog is incomplete because pagination metadata was unavailable or inconsistent.');
    if (tracks.length === 0 && complete) warnings.push('Deezer returned the artist but no tracks matched, the catalog may be empty or under a different artist entry.');
    return { store: this.store, method: this.method, artist, tracks, pagination: { total, fetched, complete }, warnings };
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
    const res = await this.getJson<{ data?: DeezerArtist[] }>(`${this.base}/search/artist?q=${encodeURIComponent(name)}&limit=5`);
    const list = res?.data ?? [];
    const exact = list.find((a) => normalizeArtist(a.name ?? '') === normalizeArtist(name));
    if (!exact) return null;
    return { id: String(exact.id), name: exact.name ?? name, url: exact.link ?? `https://www.deezer.com/artist/${exact.id}` };
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

interface DeezerArtist { id: number | string; name?: string; link?: string }
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
