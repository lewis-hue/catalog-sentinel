import { describe, it, expect } from 'vitest';
import { SpotifyStoreProvider } from './spotify';
import type { FetchLike } from './types';

const TRACK = {
  name: 'Icy Love',
  artists: [{ id: 'a1', name: 'Lewis KE', external_urls: { spotify: 'https://open.spotify.com/artist/a1' } }],
  album: { name: 'Icy Love', release_date: '2021', images: [{ url: 'big' }, { url: 'med' }] },
  external_ids: { isrc: 'QZK6K2090500' },
  external_urls: { spotify: 'https://open.spotify.com/track/636QXSQDPJjBi8PrvG77IO' },
};

function fakeHttp(): FetchLike {
  return async (url: string, init) => {
    let body: unknown = {};
    if (url.includes('accounts.spotify.com/api/token')) {
      expect(init?.method).toBe('POST');
      body = { access_token: 'tok', expires_in: 3600 };
    } else if (/\/v1\/search/.test(url)) {
      expect(init?.headers?.Authorization).toBe('Bearer tok');
      body = { tracks: { items: [TRACK], total: 1, next: null } };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

describe('SpotifyStoreProvider (real API shape, faked transport)', () => {
  const opts = { clientId: 'id', clientSecret: 'secret', fetchImpl: fakeHttp(), nowMs: () => 1_000_000 };

  it('is unconfigured (needsCredential) without client id/secret', () => {
    expect(new SpotifyStoreProvider({}).needsCredential).toBe(true);
    expect(new SpotifyStoreProvider(opts).needsCredential).toBe(false);
  });

  it('lists the artist catalogue with ISRC + open.spotify.com URLs', async () => {
    const cat = await new SpotifyStoreProvider(opts).listArtistCatalog('Lewis KE');
    expect(cat.artist?.name).toBe('Lewis KE');
    expect(cat.tracks[0]).toMatchObject({ title: 'Icy Love', isrc: 'QZK6K2090500', url: 'https://open.spotify.com/track/636QXSQDPJjBi8PrvG77IO' });
    expect(cat.pagination).toEqual({ total: 1, fetched: 1, complete: false });
    expect(cat.warnings.join(' ')).toMatch(/non-exhaustive/i);
  });

  it('looks up by ISRC (exact) and by artist+title search, returning the track link', async () => {
    const p = new SpotifyStoreProvider(opts);
    expect((await p.lookupIsrc('QZK6K2090500'))).toMatchObject({ found: true, artist: 'Lewis KE', url: 'https://open.spotify.com/track/636QXSQDPJjBi8PrvG77IO' });
    expect((await p.searchTitle('Lewis KE', 'Icy Love'))).toMatchObject({ found: true, url: 'https://open.spotify.com/track/636QXSQDPJjBi8PrvG77IO' });
  });

  it('refreshes the client-credentials token once after an API 401', async () => {
    let tokenRequests = 0;
    let apiRequests = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/api/token')) {
        tokenRequests++;
        return { ok: true, status: 200, json: async () => ({ access_token: `tok-${tokenRequests}` }), text: async () => '' };
      }
      apiRequests++;
      return apiRequests === 1
        ? { ok: false, status: 401, json: async () => ({}), text: async () => '' }
        : { ok: true, status: 200, json: async () => ({ tracks: { items: [TRACK], total: 1, next: null } }), text: async () => '' };
    };
    const catalog = await new SpotifyStoreProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl })
      .listArtistCatalog('Lewis KE');
    expect(tokenRequests).toBe(2);
    expect(apiRequests).toBe(2);
    expect(catalog.tracks).toHaveLength(1);
  });

  it('returns empty results (never throws) when unconfigured', async () => {
    const p = new SpotifyStoreProvider({});
    expect((await p.listArtistCatalog('X')).tracks).toEqual([]);
    expect((await p.listArtistCatalog('X')).pagination.complete).toBe(false);
    expect((await p.lookupIsrc('QZK6K2090500')).found).toBe(false);
    expect((await p.searchTitle('X', 'Y')).found).toBe(false);
  });

  it('exposes first-page search results as incomplete when Spotify has a next page', async () => {
    const fetchImpl: FetchLike = async (url) => ({
      ok: true,
      status: 200,
      json: async () => url.includes('/api/token')
        ? { access_token: 'tok', expires_in: 3600 }
        : { tracks: { items: [TRACK], total: 2, next: 'https://api.spotify.com/v1/search?offset=1' } },
      text: async () => '',
    });
    const cat = await new SpotifyStoreProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl }).listArtistCatalog('Lewis KE');
    expect(cat.pagination).toEqual({ total: 2, fetched: 1, complete: false });
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('paginates with Spotify’s current 10-track search limit without truncating results', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      ...TRACK,
      name: `Track ${index}`,
      external_ids: { isrc: `USAAA${String(index).padStart(7, '0')}` },
      external_urls: { spotify: `https://open.spotify.com/track/${index}` },
    }));
    let pageRequests = 0;
    const fetchImpl: FetchLike = async (url) => {
      if (url.includes('/api/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' };
      }
      pageRequests++;
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get('offset') ?? 0);
      const limit = Number(parsed.searchParams.get('limit') ?? 10);
      expect(limit).toBeLessThanOrEqual(10);
      const items = rows.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({ tracks: { items, total: rows.length, next: nextOffset < rows.length ? `https://api.spotify.com/v1/search?offset=${nextOffset}` : null } }),
        text: async () => '',
      };
    };
    const cat = await new SpotifyStoreProvider({ clientId: 'id', clientSecret: 'secret', fetchImpl }).listArtistCatalog('Lewis KE', { limit: 1_000 });
    expect(pageRequests).toBe(12);
    expect(cat.tracks).toHaveLength(120);
    expect(cat.pagination).toEqual({ total: 120, fetched: 120, complete: false });
    expect(cat.warnings.join(' ')).toMatch(/exact per-track verification/i);
  });
});
