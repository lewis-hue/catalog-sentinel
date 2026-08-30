import { describe, expect, it } from 'vitest';
import {
  LYRIC_PLATFORMS,
  WebLyricsResolver,
  snippetShowsLyrics,
  type LyricCapablePlatform,
} from './web-lyrics';
import type { SearchBackend, SearchResult } from '../stores/web-search';

const ARTIST = 'Lewis KE';
const TITLE = 'Icy Love';

/** A backend that returns canned results per query and records how many queries it ran. */
function backend(map: Record<string, SearchResult[]>): { search: SearchBackend; calls: string[] } {
  const calls: string[] = [];
  const search: SearchBackend = async (q) => {
    calls.push(q);
    // Match on a stable fragment so tests do not depend on exact query spelling.
    for (const [needle, results] of Object.entries(map)) if (q.includes(needle)) return results;
    return [];
  };
  return { search, calls };
}

const appleLyricResult: SearchResult = {
  url: 'https://music.apple.com/us/song/icy-love/123',
  title: 'Icy Love - Song by Lewis KE',
  description: 'Lyrics Yeah yeah You cured me with your love Now you gone Sign in to View Full Lyrics Icy Love. Composition & Lyrics Lewis KE',
};

describe('snippetShowsLyrics', () => {
  it('accepts a verified song snippet with a lyric marker', () => {
    expect(snippetShowsLyrics(TITLE, ARTIST, `${appleLyricResult.title} ${appleLyricResult.description}`)).toBe(true);
  });
  it('rejects a title match with no lyric marker', () => {
    expect(snippetShowsLyrics(TITLE, ARTIST, 'Icy Love - Song by Lewis KE. Listen on Apple Music.')).toBe(false);
  });
  it('rejects a lyric marker for the wrong song', () => {
    expect(snippetShowsLyrics(TITLE, ARTIST, 'Different Song by Someone Else. Lyrics here.')).toBe(false);
  });
});

describe('WebLyricsResolver', () => {
  it('proves per-store lyric display from the broad query', async () => {
    const { search } = backend({ '"Lewis KE" "Icy Love" lyrics': [appleLyricResult] });
    const ev = await new WebLyricsResolver(search).resolve(ARTIST, TITLE);
    expect(ev.shownStores.has('Apple Music')).toBe(true);
    expect(ev.shownStores.has('Deezer')).toBe(false);
  });

  it('detects the LyricFind distribution signal', async () => {
    const lyricfind: SearchResult = {
      url: 'https://lyrics.lyricfind.com/lyrics/lewis-ke-icy-love',
      title: 'Lewis KE - Icy Love Lyrics | LyricFind',
      description: 'Icy Love lyrics by Lewis KE. Yeah yeah You cured me with your love.',
    };
    const { search } = backend({ '"Lewis KE" "Icy Love" lyrics': [appleLyricResult, lyricfind] });
    const ev = await new WebLyricsResolver(search).resolve(ARTIST, TITLE);
    expect(ev.lyricfindDistributed).toBe(true);
    expect(ev.lyricfindUrl).toBe(lyricfind.url);
  });

  it('finds a store only surfaced by a grouped site: follow-up', async () => {
    const deezer: SearchResult = {
      url: 'https://www.deezer.com/track/999',
      title: 'Icy Love - Lewis KE',
      description: 'Icy Love lyrics: Yeah yeah You cured me with your love. Composition & Lyrics Lewis KE',
    };
    const { search, calls } = backend({ 'site:deezer.com': [deezer] });
    const ev = await new WebLyricsResolver(search).resolve(ARTIST, TITLE);
    expect(ev.shownStores.has('Deezer')).toBe(true);
    // 1 broad + ceil(followUp / SITE_GROUP_SIZE) grouped queries; well under one-per-store.
    expect(calls.length).toBeLessThanOrEqual(1 + Math.ceil(LYRIC_PLATFORMS.length / 6));
  });

  it('reports nothing (never a false not-shown) when the search is empty', async () => {
    const { search } = backend({});
    const ev = await new WebLyricsResolver(search).resolve(ARTIST, TITLE);
    expect(ev.shownStores.size).toBe(0);
    expect(ev.lyricfindDistributed).toBe(false);
  });

  it('caches per song (no repeat queries)', async () => {
    const { search, calls } = backend({ '"Lewis KE" "Icy Love" lyrics': [appleLyricResult] });
    const resolver = new WebLyricsResolver(search);
    await resolver.resolve(ARTIST, TITLE);
    const first = calls.length;
    await resolver.resolve(ARTIST, TITLE);
    expect(calls.length).toBe(first);
  });

  it('respects a custom lyric-capable platform list', async () => {
    const only: LyricCapablePlatform[] = [{ store: 'Apple Music', domains: ['music.apple.com'] }];
    const { search } = backend({ '"Lewis KE" "Icy Love" lyrics': [appleLyricResult] });
    const ev = await new WebLyricsResolver(search, only).resolve(ARTIST, TITLE);
    expect([...ev.shownStores]).toEqual(['Apple Music']);
  });
});
