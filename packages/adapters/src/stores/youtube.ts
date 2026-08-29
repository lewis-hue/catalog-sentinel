import {
  normalizeTitle,
  sameArtist,
  type FetchLike,
  type StoreArtistCatalog,
  type StoreCatalogProvider,
  type TitleSearchProvider,
  type TitleSearchResult,
} from './types';

export interface YouTubeOptions {
  /** YOUTUBE_API_KEY from a free Google Cloud project (YouTube Data API v3). */
  apiKey?: string;
  fetchImpl?: FetchLike;
}

/**
 * YouTube Music store provider, REAL YouTube Data API v3 (free key). YouTube has
 * no public ISRC, so presence is confirmed by an artist+title search with STRICT
 * verification: a result counts only if its title contains the exact song title AND
 * the artist matches (the video title or the channel, incl. auto-generated
 * "{Artist} - Topic" art-track channels). Confirm-only: a miss is reported by the
 * scan as unverifiable, never a false "not live".
 * Docs: https://developers.google.com/youtube/v3/docs/search/list
 */
export class YouTubeMusicProvider implements StoreCatalogProvider, TitleSearchProvider {
  readonly store = 'YouTube Music';
  readonly method = 'api' as const;
  readonly needsCredential: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly base = 'https://www.googleapis.com/youtube/v3';

  constructor(private readonly opts: YouTubeOptions = {}) {
    this.needsCredential = !opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>);
  }

  /** No reliable full-catalogue listing via search, presence is per-track. */
  async listArtistCatalog(): Promise<StoreArtistCatalog> {
    return {
      store: this.store,
      method: this.method,
      artist: null,
      tracks: [],
      pagination: { total: null, fetched: 0, complete: false },
      warnings: this.needsCredential
        ? ['YouTube not configured (set YOUTUBE_API_KEY).']
        : ['YouTube search does not expose a complete artist catalog; absence cannot be verified.'],
    };
  }

  async searchTitle(artist: string, title: string): Promise<TitleSearchResult> {
    if (this.needsCredential) return { found: false, url: null };
    const q = encodeURIComponent(`${title} ${artist}`);
    const data = await this.getJson<YtSearch>(`${this.base}/search?part=snippet&type=video&videoCategoryId=10&maxResults=10&q=${q}&key=${this.opts.apiKey}`);
    const wantTitle = normalizeTitle(title);
    for (const item of data?.items ?? []) {
      const vidTitle = item.snippet?.title ?? '';
      if (!normalizeTitle(vidTitle).includes(wantTitle)) continue;
      const channel = (item.snippet?.channelTitle ?? '').replace(/\s*-\s*topic\s*$/i, '');
      // Artist must match the channel (art-track/official) OR appear in the title.
      if (sameArtist(channel, artist) || normalizeTitle(vidTitle).includes(normalizeTitle(artist))) {
        const id = item.id?.videoId;
        return { found: true, url: id ? `https://music.youtube.com/watch?v=${id}` : null };
      }
    }
    return { found: false, url: null };
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

interface YtSearch { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string; description?: string } }> }
