import { oauth1Header, type OAuth1Credentials } from './oauth1';
import {
  normalizeIsrc,
  normalizeTitle,
  normalizeStoreCatalogLimit,
  sameArtist,
  type FetchLike,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type StoreTrack,
} from './types';

/**
 * Audiomack store-presence provider — REAL Audiomack Data API (OAuth 1.0a signed,
 * 2-legged: consumer key + secret, no user token needed for public reads).
 *   - GET /v1/artist/{slug}/uploads?limit=0   → ALL the artist's uploads in one call
 *   - GET /v1/music/album/{slug}/{albumSlug}  → an album's tracklist (per-song compare)
 * Docs: https://audiomack.com/data-api/docs
 *
 * Notes from the API: pagination is `?limit=0` (everything) or `/page/N`; `released`
 * is a Unix timestamp; reposts carry a `repost` attribute (the reposting artist) and
 * are excluded; Audiomack exposes NO ISRC, so matching is by title. Requires
 * AUDIOMACK_CONSUMER_KEY / AUDIOMACK_CONSUMER_SECRET.
 */
export class AudiomackStoreProvider implements StoreCatalogProvider {
  readonly store = 'Audiomack';
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly base = 'https://api.audiomack.com/v1';
  private readonly creds: OAuth1Credentials | null;
  private readonly slug: string | null;

  constructor(
    opts: { consumerKey?: string; consumerSecret?: string; token?: string; tokenSecret?: string; slug?: string } = {},
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly delayMs = 150,
  ) {
    this.needsCredential = !(opts.consumerKey && opts.consumerSecret);
    this.creds = this.needsCredential
      ? null
      : { consumerKey: opts.consumerKey!, consumerSecret: opts.consumerSecret!, token: opts.token, tokenSecret: opts.tokenSecret };
    this.slug = opts.slug ?? null;
  }

  /** Extract an Audiomack slug from a profile URL, e.g. https://audiomack.com/lewis_ke → lewis_ke */
  static slugFromProfileUrl(url: string): string | null {
    const m = url.trim().match(/audiomack\.com\/([A-Za-z0-9_\-.]+)/i);
    return m ? (m[1] ?? null) : null;
  }

  async listArtistCatalog(artistName: string, opts: { limit?: number } = {}): Promise<StoreArtistCatalog> {
    if (!this.creds) {
      return {
        store: this.store,
        method: this.method,
        artist: null,
        tracks: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: ['Audiomack API credentials are not configured.'],
      };
    }
    const slug = this.slug ?? deriveSlug(artistName);
    const limit = normalizeStoreCatalogLimit(opts.limit);
    const warnings: string[] = [];
    const seen = new Set<string>();
    const tracks: StoreTrack[] = [];
    let complete = true;

    // One call returns the whole upload list (limit=0). Reposts are excluded below.
    const res = await this.getSigned<AudiomackList>(`/artist/${encodeURIComponent(slug)}/uploads`, { limit: '0' });
    const items = res?.results ?? [];
    const total = typeof res?.count === 'number' ? res.count : null;
    if (res == null) {
      complete = false;
      warnings.push(`Audiomack request failed for slug "${slug}" (check credentials/slug); the catalog is incomplete.`);
    } else if (total === null || items.length < total) {
      complete = false;
      warnings.push('Audiomack did not return its complete upload count; the catalog is incomplete.');
    }

    let artistName_: string | null = null;
    for (const it of items) {
      if (tracks.length >= limit) {
        complete = false;
        break;
      }
      // Skip reposts (uploads that this artist re-shared but didn't create).
      if (it.repost) continue;
      if (it.uploaded_by?.url_slug && it.uploaded_by.url_slug !== slug && it.uploader?.url_slug !== slug) continue;
      if (!artistName_) artistName_ = it.artist ?? it.uploader?.name ?? null;

      if (it.type === 'album') {
        // Expand the album into its songs so individual tracks aren't flagged missing.
        const album = await this.albumTracks(slug, it);
        if (!album.complete) {
          complete = false;
          warnings.push(`Audiomack album "${it.title ?? it.url_slug ?? '(unknown)'}" could not be expanded; the catalog is incomplete.`);
        }
        for (const s of album.tracks) {
          if (tracks.length >= limit) {
            complete = false;
            break;
          }
          addTrack(tracks, seen, s, slug, artistName || artistName_ || '', it.title ?? null);
        }
      } else {
        addTrack(tracks, seen, it, slug, artistName || artistName_ || '', null);
      }
    }

    const artist = { id: slug, name: artistName_ ?? artistName, url: `https://audiomack.com/${slug}` };
    if (!this.slug && !artistName_) {
      complete = false;
      warnings.push(`Derived Audiomack slug "${slug}" returned no artist identity; absence cannot be verified without an explicit profile URL.`);
    }
    if (artistName_ && !sameArtist(artistName_, artistName)) {
      complete = false;
      warnings.push(`Audiomack slug "${slug}" resolved to "${artistName_}", not "${artistName}"; absence cannot be verified.`);
    }
    if (!complete && !warnings.some((warning) => /incomplete|cannot be verified/i.test(warning))) {
      warnings.push(`Audiomack catalog stopped at the configured limit (${limit}); the catalog is incomplete.`);
    }
    if (tracks.length === 0 && complete) warnings.push(`Audiomack returned no uploads for slug "${slug}".`);
    return { store: this.store, method: this.method, artist, tracks, pagination: { total, fetched: items.length, complete }, warnings };
  }

