import { describe, it, expect } from 'vitest';
import { YouTubeMusicProvider } from './youtube';
import type { FetchLike } from './types';

function fakeFetch(items: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }>): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => ({ items }), text: async () => '' });
}

describe('YouTubeMusicProvider (Data API shape, faked transport)', () => {
  it('needs a key', () => {
    expect(new YouTubeMusicProvider({}).needsCredential).toBe(true);
    expect(new YouTubeMusicProvider({ apiKey: 'k' }).needsCredential).toBe(false);
  });

  it('confirms via an art-track "Artist - Topic" channel and returns the watch URL', async () => {
    const p = new YouTubeMusicProvider({ apiKey: 'k', fetchImpl: fakeFetch([{ id: { videoId: 'abc123' }, snippet: { title: 'Icy Love', channelTitle: 'Lewis KE - Topic' } }]) });
    const r = await p.searchTitle('Lewis KE', 'Icy Love');
    expect(r.found).toBe(true);
    expect(r.url).toBe('https://music.youtube.com/watch?v=abc123');
  });

  it('confirms when the artist is in the video title', async () => {
    const p = new YouTubeMusicProvider({ apiKey: 'k', fetchImpl: fakeFetch([{ id: { videoId: 'v2' }, snippet: { title: 'Lewis KE - Icy Love (Official Audio)', channelTitle: 'SomeVEVO' } }]) });
    expect((await p.searchTitle('Lewis KE', 'Icy Love')).found).toBe(true);
  });

  it('rejects a same-title song by a different artist', async () => {
    const p = new YouTubeMusicProvider({ apiKey: 'k', fetchImpl: fakeFetch([{ id: { videoId: 'v3' }, snippet: { title: 'Icy Love', channelTitle: 'Other Artist - Topic' } }]) });
    expect((await p.searchTitle('Lewis KE', 'Icy Love')).found).toBe(false);
  });

  it('returns not found without a key (never throws)', async () => {
    expect((await new YouTubeMusicProvider({}).searchTitle('a', 'b')).found).toBe(false);
  });
});
