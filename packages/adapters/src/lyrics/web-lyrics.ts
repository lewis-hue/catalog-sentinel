import { normalizeTitle } from '../stores/types';
import {
  SITE_GROUP_SIZE,
  chunk,
  verifyText,
  type SearchBackend,
} from '../stores/web-search';

/**
 * Serper (web-search) lyric verification. Instead of a single crowd-sourced lyrics database
 * (LRCLIB, which returns wrong answers), this confirms, PER STORE, whether that store actually
 * DISPLAYS the song's lyrics, by reading the store's own SERP snippet, plus a per-song LyricFind
 * signal that DistroKid distributed the lyrics to stores at all.
 *
 * Same budget discipline as the store-presence resolver: ONE broad `"<artist>" "<title>" lyrics`
 * query + a FEW grouped `site: OR` follow-ups, cached per song. Precision over recall: a store is
 * only ever `shown` when its own page's snippet both verifies the song and carries a lyric marker.
 */
export type StoreLyricStatus = 'shown' | 'not-shown' | 'unverifiable';

export interface SongLyricEvidence {
  /** Only stores the search actually PROVED display lyrics (value always `shown`). The worker fills
   *  `not-shown`/`unverifiable` for the remaining lyric-capable stores using known presence. */
  shownStores: Set<string>;
  lyricfindDistributed: boolean;
  lyricfindUrl: string | null;
}

export interface LyricCapablePlatform {
  store: string;
  domains: string[];
  /** When false, only the broad query can match this store (no targeted `site:` follow-up). */
  followUp?: boolean;
}

/**
 * Stores known to render song lyrics on their own web pages, so a SERP snippet can prove display.
 * Store names MUST match the presence platform names (WEB_PLATFORMS) so the per-store merge lines up.
 */
export const LYRIC_PLATFORMS: LyricCapablePlatform[] = [
  { store: 'Apple Music', domains: ['music.apple.com'] },
  { store: 'Amazon Music', domains: ['music.amazon.com'] },
  { store: 'YouTube Music', domains: ['music.youtube.com', 'youtube.com'] },
  { store: 'Deezer', domains: ['deezer.com'] },
  { store: 'Boomplay', domains: ['boomplay.com'] },
  { store: 'Anghami', domains: ['anghami.com', 'play.anghami.com'] },
  { store: 'JioSaavn', domains: ['jiosaavn.com', 'saavn.com'] },
  { store: 'Pandora', domains: ['pandora.com'] },
  { store: 'iHeartRadio', domains: ['iheart.com'] },
];

const LYRICFIND_DOMAIN = 'lyrics.lyricfind.com';
/** A lyric marker in the snippet: a "Lyrics" label, a songwriter / "Composition & Lyrics" credit,
 *  or the store's "View Full Lyrics" gate. Kept strict so a mere "lyrics" navigation word alone on a
 *  non-lyric page does not qualify (it must co-occur with a verified song match). */
const LYRIC_MARKER = /(view full lyrics|composition\s*&?\s*lyrics|songwriters?|\blyrics\b)/i;

function onAnyDomain(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** A SERP snippet proves a store SHOWS lyrics when it verifies the song (exact title + artist tokens)
 *  AND carries a lyric marker. Precision over recall: never infer lyrics from a bare title match. */
export function snippetShowsLyrics(title: string, artist: string, text: string): boolean {
  if (!verifyText(text, title, artist)) return false;
  return LYRIC_MARKER.test(text);
}

export class WebLyricsResolver {
  private readonly cache = new Map<string, SongLyricEvidence>();
  constructor(
    private readonly search: SearchBackend,
    private readonly platforms: LyricCapablePlatform[] = LYRIC_PLATFORMS,
    private readonly opts: { followUpMisses?: boolean } = {},
  ) {}

  async resolve(artist: string, title: string): Promise<SongLyricEvidence> {
    const key = `${normalizeTitle(artist)}|${normalizeTitle(title)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const followUp = this.opts.followUpMisses === false ? [] : this.platforms.filter((p) => p.followUp !== false);
    // ONE broad lyrics query (also surfaces the LyricFind page + most stores' lyric snippets) plus a
    // few grouped `site:` follow-ups for lyric-capable stores. 1 + ceil(N / SITE_GROUP_SIZE) requests.
    // Deliberately UNQUOTED: double-quoting artist AND title returns zero Google/Serper results for
    // many songs, whereas the plain `<artist> <title> lyrics` form recalls them. Precision is not lost:
    // every result is still domain-matched AND verifyText-checked (exact title + all artist tokens).
    const queries = [`${artist} ${title} lyrics`];
    for (const group of chunk(followUp, SITE_GROUP_SIZE)) {
      queries.push(`${artist} ${title} lyrics (${group.map((p) => `site:${p.domains[0]}`).join(' OR ')})`);
    }
    const resultSets = await Promise.all(queries.map((q) => this.search(q)));

    const shownStores = new Set<string>();
    let lyricfindUrl: string | null = null;
    for (const results of resultSets) {
      for (const r of results) {
        const text = `${r.title} ${r.description}`;
        if (!lyricfindUrl && onAnyDomain(r.url, [LYRICFIND_DOMAIN]) && verifyText(text, title, artist)) {
          lyricfindUrl = r.url;
        }
        for (const p of this.platforms) {
          if (shownStores.has(p.store)) continue;
          if (onAnyDomain(r.url, p.domains) && snippetShowsLyrics(title, artist, text)) shownStores.add(p.store);
        }
      }
    }

    const evidence: SongLyricEvidence = {
      shownStores,
      lyricfindDistributed: Boolean(lyricfindUrl),
      lyricfindUrl,
    };
    this.cache.set(key, evidence);
    return evidence;
  }
}
