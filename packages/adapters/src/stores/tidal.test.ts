import { describe, it, expect } from 'vitest';
import { TidalStoreProvider } from './tidal';
import type { FetchLike } from './types';

const fakeFetch: FetchLike = async (url) => {
  if (url.includes('/oauth2/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' };
  }
  if (url.includes('/searchResults/')) {
    return {
      ok: true, status: 200,
      json: async () => ({ data: {}, included: [{ id: '777', type: 'artists', attributes: { name: 'Lewis KE' } }] }),
      text: async () => '',
    };
  }
  if (url.includes('/artists/777/relationships/tracks')) {
    return {
      ok: true, status: 200,
      json: async () => ({
        data: [{ id: '1', type: 'tracks' }, { id: '2', type: 'tracks' }],
        included: [
          { id: '1', type: 'tracks', attributes: { title: 'Icy Love', isrc: 'QZK6K2090500', releaseDate: '2023-01-01' } },
          { id: '2', type: 'tracks', attributes: { title: 'Skit', isrc: 'QZDA62110327' } },
        ],
        links: { next: null },
      }),
      text: async () => '',
    };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

describe('TidalStoreProvider', () => {
  it('flags missing credentials', async () => {
    const p = new TidalStoreProvider({}, fakeFetch, 0);
    expect(p.needsCredential).toBe(true);
    expect((await p.listArtistCatalog('Lewis KE')).warnings[0]).toMatch(/not configured/i);
  });

  it('resolves artist and lists tracks with ISRC from JSON:API included resources', async () => {
    const p = new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.tracks.map((t) => t.title)).toEqual(['Icy Love', 'Skit']);
    expect(cat.tracks[0]?.isrc).toBe('QZK6K2090500');
    expect(cat.tracks[0]?.url).toBe('https://tidal.com/browse/track/1');
    expect(cat.pagination).toEqual({ total: null, fetched: 2, complete: true });
  });

  it('marks a catalog capped before the end of a page as incomplete', async () => {
    const p = new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE', { limit: 1 });
    expect(cat.tracks).toHaveLength(1);
    expect(cat.pagination.complete).toBe(false);
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('extracts artist id from a profile URL', () => {
    expect(TidalStoreProvider.artistIdFromProfileUrl('https://tidal.com/artist/12345')).toBe('12345');
    expect(TidalStoreProvider.artistIdFromProfileUrl('https://tidal.com/browse/artist/999')).toBe('999');
  });
});
