import { describe, it, expect } from 'vitest';
import { SoundCloudStoreProvider } from './soundcloud';
import type { FetchLike } from './types';

const fakeFetch: FetchLike = async (url, init) => {
  if (url.includes('/oauth/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' };
  }
  if (url.includes('/resolve')) {
    return { ok: true, status: 200, json: async () => ({ id: 42, username: 'Lewis KE', permalink_url: 'https://soundcloud.com/lewis_ke' }), text: async () => '' };
  }
  if (url.includes('/users/42/tracks')) {
    return {
      ok: true, status: 200,
      json: async () => ({ collection: [
        { title: 'Icy Love', permalink_url: 'https://soundcloud.com/lewis_ke/icy-love', created_at: '2023-01-01T00:00:00Z', publisher_metadata: { isrc: 'QZK6K2090500', artist: 'Lewis KE' } },
        { title: 'Skit', permalink_url: 'https://soundcloud.com/lewis_ke/skit', display_date: '2022-05-02T00:00:00Z' },
      ], next_href: null }),
      text: async () => '',
    };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

describe('SoundCloudStoreProvider', () => {
  it('flags missing credentials', async () => {
    const p = new SoundCloudStoreProvider({}, fakeFetch, 0);
    expect(p.needsCredential).toBe(true);
    expect((await p.listArtistCatalog('Lewis KE')).warnings[0]).toMatch(/not configured/i);
  });

  it('resolves the profile and lists tracks with ISRC from publisher_metadata', async () => {
    const p = new SoundCloudStoreProvider({ clientId: 'c', clientSecret: 's', profileUrl: 'https://soundcloud.com/lewis_ke' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.tracks.map((t) => t.title)).toEqual(['Icy Love', 'Skit']);
    expect(cat.tracks[0]?.isrc).toBe('QZK6K2090500');
    expect(cat.tracks[0]?.releaseDate).toBe('2023-01-01');
    expect(cat.artist?.url).toBe('https://soundcloud.com/lewis_ke');
    expect(cat.pagination).toEqual({ total: null, fetched: 2, complete: true });
  });

  it('marks a catalog capped mid-page as incomplete', async () => {
    const p = new SoundCloudStoreProvider({ clientId: 'c', clientSecret: 's', profileUrl: 'https://soundcloud.com/lewis_ke' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE', { limit: 1 });
    expect(cat.tracks).toHaveLength(1);
    expect(cat.pagination.complete).toBe(false);
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });
});
