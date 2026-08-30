import { describe, expect, it } from 'vitest';
import type { FinalizeJob, MetadataField, ReleaseExtractionOutcome } from '@sentinel/contracts';
import type { SearchRecord } from '@sentinel/search-store';
import { projectFinalizedSnapshot } from './finalize-result';

const field = <T>(value: T): MetadataField<T> => ({
  value, status: 'PRESENT', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1',
});
const missing = (): MetadataField<string> => ({
  status: 'TIMEOUT', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1',
});
const absent = (): MetadataField<string> => ({
  status: 'ABSENT_AT_SOURCE', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1',
});
const parseFailed = (): MetadataField<string> => ({
  status: 'PARSE_FAILED', source: 'DOM', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v2',
});
const completeness: FinalizeJob['completeness'] = {
  expectedReleases: 2, attemptedReleases: 2, completedReleases: 1, failedReleases: 1, skippedReleases: 0,
  expectedTracksKnown: false, expectedTracks: 1, extractedTracks: 1, releasesWithUpc: 1, releasesWithArtwork: 1,
  tracksWithIsrc: 0, tracksWithDistributorId: 0, releasesUpcAbsentAtSource: 0,
  tracksIsrcAbsentAtSource: 0, releasesUpcNotCaptured: 0, tracksIsrcNotCaptured: 1,
  unresolvedReleaseIds: ['R2'], failureReasons: { TIMEOUT: 1 },
};
const job: FinalizeJob = {
  tenantId: 'tenant-a', connectionId: 'c1', snapshotId: 'search-1', distributor: 'distrokid',
  status: 'PARTIAL_RETRYABLE', completeness, pass: 3,
};
const record: SearchRecord = {
  id: 'search-1', userId: 'tenant-a', createdAt: '2026-01-01T00:00:00.000Z', artist: 'Artist',
  distributor: 'distrokid', platforms: [], song: null,
  result: { artist: 'Artist', stores: [], profiles: [], tracks: [], summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: 'old', warnings: ['__reading_in_progress__'], note: 'reading' },
};
const outcomes: ReleaseExtractionOutcome[] = [
  {
    kind: 'COMPLETED', source: 'NETWORK_JSON', elapsedMs: 5,
    release: {
      distributorReleaseId: 'R1', title: 'Album', primaryArtist: 'Artist', featuredArtists: ['Guest One', 'Guest Two'], upc: field('123456789012'),
      artworkUrl: field('https://cdn.example/art.jpg'), releaseDate: field('2026-01-01'),
      label: absent(), uploadDate: parseFailed(),
      tracks: [{ title: 'Song', isrc: missing() }],
    },
  },
  { kind: 'FAILED', distributorReleaseId: 'R2', reason: 'TIMEOUT', detail: 'timed out', elapsedMs: 10 },
];

