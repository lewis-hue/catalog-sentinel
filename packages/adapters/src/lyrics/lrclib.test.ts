import { describe, it, expect } from 'vitest';
import { createLrclibResolver } from './lrclib';
import type { FetchLike } from '../stores/types';

const ok = (body: unknown) => ({
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('createLrclibResolver', () => {
  it('reports found with plain + synced availability', async () => {
    const fetchImpl: FetchLike = async () => ok([{ plainLyrics: 'la la', syncedLyrics: '[00:01.00]la', instrumental: false }]);
    const out = await createLrclibResolver({}, { fetchImpl }).lookup({ artist: 'Lewis KE', title: 'Heartless' });
    expect(out).toMatchObject({ status: 'found', plain: true, synced: true, instrumental: false, source: 'lrclib' });
  });

  it('reports plain-only when no synced lyrics exist', async () => {
    const fetchImpl: FetchLike = async () => ok([{ plainLyrics: 'words', syncedLyrics: null }]);
    const out = await createLrclibResolver({}, { fetchImpl }).lookup({ artist: 'A', title: 'B' });
    expect(out).toMatchObject({ status: 'found', plain: true, synced: false });
  });

  it('reports not-found on an empty result set', async () => {
    const fetchImpl: FetchLike = async () => ok([]);
    const out = await createLrclibResolver({}, { fetchImpl }).lookup({ artist: 'A', title: 'Nope' });
    expect(out.status).toBe('not-found');
  });

  it('reports unverifiable on transport failure (never a false "no lyrics")', async () => {
    const fetchImpl: FetchLike = async () => { throw new Error('network down'); };
    const out = await createLrclibResolver({}, { fetchImpl, timeoutMs: 50 }).lookup({ artist: 'A', title: 'B' });
    expect(out).toMatchObject({ status: 'unverifiable', plain: false, synced: false });
  });

  it('strips bracketed variant tags from the query so a variant matches its base recording', async () => {
    let calledUrl = '';
    const fetchImpl: FetchLike = async (url) => { calledUrl = url; return ok([{ plainLyrics: 'x' }]); };
    await createLrclibResolver({}, { fetchImpl }).lookup({ artist: 'Lewis KE', title: 'Now (Sped Up)' });
    expect(calledUrl).toContain('track_name=Now');
    expect(calledUrl).not.toContain('Sped');
    expect(calledUrl).toContain('artist_name=Lewis+KE');
  });
});
