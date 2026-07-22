import { describe, it, expect } from 'vitest';
import { DeezerStoreProvider } from './deezer';
import { ItunesStoreProvider } from './itunes';
import { coverageSummary, STORE_COVERAGE } from './registry';
import { normalizeIsrc, normalizeTitle, type FetchLike } from './types';

/** Build a FetchLike that returns canned JSON per URL substring. */
function fakeFetch(routes: Array<[RegExp, unknown]>): FetchLike {
  return async (url: string) => {
    const hit = routes.find(([re]) => re.test(url));
    const body = hit ? hit[1] : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe('normalize helpers', () => {
  it('normalizes ISRCs and rejects invalid ones', () => {
    expect(normalizeIsrc('qz-k6k-20-90500')).toBe('QZK6K2090500');
    expect(normalizeIsrc('not-an-isrc')).toBeNull();
  });
  it('strips feat/remix/paren noise from titles', () => {
    expect(normalizeTitle('Sky Is Blue (Remix)')).toBe('sky is blue');
    expect(normalizeTitle('Love feat. Someone')).toBe('love');
  });
});

describe('DeezerStoreProvider (real API shape, faked transport)', () => {
  const fetchImpl = fakeFetch([
    [/\/search\/artist/, { data: [{ id: 73410062, name: 'Lewis KE', link: 'https://www.deezer.com/artist/73410062' }] }],
    [/\/search\?q=/, { total: 4, next: null, data: [
      { id: 1, title: 'Icy Love', isrc: 'QZK6K2090500', link: 'https://www.deezer.com/track/1', artist: { id: 73410062, name: 'Lewis KE' }, album: { title: 'Icy Love' } },
      { id: 2, title: 'Numb', isrc: 'QZDA62110336', link: 'https://www.deezer.com/track/2', artist: { id: 73410062, name: 'Lewis KE' }, album: { title: 'JUST A BEAUTIFUL MESS' } },
      { id: 3, title: 'Someone Else Song', isrc: 'US1234500001', artist: { id: 999, name: 'Other' } }, // filtered out (different artist)
      { id: 4, title: 'Icy Love', isrc: 'QZK6K2090500', artist: { id: 73410062, name: 'Lewis KE' } }, // dedup by isrc
    ] }],
    [/\/track\/isrc:QZK6K2090500/, { id: 1, link: 'https://www.deezer.com/track/1' }],
    [/\/track\/isrc:/, { error: { type: 'DataException' } }],
  ]);

  it('lists the artist catalog with ISRCs, filtering foreign artists and deduping', async () => {
    const p = new DeezerStoreProvider(fetchImpl, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.artist?.id).toBe('73410062');
    expect(cat.tracks.map((t) => t.title).sort()).toEqual(['Icy Love', 'Numb']);
    expect(cat.tracks.find((t) => t.title === 'Icy Love')?.isrc).toBe('QZK6K2090500');
    expect(cat.pagination).toEqual({ total: 4, fetched: 4, complete: true });
  });

  it('does exact ISRC lookups that return the crediting artist', async () => {
    const p = new DeezerStoreProvider(fetchImpl, 0);
    expect((await p.lookupIsrc('QZK6K2090500')).found).toBe(true);
    expect((await p.lookupIsrc('QZZZZ0000000')).found).toBe(false);
  });

  it('exposes an unconsumed next page as an incomplete catalog', async () => {
    const fetchImpl = fakeFetch([
      [/\/search\/artist/, { data: [{ id: 1, name: 'Lewis KE' }] }],
      [/\/search\?q=/, { total: 2, next: 'https://api.deezer.com/search?index=1', data: [
        { id: 1, title: 'First', artist: { id: 1, name: 'Lewis KE' } },
      ] }],
    ]);
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE', { limit: 1 });
    expect(cat.pagination).toEqual({ total: 2, fetched: 1, complete: false });
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('does not fall back to a similarly named artist profile', async () => {
    const fetchImpl = fakeFetch([[/\/search\/artist/, { data: [{ id: 2, name: 'Lewis K' }] }]]);
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE');
    expect(cat.artist).toBeNull();
    expect(cat.pagination.complete).toBe(false);
  });

  it('follows every page and returns more than the removed 300-track legacy cap', async () => {
    const rows = Array.from({ length: 350 }, (_, index) => ({
      id: index + 1,
      title: `Track ${index}`,
      artist: { id: 1, name: 'Lewis KE' },
      album: { title: `Album ${Math.floor(index / 10)}` },
    }));
    let catalogRequests = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/search/artist')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 1, name: 'Lewis KE' }] }), text: async () => '' };
      }
      catalogRequests++;
      const parsed = new URL(url);
      const index = Number(parsed.searchParams.get('index') ?? 0);
      const page = rows.slice(index, index + 100);
      const nextIndex = index + page.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: rows.length,
          data: page,
          next: nextIndex < rows.length ? `https://api.deezer.com/search?q=x&limit=100&index=${nextIndex}` : null,
        }),
        text: async () => '',
      };
    };
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE', { limit: 1_000 });
    expect(catalogRequests).toBe(4);
    expect(cat.tracks).toHaveLength(350);
    expect(cat.pagination).toEqual({ total: 350, fetched: 350, complete: true });
    expect(cat.warnings).toEqual([]);
  });
});