describe('projectFinalizedSnapshot', () => {
  it('replaces the reading sentinel, preserves metadata semantics, and queues presence verification', () => {
    const out = projectFinalizedSnapshot(record, job, outcomes, '2026-02-01T00:00:00.000Z');
    expect(out.result.warnings).not.toContain('__reading_in_progress__');
    expect(out.result.tracks).toHaveLength(1);
    expect(out.result.tracks[0]).toMatchObject({
      title: 'Song', isrc: null, upc: '123456789012',
      artworkUrl: 'https://cdn.example/art.jpg', perStore: [],
    });
    expect(out.result.tracks[0]?.metadata).toMatchObject({
      isrc: { status: 'TIMEOUT', source: 'NETWORK_JSON', parserVersion: 'v1' },
      upc: { value: '123456789012', status: 'PRESENT', source: 'NETWORK_JSON' },
      artworkUrl: { value: 'https://cdn.example/art.jpg', status: 'PRESENT', source: 'NETWORK_JSON' },
      label: { status: 'ABSENT_AT_SOURCE', source: 'NETWORK_JSON' },
      uploadDate: { status: 'PARSE_FAILED', source: 'DOM', parserVersion: 'v2' },
    });
    expect(out.result.tracks[0]?.metadata?.isrc?.status).not.toBe('ABSENT_AT_SOURCE');
    expect(out.result.distributorExtraction).toEqual({
      engine: 'NETWORK_FIRST',
      status: 'PARTIAL_RETRYABLE',
      finalizedAt: '2026-02-01T00:00:00.000Z',
      completeness,
    });
    expect(out.released?.[0]?.isrc).toBeNull();
    expect(out.released?.[0]?.featuredArtists).toEqual(['Guest One', 'Guest Two']);
    expect(out.result.tracks[0]?.featuredArtists).toEqual(['Guest One', 'Guest Two']);
    expect(out.deepScan?.status).toBe('queued');
    expect(out.result.summary.notLive).toBe(0);
    expect(out.result.warnings.join(' ')).toMatch(/unresolved metadata is not treated as missing/i);
  });

  it('projects the catalogue but leaves presence idle (never queued) when auto-presence is disabled', () => {
    const out = projectFinalizedSnapshot(record, job, outcomes, '2026-02-01T00:00:00.000Z', false);
    // The scraped catalogue is still fully projected, decoupling only defers the store check.
    expect(out.result.warnings).not.toContain('__reading_in_progress__');
    expect(out.result.tracks).toHaveLength(1);
    expect(out.result.tracks[0]).toMatchObject({ title: 'Song', perStore: [] });
    // No presence job is enqueued, so the record must NOT sit at "queued" (would poll forever) nor
    // "idle" (the active-scan guard would treat it as still-in-progress). It's terminal-unchecked.
    expect(out.deepScan?.status).toBe('unchecked');
    expect(out.deepScan?.platformsPending).toEqual([]);
    expect(out.deepScan?.platformsDone).toEqual([]);
    // Nothing has been checked, so nothing may read as missing.
    expect(out.result.summary.notLive).toBe(0);
    expect(out.result.note).toMatch(/store-presence check/i);
    expect(out.result.note).not.toMatch(/queued/i);
  });

  it('queues presence by default (auto-presence flag omitted preserves the legacy chain)', () => {
    const out = projectFinalizedSnapshot(record, job, outcomes, '2026-02-01T00:00:00.000Z');
    expect(out.deepScan?.status).toBe('queued');
  });

  it('marks presence done with no tracks regardless of the auto-presence flag', () => {
    const noReleases: ReleaseExtractionOutcome[] = [
      { kind: 'FAILED', distributorReleaseId: 'R2', reason: 'TIMEOUT', detail: 'timed out', elapsedMs: 10 },
    ];
    const auto = projectFinalizedSnapshot(record, job, noReleases, '2026-02-01T00:00:00.000Z', true);
    const manual = projectFinalizedSnapshot(record, job, noReleases, '2026-02-01T00:00:00.000Z', false);
    expect(auto.deepScan?.status).toBe('done');
    expect(manual.deepScan?.status).toBe('done');
  });

  it('rejects a cross-tenant finalization', () => {
    expect(() => projectFinalizedSnapshot({ ...record, userId: 'tenant-b' }, job, outcomes)).toThrow(/tenant/i);
  });

  it('owns each featured-artist array and falls back to the correlated release title', () => {
    const withBlankTrack = structuredClone(outcomes);
    const completed = withBlankTrack[0];
    if (!completed || completed.kind !== 'COMPLETED') throw new Error('fixture must be completed');
    completed.release.tracks[0]!.title = '';

    const out = projectFinalizedSnapshot(record, job, withBlankTrack, '2026-02-01T00:00:00.000Z');
    expect(out.released?.[0]).toMatchObject({ title: 'Album', featuredArtists: ['Guest One', 'Guest Two'] });
    expect(out.result.tracks[0]).toMatchObject({ title: 'Album', featuredArtists: ['Guest One', 'Guest Two'] });

    out.released![0]!.featuredArtists!.push('Mutated released projection');
    expect(out.result.tracks[0]!.featuredArtists).toEqual(['Guest One', 'Guest Two']);
    expect(completed.release.featuredArtists).toEqual(['Guest One', 'Guest Two']);
    expect(outcomes[0]?.kind === 'COMPLETED' ? outcomes[0].release.featuredArtists : []).toEqual(['Guest One', 'Guest Two']);
  });

  it('does not erase completed presence evidence when finalization is retried', () => {
    const projected = projectFinalizedSnapshot(record, job, outcomes, '2026-02-01T00:00:00.000Z');
    const afterPresence: SearchRecord = {
      ...projected,
      platforms: ['Spotify'],
      result: {
        ...projected.result,
        stores: ['Spotify'],
        generatedAt: '2026-02-01T00:05:00.000Z',
        summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 0 },
        tracks: projected.result.tracks.map((track) => ({
          ...track,
          perStore: [{
            store: 'Spotify', status: 'live', foundArtist: 'Artist',
            url: 'https://open.spotify.com/track/1', confidence: 1,
            needsManualReview: false, reviewQuery: null,
            reviewDecision: 'confirmed', reviewedBy: 'user-1', reviewedAt: '2026-02-01T00:04:00.000Z',
          }],
        })),
      },
      deepScan: {
        status: 'done', platformsPending: [], platformsDone: ['Spotify'],
        startedAt: '2026-02-01T00:01:00.000Z', updatedAt: '2026-02-01T00:05:00.000Z', tracksScanned: 1,
      },
    };

    const retried = projectFinalizedSnapshot(afterPresence, job, outcomes, '2026-02-02T00:00:00.000Z');
    expect(retried).toBe(afterPresence);
    expect(retried.result.tracks[0]?.perStore[0]).toMatchObject({
      store: 'Spotify', status: 'live', reviewDecision: 'confirmed',
    });
    expect(retried.result.tracks[0]?.metadata?.isrc?.status).toBe('TIMEOUT');
    expect(retried.result.distributorExtraction?.completeness.expectedTracksKnown).toBe(false);
    expect(retried.deepScan).toMatchObject({ status: 'done', platformsDone: ['Spotify'] });
    expect(retried.result.generatedAt).toBe('2026-02-01T00:05:00.000Z');
  });
});
