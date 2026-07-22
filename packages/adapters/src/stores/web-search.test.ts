import { describe, it, expect } from 'vitest';
import { WebSearchStore, WebPresenceResolver, WEB_PLATFORMS, createBraveSearch, type SearchResult, type SearchBackend } from './web-search';
import type { FetchLike } from './types';

const AMAZON = { store: 'Amazon Music', domains: ['music.amazon.com'], trackPathRe: /music\.amazon\.com\/.*(tracks?|albums)\//i };

/** A search backend returning fixed results. */
const backend = (results: SearchResult[]): SearchBackend => async () => results;

describe('WebSearchStore — verified search confirmation', () => {
  it('confirms only when a track page on the domain matches BOTH title and artist', async () => {
    const store = new WebSearchStore(AMAZON, {
      search: backend([{ url: 'https://music.amazon.com/albums/B0/tracks/B1', title: 'Icy Love', description: 'Icy Love by Lewis KE on Amazon Music' }]),
    });
    const res = await store.searchTitle('Lewis KE', 'Icy Love');
    expect(res.found).toBe(true);
    expect(res.url).toBe('https://music.amazon.com/albums/B0/tracks/B1');
  });

  it('rejects a track page credited to a DIFFERENT artist', async () => {
    const store = new WebSearchStore(AMAZON, {
      search: backend([{ url: 'https://music.amazon.com/albums/B0/tracks/B1', title: 'Icy Love', description: 'Icy Love by Someone Else' }]),
    });
    expect((await store.searchTitle('Lewis KE', 'Icy Love')).found).toBe(false);
  });

  it('rejects off-domain and non-track URLs', async () => {
    const store = new WebSearchStore(AMAZON, {
      search: backend([
        { url: 'https://example.com/icy-love', title: 'Icy Love — Lewis KE', description: '' },
        { url: 'https://music.amazon.com/artists/B9/lewis-ke', title: 'Icy Love Lewis KE', description: '' },
      ]),
    });
    expect((await store.searchTitle('Lewis KE', 'Icy Love')).found).toBe(false);
  });

  it('rejects when the title is absent from the result text', async () => {
    const store = new WebSearchStore(AMAZON, {
      search: backend([{ url: 'https://music.amazon.com/albums/B0/tracks/B1', title: 'Another Song', description: 'by Lewis KE' }]),
    });
    expect((await store.searchTitle('Lewis KE', 'Icy Love')).found).toBe(false);
  });

  it('resolves many platforms from ONE broad query + targeted follow-ups (cached)', async () => {
    let broad = 0;
    let followUps = 0;
    const search: SearchBackend = async (q) => {
      if (q.includes('site:')) {
        followUps++;
        return q.includes('audiomack.com')
          ? [{ url: 'https://audiomack.com/lewis-ke/song/icy-love', title: 'Icy Love by Lewis KE', description: '' }]
          : [];
      }
      broad++;
      return [
        { url: 'https://open.spotify.com/track/abc', title: 'Icy Love', description: 'Icy Love · Lewis KE' },
        { url: 'https://music.youtube.com/watch?v=x', title: 'Lewis KE - Icy Love', description: '' },
      ];
    };
    const resolver = new WebPresenceResolver(search, WEB_PLATFORMS);
    const hits = await resolver.resolve('Lewis KE', 'Icy Love');
    expect(broad).toBe(1); // ONE broad query for all platforms
    expect(hits.get('Spotify')).toBe('https://open.spotify.com/track/abc');
    expect(hits.get('YouTube Music')).toBe('https://music.youtube.com/watch?v=x');
    expect(hits.get('Audiomack')).toBe('https://audiomack.com/lewis-ke/song/icy-love'); // via follow-up
    expect(followUps).toBeGreaterThan(0);
    // Re-resolving the same song is cached (no extra queries).
    await resolver.resolve('Lewis KE', 'Icy Love');
    expect(broad).toBe(1);
  });

  it('Brave backend sends the subscription key and parses results', async () => {
    let sawKey = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      sawKey = init?.headers?.['X-Subscription-Token'] ?? '';
      return { ok: true, status: 200, json: async () => ({ web: { results: [{ url: 'https://music.amazon.com/albums/B0/tracks/B1', title: 'Icy Love', description: 'Lewis KE' }] } }), text: async () => '' };
    };
    const search = createBraveSearch('secret-key', fetchImpl);
    const store = new WebSearchStore(AMAZON, { search });
    expect((await store.searchTitle('Lewis KE', 'Icy Love')).found).toBe(true);
    expect(sawKey).toBe('secret-key');
  });
});
