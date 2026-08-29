import { describe, it, expect } from 'vitest';
import { WebSearchStore, WebPresenceResolver, WEB_PLATFORMS, type SearchResult, type SearchBackend } from './web-search';

const AMAZON = { store: 'Amazon Music', domains: ['music.amazon.com'], trackPathRe: /music\.amazon\.com\/.*(tracks?|albums)\//i };

/** A search backend returning fixed results. */
const backend = (results: SearchResult[]): SearchBackend => async () => results;

describe('WebSearchStore, verified search confirmation', () => {
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
        { url: 'https://example.com/icy-love', title: 'Icy Love, Lewis KE', description: '' },
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

  it('resolves ALL platforms in a FEW grouped requests (1 broad + grouped site: OR), cached', async () => {
    const queries: string[] = [];
    const search: SearchBackend = async (q) => {
      queries.push(q);
      if (q.includes('site:')) {
        // A grouped `site:a OR site:b OR …` query surfaces any of its domains in one request.
        return q.includes('audiomack.com')
          ? [{ url: 'https://audiomack.com/lewis-ke/song/icy-love', title: 'Icy Love by Lewis KE', description: '' }]
          : [];
      }
      return [
        { url: 'https://open.spotify.com/track/abc', title: 'Icy Love', description: 'Icy Love · Lewis KE' },
        { url: 'https://music.youtube.com/watch?v=x', title: 'Lewis KE - Icy Love', description: '' },
      ];
    };
    const resolver = new WebPresenceResolver(search, WEB_PLATFORMS);
    const hits = await resolver.resolve('Lewis KE', 'Icy Love');
    // ~18 site-searchable platforms → ceil(18/10)=2 grouped queries + 1 broad = 3, NOT 1 + 18 = 19.
    expect(queries.length).toBeLessThanOrEqual(4);
    expect(queries.filter((q) => q.includes('site:')).length).toBeGreaterThan(0);
    expect(queries.some((q) => /site:\S+ OR site:/.test(q))).toBe(true); // grouped OR form, not one-per-store
    expect(hits.get('Spotify')).toBe('https://open.spotify.com/track/abc'); // from the broad query
    expect(hits.get('YouTube Music')).toBe('https://music.youtube.com/watch?v=x');
    expect(hits.get('Audiomack')).toBe('https://audiomack.com/lewis-ke/song/icy-love'); // from a grouped query
    // Re-resolving the same song is cached (no new queries).
    const before = queries.length;
    await resolver.resolve('Lewis KE', 'Icy Love');
    expect(queries.length).toBe(before);
  });
});