describe('ItunesStoreProvider (real API shape, faked transport)', () => {
  const fetchImpl = fakeFetch([
    [/entity=musicArtist/, { results: [{ wrapperType: 'artist', artistType: 'Artist', artistId: 1478671689, artistName: 'Lewis KE', artistLinkUrl: 'https://music.apple.com/us/artist/lewis-ke/1478671689' }] }],
    [/\/lookup\?id=1478671689/, { resultCount: 3, results: [
      { wrapperType: 'artist', artistId: 1478671689, artistName: 'Lewis KE' },
      { wrapperType: 'track', kind: 'song', trackName: 'Butterfly', collectionName: 'Purpose', artistName: 'Lewis KE', trackViewUrl: 'https://music.apple.com/x' },
      { wrapperType: 'track', kind: 'song', trackName: 'Numb', collectionName: 'JUST A BEAUTIFUL MESS', artistName: 'Lewis KE' },
    ] }],
  ]);

  it('resolves the artist and lists songs (no ISRC on iTunes)', async () => {
    const p = new ItunesStoreProvider(fetchImpl);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.artist?.id).toBe('1478671689');
    expect(cat.tracks.map((t) => t.title).sort()).toEqual(['Butterfly', 'Numb']);
    expect(cat.tracks.every((t) => t.isrc === null)).toBe(true);
    expect(cat.pagination.complete).toBe(true);
  });

  it('treats reaching the API result cap as incomplete', async () => {
    const fetchImpl = fakeFetch([
      [/entity=musicArtist/, { resultCount: 1, results: [{ wrapperType: 'artist', artistType: 'Artist', artistId: 7, artistName: 'Lewis KE' }] }],
      [/\/lookup\?id=7/, { resultCount: 2, results: [
        { wrapperType: 'track', kind: 'song', artistName: 'Lewis KE', trackName: 'One' },
        { wrapperType: 'track', kind: 'song', artistName: 'Lewis KE', trackName: 'Two' },
      ] }],
    ]);
    const cat = await new ItunesStoreProvider(fetchImpl).listArtistCatalog('Lewis KE', { limit: 2 });
    expect(cat.pagination.complete).toBe(false);
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });
});

describe('store coverage registry', () => {
  it('is honest: every entry has a real method and no fabricated verification', () => {
    for (const s of STORE_COVERAGE) expect(['api', 'distributor-reported', 'unverifiable']).toContain(s.method);
    const sum = coverageSummary();
    expect(sum.apiNoKey).toBeGreaterThanOrEqual(2); // Deezer + Apple/iTunes work with no key
    expect(sum.total).toBe(STORE_COVERAGE.length);
  });
});
