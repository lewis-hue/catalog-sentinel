import { describe, it, expect } from 'vitest';
import { planFixes, groupByRelease, type Catalogue, type RecordView } from './plan';

const catalogue: Catalogue = {
  releases: [
    {
      releaseId: 'UUID1', distributorReleaseId: 'https://distrokid.com/dashboard/album/?albumuuid=UUID1',
      title: 'Never The Same', upc: '0197773123456', upcStatus: 'PRESENT', artworkStatus: 'PRESENT',
      tracks: [
        // Heartless: lyrics on DistroKid but NOT on the stores → missing-on-store (medium).
        { title: 'Heartless', isrc: 'QZHNA2281227', isrcStatus: 'PRESENT', trackNumber: 1, plainLyrics: 'present', syncedLyrics: 'none', storeLyricStatus: 'not-found', storeHasPlain: false, storeHasSynced: false },
        // Pop Out: lyrics on the stores but DistroKid shows none → missing-on-distrokid (low).
        { title: 'Pop Out', isrc: 'QZHNA2281228', isrcStatus: 'PRESENT', trackNumber: 2, plainLyrics: 'none', syncedLyrics: 'none', storeLyricStatus: 'found', storeHasPlain: true, storeHasSynced: false },
      ],
    },
    {
      releaseId: 'UUID2', distributorReleaseId: 'https://distrokid.com/dashboard/album/?albumuuid=UUID2',
      title: 'Loose Single', upc: null, upcStatus: 'NOT_CAPTURED', artworkStatus: 'PRESENT',
      tracks: [{ title: 'Loose', isrc: 'QZABC2400001', isrcStatus: 'PRESENT', trackNumber: 1 }],
    },
  ],
};

const record: RecordView = {
  result: {
    stores: ['Spotify', 'Apple Music'],
    tracks: [
      // Heartless: wrong profile on Spotify.
      { title: 'Heartless', isrc: 'QZHNA2281227', perStore: [{ store: 'Spotify', status: 'wrong-profile', foundArtist: 'Other Lewis KE', url: 'https://open.spotify.com/track/x' }] },
      // Pop Out: not live on Apple Music.
      { title: 'Pop Out', isrc: 'QZHNA2281228', perStore: [{ store: 'Apple Music', status: 'not-live', foundArtist: null, url: null }] },
    ],
  },
};

describe('planFixes', () => {
  it('produces wrong-profile, missing-store, missing-lyrics and missing-metadata fixes, severity-sorted', () => {
    const fixes = planFixes(catalogue, record);
    const kinds = fixes.map((f) => f.kind);
    expect(kinds).toContain('wrong-profile');
    expect(kinds).toContain('missing-store');
    expect(kinds).toContain('missing-lyrics');
    expect(kinds).toContain('missing-metadata'); // UUID2 missing UPC
    // High severity (wrong-profile / missing-store) sorts before low (missing-on-distrokid lyrics).
    expect(fixes[0]!.severity).toBe('high');
    expect(fixes[fixes.length - 1]!.severity).toBe('low');
  });

  it('reconciles lyrics both ways and deep-links each direction correctly', () => {
    const fixes = planFixes(catalogue, record);
    const wrong = fixes.find((f) => f.kind === 'wrong-profile')!;
    expect(wrong.link?.href).toBe('https://artists.spotify.com');
    expect(wrong.prepared).toContain('Other Lewis KE');
    expect(wrong.prepared).toContain('QZHNA2281227');
    // Lyrics on DistroKid but missing on stores → medium, links to the release to request redelivery.
    const missingOnStore = fixes.find((f) => f.kind === 'missing-lyrics' && f.diagnosis.includes('not live on the stores'))!;
    expect(missingOnStore.severity).toBe('medium');
    expect(missingOnStore.link?.href).toBe('https://distrokid.com/dashboard/album/?albumuuid=UUID1');
    // Lyrics on stores but not on DistroKid → low, links to the DistroKid lyrics page.
    const missingOnDk = fixes.find((f) => f.kind === 'missing-lyrics' && f.diagnosis.includes('DistroKid release has none'))!;
    expect(missingOnDk.severity).toBe('low');
    expect(missingOnDk.link?.href).toBe('https://distrokid.com/lyrics/track/?id=UUID1,2');
    const meta = fixes.find((f) => f.kind === 'missing-metadata')!;
    expect(meta.link?.href).toBe('https://distrokid.com/dashboard/album/?albumuuid=UUID2');
  });

  it('emits only catalogue-metadata fixes when no store/lyric check has run', () => {
    // No record (store check) AND no store-lyric verdicts on the catalogue tracks → metadata only.
    const bare: Catalogue = {
      releases: catalogue.releases.map((r) => ({
        ...r,
        tracks: r.tracks.map((t) => ({ title: t.title, isrc: t.isrc, isrcStatus: t.isrcStatus, trackNumber: t.trackNumber })),
      })),
    };
    const fixes = planFixes(bare, null);
    expect(fixes.every((f) => f.kind === 'missing-metadata')).toBe(true);
    expect(fixes.some((f) => f.releaseId === 'UUID2')).toBe(true);
  });

  it('surfaces a manual "marked missing" track as a high-severity fix', () => {
    const r0 = catalogue.releases[0]!;
    const marked: Catalogue = { releases: [{ ...r0, tracks: [{ ...r0.tracks[0]!, mark: 'missing' }] }] };
    const fixes = planFixes(marked, null);
    const f = fixes.find((x) => x.diagnosis.includes('marked this track as missing'));
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('high');
  });

  it('groups fixes by release preserving order', () => {
    const groups = groupByRelease(planFixes(catalogue, record));
    expect(groups.map((g) => g.releaseId)).toContain('UUID1');
    expect(groups.every((g) => g.fixes.length > 0)).toBe(true);
  });
});