  /** An album entry's tracks: inline if present, else fetched from the album detail endpoint. */
  private async albumTracks(artistSlug: string, album: AudiomackMusic): Promise<{ tracks: AudiomackMusic[]; complete: boolean }> {
    if (Array.isArray(album.tracks) && album.tracks.length) return { tracks: album.tracks, complete: true };
    if (!album.url_slug) return { tracks: [], complete: false };
    const detail = await this.getSigned<{ results?: AudiomackMusic }>(`/music/album/${encodeURIComponent(artistSlug)}/${encodeURIComponent(album.url_slug)}`, {});
    return detail?.results?.tracks?.length
      ? { tracks: detail.results.tracks, complete: true }
      : { tracks: [], complete: false };
  }

  private async getSigned<T>(path: string, query: Record<string, string>): Promise<T | null> {
    if (!this.creds) return null;
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    const baseUrl = `${this.base}${path}`;
    const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;
    const auth = oauth1Header('GET', baseUrl, query, this.creds);
    try {
      const resp = await this.fetchImpl(url, { headers: { Authorization: auth } });
      if (!resp.ok) return null;
      return (await resp.json()) as T;
    } catch {
      return null;
    }
  }
}

function addTrack(tracks: StoreTrack[], seen: Set<string>, t: AudiomackMusic, slug: string, fallbackArtist: string, albumTitle: string | null): void {
  const title = t.title ?? '';
  if (!title) return;
  const key = normalizeIsrc(t.isrc) ?? `${normalizeTitle(title)}|${normalizeTitle(t.album ?? albumTitle ?? '')}`;
  if (seen.has(key)) return;
  seen.add(key);
  tracks.push({
    title,
    primaryArtist: t.artist ?? t.uploader?.name ?? fallbackArtist,
    album: t.album || albumTitle || null,
    isrc: normalizeIsrc(t.isrc), // Audiomack has no ISRC; null unless a future field appears
    url: t.url_slug ? `https://audiomack.com/${t.uploader?.url_slug ?? slug}/song/${t.url_slug}` : `https://audiomack.com/${slug}`,
    releaseDate: unixToDate(t.released ?? t.uploaded),
    artworkUrl: t.image ?? null,
  });
}

/** "Lewis KE" → "lewis_ke" (best-effort when no explicit slug/profile URL is given). */
function deriveSlug(name: string): string {
  return name.trim().toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Audiomack dates are Unix timestamps (seconds), as strings. → YYYY-MM-DD. */
function unixToDate(ts: string | number | undefined): string | null {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

interface AudiomackList { results?: AudiomackMusic[]; count?: number }
interface AudiomackMusic {
  id?: number | string;
  type?: 'song' | 'album' | string;
  title?: string;
  artist?: string;
  url_slug?: string;
  isrc?: string;
  album?: string;
  released?: string | number;
  uploaded?: string | number;
  image?: string;
  repost?: string | boolean;
  uploader?: { name?: string; url_slug?: string };
  uploaded_by?: { name?: string; url_slug?: string };
  tracks?: AudiomackMusic[];
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
