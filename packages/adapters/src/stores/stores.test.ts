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
  // Catalog now walks /artist/{id}/albums -> /album/{id}/tracks (the ISRC-bearing source);
  // the old /search?q=artist:"…" text query returned junk/nothing for many artists.
  const fetchImpl = fakeFetch([
    [/\/search\/artist/, { data: [
      { id: 73410062, name: 'Lewis KE', nb_fan: 900, link: 'https://www.deezer.com/artist/73410062' },
      { id: 111, name: 'Lewis KE', nb_fan: 12 }, // same name, fewer fans — must NOT be chosen
    ] }],
    [/\/artist\/73410062\/albums/, { next: null, data: [
      { id: 10, title: 'Icy Love', release_date: '2021-01-01' },
      { id: 20, title: 'JUST A BEAUTIFUL MESS' },
    ] }],
    [/\/album\/10\/tracks/, { data: [
      { id: 1, title: 'Icy Love', isrc: 'QZK6K2090500', link: 'https://www.deezer.com/track/1', artist: { id: 73410062, name: 'Lewis KE' } },
      { id: 3, title: 'Someone Else Song', isrc: 'US1234500001', artist: { id: 999, name: 'Other' } }, // filtered out (foreign artist)
    ] }],
    [/\/album\/20\/tracks/, { data: [
      { id: 2, title: 'Numb', isrc: 'QZDA62110336', artist: { id: 73410062, name: 'Lewis KE' } },
      { id: 4, title: 'Icy Love', isrc: 'QZK6K2090500', artist: { id: 73410062, name: 'Lewis KE' } }, // dedup by isrc
    ] }],
    [/\/track\/isrc:QZK6K2090500/, { id: 1, link: 'https://www.deezer.com/track/1' }],
    [/\/track\/isrc:/, { error: { type: 'DataException' } }],
  ]);

  it('resolves the most-followed namesake and lists the catalog from albums, filtering foreign artists and deduping', async () => {
    const p = new DeezerStoreProvider(fetchImpl, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.artist?.id).toBe('73410062'); // 900 fans beats the 12-fan namesake
    expect(cat.tracks.map((t) => t.title).sort()).toEqual(['Icy Love', 'Numb']);
    expect(cat.tracks.find((t) => t.title === 'Icy Love')?.isrc).toBe('QZK6K2090500');
    expect(cat.pagination).toEqual({ total: 2, fetched: 2, complete: true });
  });

  it('does exact ISRC lookups that return the crediting artist', async () => {
    const p = new DeezerStoreProvider(fetchImpl, 0);
    expect((await p.lookupIsrc('QZK6K2090500')).found).toBe(true);
    expect((await p.lookupIsrc('QZZZZ0000000')).found).toBe(false);
  });

  it('marks the catalog incomplete when the track limit truncates it', async () => {
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE', { limit: 1 });
    expect(cat.tracks).toHaveLength(1);
    expect(cat.pagination.complete).toBe(false);
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('does not fall back to a similarly named artist profile', async () => {
    const fetchImpl = fakeFetch([[/\/search\/artist/, { data: [{ id: 2, name: 'Lewis K' }] }]]);
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE');
    expect(cat.artist).toBeNull();
    expect(cat.pagination.complete).toBe(false);
  });

  it('walks every album and returns the full catalog', async () => {
    const albums = Array.from({ length: 30 }, (_, i) => ({ id: 1000 + i, title: `Album ${i}` }));
    const trackRequests = new Set<string>();
    const fetchImpl: FetchLike = async (url: string) => {
      let body: unknown = {};
      if (url.includes('/search/artist')) body = { data: [{ id: 1, name: 'Lewis KE', nb_fan: 10 }] };
      else if (url.includes('/artist/1/albums')) body = { next: null, data: albums };
      else {
        const id = url.match(/\/album\/(\d+)\/tracks/)?.[1];
        if (id) {
          trackRequests.add(id);
          const base = Number(id) * 100;
          body = { data: Array.from({ length: 12 }, (_, k) => ({ id: base + k, title: `T${base + k}`, artist: { id: 1, name: 'Lewis KE' } })) };
        }
      }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
    const cat = await new DeezerStoreProvider(fetchImpl, 0).listArtistCatalog('Lewis KE', { limit: 1_000 });
    expect(trackRequests.size).toBe(30);
    expect(cat.tracks).toHaveLength(360);
    expect(cat.pagination).toEqual({ total: 360, fetched: 360, complete: true });
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
