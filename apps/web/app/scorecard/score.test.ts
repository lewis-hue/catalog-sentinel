import { describe, it, expect } from 'vitest';
import { computeHealth, type ScoreCatalogue, type ScoreRecord } from './score';

const catalogue: ScoreCatalogue = { releaseCount: 10, trackCount: 20, upcPresent: 10, artworkPresent: 10, isrcPresent: 20 };

describe('computeHealth', () => {
  it('scores metadata only (100%) and leaves store/identity/lyrics unassessed before any check', () => {
    const h = computeHealth(catalogue, null);
    expect(h.components.find((c) => c.key === 'metadata')!.score).toBe(100);
    expect(h.components.find((c) => c.key === 'store')!.score).toBeNull();
    // Only metadata assessed → overall == metadata score.
    expect(h.overall).toBe(100);
    expect(h.grade).toBe('A');
  });

  it('folds store presence, identity and lyrics in once their checks are done', () => {
    // Lyric coverage now comes from the catalogue (store-side verdicts), not the record.
    const catalogueWithLyrics: ScoreCatalogue = {
      ...catalogue,
      storeLyricsCheck: { status: 'done' },
      releases: [{ tracks: [{ storeLyricStatus: 'found' }, { storeLyricStatus: 'not-found' }] }],
    };
    const record: ScoreRecord = {
      deepScan: { status: 'done' },
      result: {
        stores: ['Spotify', 'Apple Music'],
        tracks: [
          { perStore: [{ store: 'Spotify', status: 'live' }, { store: 'Apple Music', status: 'live' }] },
          { perStore: [{ store: 'Spotify', status: 'wrong-profile' }, { store: 'Apple Music', status: 'not-live' }] },
        ],
      },
    };
    const h = computeHealth(catalogueWithLyrics, record);
    // store: 2 live of 4 decisive = 50.
    expect(h.components.find((c) => c.key === 'store')!.score).toBe(50);
    // identity: 1 of 2 tracks wrong → 50.
    expect(h.components.find((c) => c.key === 'identity')!.score).toBe(50);
    // lyrics: 1 of 2 found → 50.
    expect(h.components.find((c) => c.key === 'lyrics')!.score).toBe(50);
    // overall = (100*30 + 50*35 + 50*20 + 50*15) / 100 = 65.
    expect(h.overall).toBe(65);
    expect(h.grade).toBe('D');
  });
});
