import { describe, it, expect } from 'vitest';
import { toNormalizedItem } from './build';
import { scoreMatch, matchAgainstCatalog, detectDuplicateIsrcs } from './matcher';

const subj = (o: Parameters<typeof toNormalizedItem>[0]) => toNormalizedItem(o);

describe('scoreMatch, identifier-first cascade', () => {
  it('confirms an ISRC exact match at 1.0 regardless of title casing/separators', () => {
    const a = subj({ id: 'a', title: 'My Song', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001', durationSec: 200 });
    const b = subj({ id: 'b', title: 'my song', artistNames: ['Lewis KE'], isrc: 'usrc11700001', durationSec: 260 });
    const r = scoreMatch(a, b);
    expect(r.score).toBe(1);
    expect(r.band).toBe('confirmed');
    expect(r.reasons[0]).toMatch(/ISRC/);
  });

  it('confirms a known external-id/url match at 0.99', () => {
    const a = subj({ id: 'a', title: 'X', artistNames: ['Lewis KE'], externalIds: ['spotify:track:abc'] });
    const b = subj({ id: 'b', title: 'totally different', artistNames: ['Someone'], externalIds: ['spotify:track:abc'] });
    const r = scoreMatch(a, b);
    expect(r.band).toBe('confirmed');
    expect(r.score).toBeCloseTo(0.99, 2);
  });

  it('gives a strong metadata match when title+artist align and no identifiers exist', () => {
    const a = subj({ id: 'a', title: 'Lagos City Nights', artistNames: ['Lewis KE'], durationSec: 210 });
    const b = subj({ id: 'b', title: 'lagos city nights', artistNames: ['lewis ke'], durationSec: 211 });
    const r = scoreMatch(a, b);
    expect(r.band).toBe('strong');
    expect(r.artistMismatch).toBe(false);
  });
});

describe('scoreMatch, penalties', () => {
  it('penalizes a remix vs the original as a version mismatch (different recording)', () => {
    const a = subj({ id: 'a', title: 'Lagos City Nights', artistNames: ['Lewis KE'] });
    const b = subj({ id: 'b', title: 'Lagos City Nights (Remix)', artistNames: ['Lewis KE'] });
    const r = scoreMatch(a, b);
    expect(r.versionMismatch).toBe(true);
    expect(r.score).toBeLessThanOrEqual(0.6);
  });

  it('caps score when duration differs beyond tolerance', () => {
    const a = subj({ id: 'a', title: 'Lagos City Nights', artistNames: ['Lewis KE'], durationSec: 200 });
    const near = subj({ id: 'n', title: 'Lagos City Nights', artistNames: ['Lewis KE'], durationSec: 203 });
    const far = subj({ id: 'f', title: 'Lagos City Nights', artistNames: ['Lewis KE'], durationSec: 320 });
    expect(scoreMatch(a, near).band).toBe('strong');
    expect(scoreMatch(a, far).score).toBeLessThanOrEqual(0.6);
  });

  it('does not treat a title-only match under a different artist as confirmed', () => {
    const a = subj({ id: 'a', title: 'Lagos City Nights', artistNames: ['Lewis KE'] });
    const b = subj({ id: 'b', title: 'Lagos City Nights', artistNames: ['Different Artist'] });
    const r = scoreMatch(a, b);
    expect(r.artistMismatch).toBe(true);
    expect(r.score).toBeLessThanOrEqual(0.55);
  });
});

describe('matchAgainstCatalog, decisions', () => {
  const subject = subj({ id: 's', title: 'Lagos City Nights', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001' });

  it('marks a subject MISSING (unmatched) when no candidate matches', () => {
    const res = matchAgainstCatalog(subject, []);
    expect(res.decision).toBe('unmatched');
    expect(res.best).toBeNull();

    const res2 = matchAgainstCatalog(subject, [
      subj({ id: 'x', title: 'Completely Other Track', artistNames: ['Nobody'] }),
    ]);
    expect(res2.decision).toBe('unmatched');
  });

  it('matches via ISRC even against a large candidate list', () => {
    const candidates = [
      subj({ id: 'noise1', title: 'noise', artistNames: ['Nobody'] }),
      subj({ id: 'hit', title: 'different display title', artistNames: ['Lewis KE'], isrc: 'USRC11700001' }),
      subj({ id: 'noise2', title: 'noise2', artistNames: ['Nobody'] }),
    ];
    const res = matchAgainstCatalog(subject, candidates);
    expect(res.decision).toBe('matched');
    expect(res.best?.candidate.id).toBe('hit');
  });

  it('flags a wrong-profile lead when the title matches but the artist does not', () => {
    const s2 = subj({ id: 's2', title: 'Lagos City Nights', artistNames: ['Lewis KE'] });
    const res = matchAgainstCatalog(s2, [
      subj({ id: 'wrong', title: 'Lagos City Nights', artistNames: ['Impostor Artist'], artistProfileId: 'p_other' }),
    ]);
    expect(res.wrongProfileSuspected).toBe(true);
    expect(res.decision).toBe('review');
  });

  it('routes an ambiguous partial-artist match to manual review', () => {
    const s3 = subj({ id: 's3', title: 'Together', artistNames: ['Lewis KE', 'Ade'] });
    const res = matchAgainstCatalog(s3, [
      subj({ id: 'maybe', title: 'Together', artistNames: ['Lewis KE', 'Bola'] }),
    ]);
    expect(res.decision).toBe('review');
    expect(res.best?.score.band).toBe('probable');
  });

  it('detects cross-profile match when candidate is under a non-canonical profile', () => {
    const s4 = subj({ id: 's4', title: 'Homecoming', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00099' });
    const res = matchAgainstCatalog(
      s4,
      [subj({ id: 'dup', title: 'Homecoming', artistNames: ['Lewis KE'], isrc: 'USRC11700099', artistProfileId: 'p_dupe' })],
      { canonicalArtistProfileId: 'p_canonical' },
    );
    expect(res.decision).toBe('matched');
    expect(res.crossProfile).toBe(true);
  });
});

describe('detectDuplicateIsrcs', () => {
  it('flags one ISRC shared by two DISTINCT recordings', () => {
    const items = [
      subj({ id: '1', title: 'Song A', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001' }),
      subj({ id: '2', title: 'Song B', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001' }),
      subj({ id: '3', title: 'Song C', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00002' }),
    ];
    const dupes = detectDuplicateIsrcs(items);
    expect([...dupes.keys()]).toEqual(['USRC11700001']);
  });

  it('does not flag the same recording appearing twice with the same ISRC', () => {
    const items = [
      subj({ id: '1', title: 'Song A', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001' }),
      subj({ id: '2', title: 'song a', artistNames: ['Lewis KE'], isrc: 'US-RC1-17-00001' }),
    ];
    expect(detectDuplicateIsrcs(items).size).toBe(0);
  });
});
