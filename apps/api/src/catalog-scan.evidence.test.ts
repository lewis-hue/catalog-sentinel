import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleasedTrack, StoreScanReport } from '@sentinel/adapters';

const mocks = vi.hoisted(() => ({ scanStorePresence: vi.fn() }));

vi.mock('@sentinel/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentinel/adapters')>();
  return { ...actual, scanStorePresence: mocks.scanStorePresence };
});

import { scanReleasedCatalog } from './catalog-scan';

const released: ReleasedTrack = {
  title: 'Evidence Song',
  primaryArtist: 'Evidence Artist',
  isrc: null,
  artworkUrl: 'https://cdn.example/art.jpg',
  label: null,
  metadata: {
    isrc: {
      status: 'TIMEOUT', source: 'NETWORK_JSON',
      capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'network-v1',
    },
    label: {
      status: 'ABSENT_AT_SOURCE', source: 'NETWORK_JSON',
      capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'network-v1',
    },
  },
};

describe('scanReleasedCatalog metadata evidence', () => {
  beforeEach(() => {
    const report: StoreScanReport = {
      expectedArtist: 'Evidence Artist',
      stores: ['Evidence Store'],
      warnings: [],
      results: [{
        track: released,
        perStore: [{
          store: 'Evidence Store', status: 'unverifiable', matchedBy: null,
          confidence: 0.3, needsManualReview: true, reviewQuery: 'Evidence Artist Evidence Song',
        }],
      }],
      summary: { total: 1, live: 0, notLive: 0, wrongProfile: 0, unverifiable: 1, needsReview: 1 },
    };
    mocks.scanStorePresence.mockResolvedValue(report);
  });

  it('retains timeout and source-absence evidence through a saved-snapshot platform recheck', async () => {
    const result = await scanReleasedCatalog('Evidence Artist', [released]);

    expect(result.tracks[0]?.metadata?.isrc).toMatchObject({
      status: 'TIMEOUT', source: 'NETWORK_JSON', parserVersion: 'network-v1',
    });
    expect(result.tracks[0]?.metadata?.label?.status).toBe('ABSENT_AT_SOURCE');
  });
});
