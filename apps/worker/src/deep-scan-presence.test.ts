import { describe, it, expect } from 'vitest';
import { mergePlatform, runStorePresenceDeepScan } from './deep-scan-presence';
import { InMemorySearchStore, type SearchRecord, type CatalogResultLike } from '@sentinel/search-store';
import type { ScannableStore, StoreArtistCatalog, StoreTrack } from '@sentinel/adapters';

function record(): SearchRecord {
  const result: CatalogResultLike = {
    artist: 'Lewis KE',
    stores: ['Deezer', 'Apple Music'],
    profiles: [],
    tracks: [
      { title: 'Icy Love', album: null, isrc: 'QZK6K2090500', artworkUrl: null, perStore: [
        { store: 'Deezer', status: 'live', foundArtist: null, url: 'd1', confidence: 1, needsManualReview: false, reviewQuery: null },
        { store: 'Apple Music', status: 'live', foundArtist: null, url: null, confidence: 0.8, needsManualReview: false, reviewQuery: null },
      ] },
      { title: 'Skit', album: null, isrc: null, artworkUrl: null, metadata: {
        isrc: { status: 'TIMEOUT', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1' },
        label: { status: 'ABSENT_AT_SOURCE', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1' },
      }, perStore: [
        { store: 'Deezer', status: 'not-live', foundArtist: null, url: null, confidence: 0.8, needsManualReview: false, reviewQuery: null },
        { store: 'Apple Music', status: 'not-live', foundArtist: null, url: null, confidence: 0.8, needsManualReview: false, reviewQuery: null },
      ] },
    ],
    summary: { tracks: 2, live: 2, notLive: 2, wrongProfile: 0, needsReview: 0 },
    generatedAt: 'now', warnings: [], note: '',
    distributorExtraction: {
      engine: 'NETWORK_FIRST', status: 'PARTIAL_RETRYABLE', finalizedAt: '2026-01-01T00:00:00.000Z',
      completeness: {
        expectedReleases: 2, attemptedReleases: 2, completedReleases: 1, failedReleases: 1, skippedReleases: 0,
        expectedTracksKnown: false, expectedTracks: 2, extractedTracks: 2,
        releasesWithUpc: 0, releasesWithArtwork: 0, tracksWithIsrc: 1, tracksWithDistributorId: 0,
        releasesUpcAbsentAtSource: 0, tracksIsrcAbsentAtSource: 0, releasesUpcNotCaptured: 1, tracksIsrcNotCaptured: 1,
        unresolvedReleaseIds: ['release-2'], failureReasons: { TIMEOUT: 1 },
      },
    },
  };
  return { id: 'search_1', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
}

describe('mergePlatform', () => {
  it('rejects a queue job whose tenant does not own the search record', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, record().result, []);
    await expect(runStorePresenceDeepScan(saved.id, { store, env: {} }, 'tenant-b')).rejects.toThrow(/tenant/i);
  });

  it('adds a platform column index-aligned and recomputes the summary', () => {
    const merged = mergePlatform(record(), 'Spotify', [
      { status: 'live', url: 'https://open.spotify.com/track/x', confidence: 0.75, needsManualReview: false },
      { status: 'unverifiable', url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Skit' },
    ]);
    expect(merged.result.stores).toContain('Spotify');
    // Icy Love now live on Spotify; Skit unverifiable → needs review.
    expect(merged.result.tracks[0]!.perStore.find((p) => p.store === 'Spotify')?.status).toBe('live');
    expect(merged.result.tracks[1]!.perStore.find((p) => p.store === 'Spotify')?.needsManualReview).toBe(true);
    // Summary recomputed across all per-store cells: live 2(Deezer/Apple Icy)+1(Spotify Icy)=3.
    expect(merged.result.summary.live).toBe(3);
    expect(merged.result.summary.needsReview).toBe(1);
    expect(merged.result.tracks[1]?.metadata?.isrc?.status).toBe('TIMEOUT');
    expect(merged.result.tracks[1]?.metadata?.label?.status).toBe('ABSENT_AT_SOURCE');
    expect(merged.result.distributorExtraction).toMatchObject({
      status: 'PARTIAL_RETRYABLE',
      completeness: { expectedTracksKnown: false, unresolvedReleaseIds: ['release-2'] },
    });
  });

  it('replaces an existing platform column rather than duplicating it', () => {
    let rec = mergePlatform(record(), 'Spotify', [{ status: 'not-live', confidence: 0.8, needsManualReview: false }, { status: 'not-live', confidence: 0.8, needsManualReview: false }]);
    rec = mergePlatform(rec, 'Spotify', [{ status: 'live', url: 'u', confidence: 0.75, needsManualReview: false }, { status: 'not-live', confidence: 0.8, needsManualReview: false }]);
    const spotifyCells = rec.result.tracks[0]!.perStore.filter((p) => p.store === 'Spotify');
    expect(spotifyCells).toHaveLength(1);
    expect(spotifyCells[0]!.status).toBe('live');
  });

  it('in-memory store update mutates the record for the API to serve', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, record().result, [{ title: 'Icy Love', primaryArtist: 'Lewis KE', isrc: 'QZK6K2090500' }]);
    await store.update(saved.id, (r) => mergePlatform(r, 'Audiomack', [{ status: 'unverifiable', confidence: 0.3, needsManualReview: true }, { status: 'unverifiable', confidence: 0.3, needsManualReview: true }]));
    const after = await store.get(saved.id);
    expect(after?.result.stores).toContain('Audiomack');
    expect(after?.result.tracks[0]!.perStore.some((p) => p.store === 'Audiomack')).toBe(true);
  });

  it('scans 1,001 tracks in chunks while fetching the platform catalogue exactly once', async () => {
    const count = 1_001;
    const released = Array.from({ length: count }, (_, index) => ({
      title: `Track ${index}`,
      primaryArtist: 'Scale Artist',
      isrc: null,
    }));
    const catalogTracks: StoreTrack[] = released.map((track) => ({
      title: track.title, primaryArtist: track.primaryArtist, album: null, isrc: null,
      url: `https://example.test/${encodeURIComponent(track.title)}`, releaseDate: null, artworkUrl: null,
    }));
    const result: CatalogResultLike = {
      artist: 'Scale Artist', stores: [], profiles: [],
      tracks: released.map((track) => ({ ...track, album: null, artworkUrl: null, perStore: [] })),
      summary: { tracks: count, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
      generatedAt: 'now', warnings: [], note: '',
    };
    let catalogCalls = 0;
    const target: ScannableStore = {
      catalog: {
        store: 'Scale DSP', method: 'api', needsCredential: false,
        async listArtistCatalog(_artist, options): Promise<StoreArtistCatalog> {
          catalogCalls++;
          expect(options?.limit).toBe(20_000);
          return {
            store: 'Scale DSP', method: 'api', artist: { id: 'scale', name: 'Scale Artist', url: 'https://example.test/artist' },
            tracks: catalogTracks, pagination: { total: count, fetched: count, complete: true }, warnings: [],
          };
        },
      },
    };
    const store = new InMemorySearchStore();
    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Scale Artist', distributor: 'distrokid' }, result, released);

    await runStorePresenceDeepScan(saved.id, { store, env: {}, targets: [target], maxTracks: 2_000, chunkSize: 25 }, 'tenant-a');

    const after = await store.get(saved.id);
    expect(catalogCalls).toBe(1);
    expect(after?.deepScan).toMatchObject({ status: 'done', tracksScanned: count, platformTracksVerified: { 'Scale DSP': count } });
    expect(after?.result.tracks).toHaveLength(count);
    expect(after?.result.tracks.every((track) => track.perStore.find((cell) => cell.store === 'Scale DSP')?.status === 'live')).toBe(true);
  }, 30_000);

  it('fails capacity overflow before any provider call and does not synthesize truncated verdicts', async () => {
    const count = 1_001;
    const released = Array.from({ length: count }, (_, index) => ({ title: `Track ${index}`, primaryArtist: 'Scale Artist', isrc: null }));
    const result: CatalogResultLike = {
      artist: 'Scale Artist', stores: [], profiles: [],
      tracks: released.map((track) => ({ ...track, album: null, artworkUrl: null, perStore: [] })),
      summary: { tracks: count, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
      generatedAt: 'now', warnings: [], note: '',
    };
    let catalogCalls = 0;
    const target: ScannableStore = {
      catalog: {
        store: 'Scale DSP', method: 'api', needsCredential: false,
        async listArtistCatalog(): Promise<StoreArtistCatalog> {
          catalogCalls++;
          throw new Error('must not be called');
        },
      },
    };
    const store = new InMemorySearchStore();
    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Scale Artist', distributor: 'distrokid' }, result, released);

    await expect(runStorePresenceDeepScan(saved.id, { store, env: {}, targets: [target], maxTracks: 1_000 }, 'tenant-a'))
      .rejects.toThrow(/no track was silently truncated/i);

    const after = await store.get(saved.id);
    expect(catalogCalls).toBe(0);
    expect(after?.deepScan).toMatchObject({ status: 'error', tracksScanned: 0 });
    expect(after?.result.tracks.every((track) => track.perStore.length === 0)).toBe(true);
  });
});
