import { describe, it, expect } from 'vitest';
import { AudiomackStoreProvider } from './audiomack';
import type { FetchLike } from './types';

// Mirrors the documented Audiomack API: uploads under { results }, `released` is a Unix
// timestamp, reposts carry a `repost` attribute, albums are expanded via a detail fetch.
const uploads = {
  results: [
    { type: 'song', title: 'Icy Love', artist: 'Lewis KE', url_slug: 'icy-love', released: '1672531200', image: 'https://img/icy.jpg', uploader: { name: 'Lewis KE', url_slug: 'lewis_ke' } },
    { type: 'album', title: 'The Album', artist: 'Lewis KE', url_slug: 'the-album', uploader: { url_slug: 'lewis_ke' } },
    // A repost by this profile, must be excluded.
    { type: 'song', title: 'Someone Elses Song', artist: 'Other Artist', repost: 'Lewis KE', uploader: { url_slug: 'lewis_ke' } },
  ],
  count: 3,
};
const albumDetail = {
  results: { type: 'album', title: 'The Album', url_slug: 'the-album', tracks: [
    { type: 'song', title: 'Track One', artist: 'Lewis KE', url_slug: 't1', uploader: { url_slug: 'lewis_ke' } },
    { type: 'song', title: 'Track Two', artist: 'Lewis KE', url_slug: 't2', uploader: { url_slug: 'lewis_ke' } },
  ] },
};

const fakeFetch: FetchLike = async (url, init) => {
  const authed = Boolean(init?.headers?.Authorization?.startsWith('OAuth '));
  if (!authed) return { ok: false, status: 401, json: async () => ({ errorcode: 1003 }), text: async () => '' };
  const body = url.includes('/music/album/') ? albumDetail : url.includes('/artist/lewis_ke/uploads') ? uploads : { results: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

describe('AudiomackStoreProvider', () => {
  it('needs credentials when none configured', async () => {
    const p = new AudiomackStoreProvider({}, fakeFetch, 0);
    expect(p.needsCredential).toBe(true);
    const cat = await p.listArtistCatalog('Lewis KE');
    expect(cat.tracks).toHaveLength(0);
    expect(cat.warnings[0]).toMatch(/not configured/i);
  });

  it('lists uploads (signed with limit=0), expands albums, and excludes reposts', async () => {
    const p = new AudiomackStoreProvider({ consumerKey: 'ck', consumerSecret: 'cs', slug: 'lewis_ke' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE');
    const titles = cat.tracks.map((t) => t.title).sort();
    expect(titles).toEqual(['Icy Love', 'Track One', 'Track Two']);
    const icy = cat.tracks.find((t) => t.title === 'Icy Love');
    expect(icy?.releaseDate).toBe('2023-01-01'); // Unix 1672531200 → date
    expect(icy?.url).toBe('https://audiomack.com/lewis_ke/song/icy-love');
    expect(cat.artist?.url).toBe('https://audiomack.com/lewis_ke');
    expect(cat.pagination).toEqual({ total: 3, fetched: 3, complete: true });
  });

  it('marks a catalog capped before all uploads are expanded as incomplete', async () => {
    const p = new AudiomackStoreProvider({ consumerKey: 'ck', consumerSecret: 'cs', slug: 'lewis_ke' }, fakeFetch, 0);
    const cat = await p.listArtistCatalog('Lewis KE', { limit: 1 });
    expect(cat.tracks).toHaveLength(1);
    expect(cat.pagination.complete).toBe(false);
    expect(cat.warnings.join(' ')).toMatch(/incomplete/i);
  });

  it('extracts a slug from a profile URL', () => {
    expect(AudiomackStoreProvider.slugFromProfileUrl('https://audiomack.com/lewis_ke')).toBe('lewis_ke');
    expect(AudiomackStoreProvider.slugFromProfileUrl('audiomack.com/lewis_ke/song/icy-love')).toBe('lewis_ke');
  });
});
