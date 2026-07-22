import { describe, it, expect } from 'vitest';
import { deriveManualReviewItems, applyManualReviewDecision, encodeItemId, decodeItemId } from './manual-review';
import type { CatalogResultLike, SearchRecord } from './search-store';

function record(): SearchRecord {
  const result: CatalogResultLike = {
    artist: 'Lewis KE', stores: ['Deezer', 'Audiomack', 'Apple Music / iTunes'], profiles: [],
    tracks: [
      { title: 'Icy Love', album: null, isrc: 'QZK6K2090500', artworkUrl: null, perStore: [
        { store: 'Deezer', status: 'live', foundArtist: null, url: 'd', confidence: 1, needsManualReview: false, reviewQuery: null },
        { store: 'Audiomack', status: 'unverifiable', foundArtist: null, url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Icy Love' },
        { store: 'Apple Music / iTunes', status: 'unverifiable', foundArtist: null, url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Icy Love' },
      ] },
    ],
    summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 2 }, generatedAt: 'now', warnings: [], note: '',
  };
  return { id: 'search_1', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
}

describe('manual-review', () => {
  it('encodes/decodes item ids incl. platform names with slashes', () => {
    const id = encodeItemId(0, 'Apple Music / iTunes');
    expect(decodeItemId(id)).toEqual({ trackIndex: 0, platform: 'Apple Music / iTunes' });
    expect(decodeItemId('not-valid!!')).toBeNull();
  });

  it('derives only the cells that need review (open by default)', () => {
    const items = deriveManualReviewItems(record());
    expect(items).toHaveLength(2); // Audiomack + Apple, not the live Deezer cell
    expect(items.map((i) => i.platform).sort()).toEqual(['Apple Music / iTunes', 'Audiomack']);
    expect(items[0]!.query).toBe('Lewis KE Icy Love');
  });

  it('CONFIRMED_MISSING writes not-live back to the matrix + recomputes summary', () => {
    const rec = record();
    const item = deriveManualReviewItems(rec).find((i) => i.platform === 'Audiomack')!;
    const next = applyManualReviewDecision(rec, item.id, 'CONFIRMED_MISSING', { at: '2026-07-12T00:00:00Z', reviewedBy: 'lewis' })!;
    const cell = next.result.tracks[0]!.perStore.find((p) => p.store === 'Audiomack')!;
    expect(cell.status).toBe('not-live');
    expect(cell.needsManualReview).toBe(false);
    expect(cell.confidence).toBe(1);
    expect(cell.reviewDecision).toBe('CONFIRMED_MISSING');
    expect(cell.reviewedBy).toBe('lewis');
    expect(next.result.summary.notLive).toBe(1);
    expect(next.result.summary.needsReview).toBe(1); // Apple still open
    // The resolved item drops out of the open queue.
    expect(deriveManualReviewItems(next).map((i) => i.platform)).toEqual(['Apple Music / iTunes']);
  });

  it('CONFIRMED_PRESENT → live; DISMISSED keeps status but clears the flag', () => {
    const rec = record();
    const audiomack = deriveManualReviewItems(rec).find((i) => i.platform === 'Audiomack')!;
    const present = applyManualReviewDecision(rec, audiomack.id, 'CONFIRMED_PRESENT', { at: 't' })!;
    expect(present.result.tracks[0]!.perStore.find((p) => p.store === 'Audiomack')!.status).toBe('live');

    const dismissed = applyManualReviewDecision(rec, audiomack.id, 'DISMISSED', { at: 't' })!;
    const cell = dismissed.result.tracks[0]!.perStore.find((p) => p.store === 'Audiomack')!;
    expect(cell.status).toBe('unverifiable'); // unchanged
    expect(cell.needsManualReview).toBe(false); // but no longer in the queue
  });

  it('returns null for an unknown item id', () => {
    expect(applyManualReviewDecision(record(), encodeItemId(9, 'Nope'), 'DISMISSED', { at: 't' })).toBeNull();
  });
});
