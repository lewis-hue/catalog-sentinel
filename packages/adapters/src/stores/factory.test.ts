import { describe, it, expect } from 'vitest';
import { createStoreScanTargets } from './factory';

const names = (env: NodeJS.ProcessEnv) => createStoreScanTargets(env).map((s) => s.catalog.store);

describe('createStoreScanTargets', () => {
  it('is Deezer + Apple only with no keys', () => {
    expect(names({} as NodeJS.ProcessEnv)).toEqual(['Deezer', 'Apple Music / iTunes']);
  });

  it('a single Brave key adds Spotify, YouTube, and the no-API stores (web search)', () => {
    const n = names({ BRAVE_SEARCH_API_KEY: 'k' } as NodeJS.ProcessEnv);
    expect(n).toContain('Spotify');
    expect(n).toContain('YouTube Music');
    expect(n).toContain('Amazon Music');
    expect(n).toContain('TIDAL');
    // No duplicates.
    expect(new Set(n).size).toBe(n.length);
  });

  it('official Spotify/YouTube keys take precedence (no double entry)', () => {
    const n = names({ BRAVE_SEARCH_API_KEY: 'k', SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b', YOUTUBE_API_KEY: 'y' } as NodeJS.ProcessEnv);
    expect(n.filter((x) => x === 'Spotify')).toHaveLength(1);
    expect(n.filter((x) => x === 'YouTube Music')).toHaveLength(1);
  });

  it('adds Audiomack / SoundCloud / TIDAL as API stores when their keys are set (no web-search dupes)', () => {
    const n = names({
      BRAVE_SEARCH_API_KEY: 'k',
      AUDIOMACK_CONSUMER_KEY: 'a', AUDIOMACK_CONSUMER_SECRET: 'b',
      SOUNDCLOUD_CLIENT_ID: 'c', SOUNDCLOUD_CLIENT_SECRET: 'd',
      TIDAL_CLIENT_ID: 'e', TIDAL_CLIENT_SECRET: 'f',
    } as NodeJS.ProcessEnv);
    expect(n).toContain('Audiomack');
    expect(n).toContain('SoundCloud');
    expect(n).toContain('TIDAL');
    expect(n.filter((x) => x === 'Audiomack')).toHaveLength(1); // official API beats Brave
    expect(n.filter((x) => x === 'TIDAL')).toHaveLength(1);
  });

  it('fast path (includeWebSearch:false) returns catalogue-list stores only — no Brave-only, no confirmOnly', () => {
    const n = createStoreScanTargets(
      { BRAVE_SEARCH_API_KEY: 'k', AUDIOMACK_CONSUMER_KEY: 'a', AUDIOMACK_CONSUMER_SECRET: 'b', YOUTUBE_API_KEY: 'y' } as NodeJS.ProcessEnv,
      { includeWebSearch: false },
    ).map((s) => s.catalog.store);
    expect(n).toContain('Deezer');
    expect(n).toContain('Audiomack'); // catalogue-list API store → included
    expect(n).not.toContain('YouTube Music'); // confirmOnly (per-song) → excluded from the fast path
    expect(n).not.toContain('Amazon Music'); // Brave-only → excluded
    expect(n).not.toContain('Pandora');
  });
});
