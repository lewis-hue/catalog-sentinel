import { describe, it, expect } from 'vitest';
import { diffScans, type Scan } from './diff';

const rel = (releaseId: string, title: string, upc: string | null, isrcs: string[]): { releaseId: string; title: string; upc: string | null; tracks: { title: string; isrc: string }[] } =>
  ({ releaseId, title, upc, tracks: isrcs.map((isrc, i) => ({ title: `Track ${i + 1}`, isrc })) });

const store = (rows: Array<{ isrc: string; cells: Array<{ store: string; status: string }> }>) => ({
  result: { tracks: rows.map((r) => ({ isrc: r.isrc, perStore: r.cells })) },
});

describe('diffScans', () => {
  it('flags a new release and a new track', () => {
    const prev: Scan = { catalogue: { releases: [rel('R1', 'Album', '111', ['QZ1'])] }, record: null };
    const latest: Scan = { catalogue: { releases: [rel('R1', 'Album', '111', ['QZ1', 'QZ2']), rel('R2', 'New EP', '222', ['QZ9'])] }, record: null };
    const alerts = diffScans(prev, latest);
    expect(alerts.some((a) => a.kind === 'new-release' && a.releaseId === 'R2')).toBe(true);
    expect(alerts.some((a) => a.kind === 'new-track' && a.trackTitle === 'Track 2')).toBe(true);
  });

  it('detects a store regression (live → gone) and a recovery (missing → live)', () => {
    const prev: Scan = {
      catalogue: { releases: [rel('R1', 'Album', '111', ['QZ1', 'QZ2'])] },
      record: store([{ isrc: 'QZ1', cells: [{ store: 'Spotify', status: 'live' }] }, { isrc: 'QZ2', cells: [{ store: 'Spotify', status: 'not-live' }] }]),
    };
    const latest: Scan = {
      catalogue: { releases: [rel('R1', 'Album', '111', ['QZ1', 'QZ2'])] },
      record: store([{ isrc: 'QZ1', cells: [{ store: 'Spotify', status: 'not-live' }] }, { isrc: 'QZ2', cells: [{ store: 'Spotify', status: 'live' }] }]),
    };
    const alerts = diffScans(prev, latest);
    expect(alerts.some((a) => a.kind === 'store-lost' && a.store === 'Spotify')).toBe(true);
    expect(alerts.some((a) => a.kind === 'store-recovered' && a.store === 'Spotify')).toBe(true);
    // High-severity regression sorts before the "good" recovery.
    expect(alerts[0]!.severity).toBe('high');
    expect(alerts[alerts.length - 1]!.severity).toBe('good');
  });

  it('flags a wrong-profile appearance and a lost UPC', () => {
    const prev: Scan = {
      catalogue: { releases: [rel('R1', 'Album', '111', ['QZ1'])] },
      record: store([{ isrc: 'QZ1', cells: [{ store: 'Apple Music', status: 'live' }] }]),
    };
    const latest: Scan = {
      catalogue: { releases: [rel('R1', 'Album', null, ['QZ1'])] },
      record: store([{ isrc: 'QZ1', cells: [{ store: 'Apple Music', status: 'wrong-profile' }] }]),
    };
    const alerts = diffScans(prev, latest);
    expect(alerts.some((a) => a.kind === 'wrong-profile')).toBe(true);
    expect(alerts.some((a) => a.kind === 'metadata-lost')).toBe(true);
  });
});
