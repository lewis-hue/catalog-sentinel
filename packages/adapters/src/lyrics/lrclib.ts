import { fetchWithRetry } from '../stores/http-retry';
import type { FetchLike } from '../stores/types';

/**
 * LRCLIB lyric-availability resolver.
 *
 * LRCLIB (lrclib.net) is an open, KEYLESS lyrics database, the lyrics layer behind many players.
 * It is our proxy for "do plain and/or time-synced (LRC) lyrics exist for this recording in the
 * ecosystem." We read only AVAILABILITY, never the lyric text. A Musixmatch key was unavailable
 * (their free tier is gated), so LRCLIB is the keyless substitute.
 *
 * Never-false-missing rule: a transport failure / timeout / bad status returns `unverifiable`,
 * never a claim that lyrics are absent. Only a genuine 200-with-no-match is `not-found`.
 */

export interface LyricsLookupInput {
  artist: string;
  title: string;
  album?: string | null;
  durationSec?: number | null;
}

export interface LyricsLookupResult {
  status: 'found' | 'not-found' | 'unverifiable';
  /** The source holds plain lyrics for this recording. */
  plain: boolean;
  /** The source holds time-synced (LRC) lyrics for this recording. */
  synced: boolean;
  /** The matched recording is marked instrumental (legitimately lyric-free). */
  instrumental: boolean;
  source: 'lrclib';
}

export interface LyricsResolver {
  readonly source: string;
  lookup(input: LyricsLookupInput): Promise<LyricsLookupResult>;
}

export interface LrclibResolverDeps {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_BASE = 'https://lrclib.net';
const DEFAULT_UA = 'ArtistCatalogSentinel/1.0 (catalogue lyric-availability verification)';

interface LrclibTrack { instrumental?: boolean; plainLyrics?: string | null; syncedLyrics?: string | null }

const unverifiable = (): LyricsLookupResult => ({ status: 'unverifiable', plain: false, synced: false, instrumental: false, source: 'lrclib' });
const notFound = (): LyricsLookupResult => ({ status: 'not-found', plain: false, synced: false, instrumental: false, source: 'lrclib' });

/** Drop bracketed variant tags LRCLIB won't index ("(Sped Up)", "[Remix]") so a variant still
 *  matches its base recording rather than reading as not-found. */
function queryTitle(title: string): string {
  const stripped = title.replace(/[([].*?[)\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || title.trim();
}

export function createLrclibResolver(env: NodeJS.ProcessEnv = process.env, deps: LrclibResolverDeps = {}): LyricsResolver {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  // Treat an empty/whitespace env passthrough (e.g. `${LYRICS_VERIFY_BASE_URL:-}`) as unset so it
  // falls back to the public host rather than producing a hostless URL.
  const configuredBase = (deps.baseUrl ?? env.LYRICS_VERIFY_BASE_URL ?? '').trim();
  const baseUrl = (configuredBase || DEFAULT_BASE).replace(/\/+$/, '');
  const rawTimeout = deps.timeoutMs ?? Number(env.LYRICS_LOOKUP_TIMEOUT_MS ?? 8000);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 8000;
  const userAgent = deps.userAgent ?? DEFAULT_UA;

  return {
    source: 'lrclib',
    async lookup(input) {
      const title = queryTitle(input.title || '');
      const artist = (input.artist || '').trim();
      if (!title) return unverifiable();
      const params = new URLSearchParams({ track_name: title });
      if (artist) params.set('artist_name', artist);
      if (input.album && input.album.trim()) params.set('album_name', input.album.trim());
      const url = `${baseUrl}/api/search?${params.toString()}`;
      try {
        const res = await fetchWithRetry(
          fetchImpl,
          url,
          { method: 'GET', headers: { 'User-Agent': userAgent, Accept: 'application/json' } },
          { timeoutMs, maxAttempts: 2 },
        );
        if (res.status === 404) return notFound();
        if (!res.ok) return unverifiable();
        const body = await res.json().catch(() => null);
        const list = Array.isArray(body) ? (body as LrclibTrack[]) : [];
        if (!list.length) return notFound();
        // Prefer a candidate that actually carries lyrics; else the top match.
        const best = list.find((t) => t.plainLyrics || t.syncedLyrics) ?? list[0]!;
        return {
          status: 'found',
          plain: Boolean(best.plainLyrics && String(best.plainLyrics).trim()),
          synced: Boolean(best.syncedLyrics && String(best.syncedLyrics).trim()),
          instrumental: Boolean(best.instrumental),
          source: 'lrclib',
        };
      } catch {
        // Transport failure / timeout, never assert absence.
        return unverifiable();
      }
    },
  };
}
