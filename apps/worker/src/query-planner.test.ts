import { describe, it, expect } from 'vitest';
import { planDeepScan, type PlannerTrack } from './query-planner';

const track = (title: string, artist = 'Lewis KE', isrc: string | null = null): PlannerTrack => ({ title, primaryArtist: artist, isrc });

describe('planDeepScan', () => {
  it('deduplicates by (artist,title) so duplicates do not multiply queries', () => {
    const tracks = [track('Icy Love'), track('Icy Love'), track('Skit'), track('ICY  LOVE')]; // 3rd/4th normalize-equal to 1st
    const plan = planDeepScan({ tracks, platforms: ['Spotify', 'Audiomack'] });
    expect(plan.uniqueQueries).toBe(2); // "icy love" + "skit"
    expect(plan.tracksToVerify).toBe(4);
  });

  it('bounds the track set to the budget and reports the overflow', () => {
    const tracks = Array.from({ length: 1000 }, (_, i) => track(`Song ${i}`));
    const plan = planDeepScan({ tracks, platforms: ['Spotify'], maxTracks: 500 });
    expect(plan.tracksToVerify).toBe(500);
    expect(plan.skippedOverBudget).toBe(500);
  });

  it('skips tracks already confirmed everywhere', () => {
    const tracks = [track('A'), track('B'), track('C')];
    const plan = planDeepScan({ tracks, platforms: ['Spotify'], confirmedTrackIndices: new Set([0, 2]) });
    expect(plan.tracksToVerify).toBe(1);
    expect(plan.skippedConfirmed).toBe(2);
    expect(plan.chunks.flat()).toEqual([1]); // original index preserved
  });

  it('chunks track indices for checkpointing', () => {
    const tracks = Array.from({ length: 55 }, (_, i) => track(`Song ${i}`));
    const plan = planDeepScan({ tracks, platforms: ['Spotify'], chunkSize: 25 });
    expect(plan.chunks.map((c) => c.length)).toEqual([25, 25, 5]);
  });

  it('keeps the search-call estimate O(unique songs × platforms), NOT tracks × platforms × engines', () => {
    // 1,000 tracks but only 800 unique titles, across 10 platforms.
    const tracks = Array.from({ length: 1000 }, (_, i) => track(`Song ${i % 800}`));
    const platforms = Array.from({ length: 10 }, (_, i) => `P${i}`);
    const plan = planDeepScan({ tracks, platforms });
    expect(plan.uniqueQueries).toBe(800);
    expect(plan.estimatedSearchCalls).toBe(800 * 11); // 8,800 worst case
    // A naive tracks × platforms × (say 5 engines) would be 1000 × 10 × 5 = 50,000.
    expect(plan.estimatedSearchCalls).toBeLessThan(1000 * 10 * 5);
  });
});
