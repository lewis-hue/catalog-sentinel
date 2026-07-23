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
  if (/\/artists\/777\?/.test(url)) {
    return {
      ok: true, status: 200,
      json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
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
    const p = new TidalStoreProvider({ clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.tracks.map((t) => t.title)).toEqual(['Icy Love', 'Skit']);
    expect(cat.tracks[0]?.isrc).toBe('QZK6K2090500');
    expect(cat.tracks[0]?.url).toBe('https://tidal.com/browse/track/1');
    expect(cat.pagination).toEqual({ total: null, fetched: 2, complete: true });
  });

  it('uses required collapseBy with cursor pagination instead of an unsupported page size', async () => {
    const urls: string[] = [];
    const capturingFetch: FetchLike = async (url, init) => {
      urls.push(url);
      return fakeFetch(url, init);
    };
    const p = new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, capturingFetch, 0);
    await p.listArtistCatalog('Lewis KE');
    const catalogUrl = new URL(urls.find((url) => url.includes('/relationships/tracks'))!);
    expect(catalogUrl.searchParams.get('collapseBy')).toBe('NONE');
    expect(catalogUrl.searchParams.get('include')).toBe('tracks');
    expect(catalogUrl.searchParams.has('page[limit]')).toBe(false);
  });

  it('restores TIDAL v2 on root-relative cursor links and follows the next page', async () => {
    const urls: string[] = [];
    const cursorFetch: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (url.includes('/searchResults/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ included: [{ id: '777', type: 'artists', attributes: { name: 'Lewis KE' } }] }),
          text: async () => '',
        };
      }
      if (/\/artists\/777\?/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
          text: async () => '',
        };
      }
      const parsed = new URL(url);
      const cursor = parsed.searchParams.get('page[cursor]');
      return {
        ok: true,
        status: 200,
        json: async () => cursor
          ? {
              data: [{ id: '2', type: 'tracks' }],
              included: [{ id: '2', type: 'tracks', attributes: { title: 'Second', isrc: 'USAAA0000002' } }],
              links: { next: null },
            }
          : {
              data: [{ id: '1', type: 'tracks' }],
              included: [{ id: '1', type: 'tracks', attributes: { title: 'First', isrc: 'USAAA0000001' } }],
              links: { next: '/artists/777/relationships/tracks?collapseBy=NONE&countryCode=US&include=tracks&page%5Bcursor%5D=opaque' },
            },
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider({ clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' }, cursorFetch, 0)
      .listArtistCatalog('Lewis KE');
    expect(urls.some((url) => url.startsWith('https://openapi.tidal.com/v2/artists/777/relationships/tracks?')
      && url.includes('page%5Bcursor%5D=opaque'))).toBe(true);
    expect(catalog.tracks.map((track) => track.title)).toEqual(['First', 'Second']);
    expect(catalog.pagination).toEqual({ total: null, fetched: 2, complete: true });
  });

  it('fails closed when a relationship has no usable included track metadata', async () => {
    const incompleteFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (/\/artists\/777\?/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: '1', type: 'tracks' }, { id: '2', type: 'tracks' }],
          included: [{ id: '1', type: 'tracks', attributes: { title: 'Complete', isrc: 'USAAA0000001' } }],
          links: { next: null },
        }),
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider(
      { clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' },
      incompleteFetch,
      0,
    ).listArtistCatalog('Lewis KE');
    expect(catalog.tracks.map((track) => track.title)).toEqual(['Complete']);
    expect(catalog.pagination).toEqual({ total: null, fetched: 2, complete: false });
    expect(catalog.warnings.join(' ')).toMatch(/omitted usable track metadata for 1 catalog relationship/i);
  });

  it('fails closed when the relationship document omits its primary data array', async () => {
    const malformedFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (/\/artists\/777\?/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          included: [{ id: '1', type: 'tracks', attributes: { title: 'Unlinked', isrc: 'USAAA0000001' } }],
          links: { next: null },
        }),
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider(
      { clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' },
      malformedFetch,
      0,
    ).listArtistCatalog('Lewis KE');
    expect(catalog.tracks).toEqual([]);
    expect(catalog.pagination.complete).toBe(false);
    expect(catalog.warnings.join(' ')).toMatch(/omitted its relationship data array/i);
  });

  it('does not prove absence when artist identity was resolved by name only', async () => {
    const catalog = await new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, fakeFetch, 0)
      .listArtistCatalog('Lewis KE');
    expect(catalog.tracks).toHaveLength(2);
    expect(catalog.pagination.complete).toBe(false);
    expect(catalog.warnings.join(' ')).toMatch(/TIDAL_PROFILE_URL/i);
  });

  it('rejects pagination cursors that leave TIDAL openapi v2', async () => {
    const maliciousFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (url.includes('/searchResults/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ included: [{ id: '777', type: 'artists', attributes: { name: 'Lewis KE' } }] }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: '1', type: 'tracks' }],
          included: [{ id: '1', type: 'tracks', attributes: { title: 'First', isrc: 'USAAA0000001' } }],
          links: { next: 'https://example.com/steal-token' },
        }),
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, maliciousFetch, 0)
      .listArtistCatalog('Lewis KE');
    expect(catalog.pagination.complete).toBe(false);
    expect(catalog.warnings.join(' ')).toMatch(/invalid pagination cursor/i);
  });

  it('distinguishes an upstream API failure from a genuine no-exact-artist result', async () => {
    const failingFetch: FetchLike = async (url) => url.includes('/oauth2/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' }
      : { ok: false, status: 400, json: async () => ({}), text: async () => '' };
    const p = new TidalStoreProvider({ clientId: 'c', clientSecret: 's' }, failingFetch, 0);
    const catalog = await p.listArtistCatalog('Lewis KE');
    expect(catalog.warnings.join(' ')).toMatch(/API request failed \(HTTP 400\)/);
    expect(catalog.warnings.join(' ')).not.toMatch(/No exact TIDAL artist/);
  });

  it('retries a transient catalogue failure before returning data', async () => {
    let catalogRequests = 0;
    const transientFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (/\/artists\/777\?/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
          text: async () => '',
        };
      }
      catalogRequests++;
      if (catalogRequests === 1) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: '1', type: 'tracks' }],
          included: [{ id: '1', type: 'tracks', attributes: { title: 'Recovered', isrc: 'USAAA0000001' } }],
          links: { next: null },
        }),
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider({
      clientId: 'c',
      clientSecret: 's',
      profileUrl: 'https://tidal.com/artist/777',
      retry: { sleep: async () => undefined },
    }, transientFetch, 0).listArtistCatalog('Lewis KE');
    expect(catalogRequests).toBe(2);
    expect(catalog.tracks[0]?.title).toBe('Recovered');
    expect(catalog.pagination.complete).toBe(true);
  });

  it('refreshes the OAuth token once after an API 401', async () => {
    let tokenRequests = 0;
    let profileRequests = 0;
    const refreshFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        tokenRequests++;
        return { ok: true, status: 200, json: async () => ({ access_token: `tok-${tokenRequests}` }), text: async () => '' };
      }
      if (/\/artists\/777\?/.test(url)) {
        profileRequests++;
        return profileRequests === 1
          ? { ok: false, status: 401, json: async () => ({}), text: async () => '' }
          : {
              ok: true,
              status: 200,
              json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
              text: async () => '',
            };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: '1', type: 'tracks' }],
          included: [{ id: '1', type: 'tracks', attributes: { title: 'Authorized', isrc: 'USAAA0000001' } }],
          links: { next: null },
        }),
        text: async () => '',
      };
    };
    const catalog = await new TidalStoreProvider(
      { clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' },
      refreshFetch,
      0,
    ).listArtistCatalog('Lewis KE');
    expect(tokenRequests).toBe(2);
    expect(profileRequests).toBe(2);
    expect(catalog.pagination.complete).toBe(true);
  });

  it('binds one configured profile only to its verified artist name', async () => {
    const multiArtistFetch: FetchLike = async (url) => {
      if (url.includes('/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }), text: async () => '' };
      }
      if (/\/artists\/777\?/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { id: '777', type: 'artists', attributes: { name: 'Lewis KE' } } }),
          text: async () => '',
        };
      }
      if (url.includes('/searchResults/Other')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ included: [{ id: '888', type: 'artists', attributes: { name: 'Other' } }] }),
          text: async () => '',
        };
      }
      const artistId = url.includes('/artists/888/') ? '888' : '777';
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: artistId, type: 'tracks' }],
          included: [{ id: artistId, type: 'tracks', attributes: { title: `Track ${artistId}`, isrc: artistId === '777' ? 'USAAA0000001' : 'USAAA0000002' } }],
          links: { next: null },
        }),
        text: async () => '',
      };
    };
    const provider = new TidalStoreProvider(
      { clientId: 'c', clientSecret: 's', profileUrl: 'https://tidal.com/artist/777' },
      multiArtistFetch,
      0,
    );
    const anchored = await provider.listArtistCatalog('Lewis KE');
    const other = await provider.listArtistCatalog('Other');
    expect(anchored.pagination.complete).toBe(true);
    expect(other.artist?.id).toBe('888');
    expect(other.pagination.complete).toBe(false);
    expect(other.warnings.join(' ')).toMatch(/TIDAL_PROFILE_URL/i);
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
    expect(TidalStoreProvider.artistIdFromProfileUrl('http://tidal.com/artist/12345')).toBeNull();
    expect(TidalStoreProvider.artistIdFromProfileUrl('https://evil.example/?next=tidal.com/artist/12345')).toBeNull();
    expect(TidalStoreProvider.artistIdFromProfileUrl('https://tidal.com.evil.example/artist/12345')).toBeNull();
    expect(TidalStoreProvider.artistIdFromProfileUrl('https://tidal.com/artist/12345/tracks')).toBeNull();
  });
});
