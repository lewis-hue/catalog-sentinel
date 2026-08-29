import { describe, it, expect } from 'vitest';
import { scrapedReleaseToCanonical, DISTROKID_DOM_PARSER_VERSION } from './album-page';
import type { ScrapedReleaseDetail } from '../distrokid-attended';

const base: ScrapedReleaseDetail = {
  title: 'Pesa',
  primaryArtist: 'Lewis KE',
  upc: '0197773123456',
  releaseDate: '2024-06-01',
  uploadDate: '2024-05-20',
  label: 'Lewis KE',
  artworkUrl: 'https://images.distrokid.com/x/pesa.jpg',
  stores: [{ store: 'Spotify', status: 'live' }],
  submittedStores: [{ store: 'Spotify', url: 'https://open.spotify.com/album/x' }, { store: 'Apple Music', url: null }],
  tracks: [
    { title: 'Pesa', isrc: 'QZNWX2412345', trackNumber: 1, plainLyrics: null, syncedLyrics: null, credits: null, featured: [] },
  ],
};

describe('scrapedReleaseToCanonical', () => {
  it('carries the DistroKid "Submitted to X" store list (with deep-links) onto the canonical release', () => {
    const c = scrapedReleaseToCanonical(base);
    expect(c.submittedStores).toEqual([
      { store: 'Spotify', url: 'https://open.spotify.com/album/x' },
      { store: 'Apple Music', url: null },
    ]);
  });

  it('maps present DOM fields to PRESENT canonical fields, sourced DOM', () => {
    const r = scrapedReleaseToCanonical(base);
    expect(r.title).toBe('Pesa');
    expect(r.primaryArtist).toBe('Lewis KE');
    expect(r.upc).toMatchObject({ value: '0197773123456', status: 'PRESENT', source: 'DOM', parserVersion: DISTROKID_DOM_PARSER_VERSION });
    expect(r.artworkUrl).toMatchObject({ value: 'https://images.distrokid.com/x/pesa.jpg', status: 'PRESENT', source: 'DOM' });
    expect(r.releaseDate).toMatchObject({ value: '2024-06-01', status: 'PRESENT' });
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]).toMatchObject({ title: 'Pesa', trackNumber: 1 });
    expect(r.tracks[0]!.isrc).toMatchObject({ value: 'QZNWX2412345', status: 'PRESENT', source: 'DOM' });
  });

  it('leaves distributorReleaseId "unknown" so the extractor substitutes the catalog-index ref id', () => {
    expect(scrapedReleaseToCanonical(base).distributorReleaseId).toBe('unknown');
  });

  it('marks missing fields NOT_CAPTURED (never ABSENT_AT_SOURCE, a DOM miss is not proven absence)', () => {
    const sparse: ScrapedReleaseDetail = {
      ...base,
      upc: null,
      artworkUrl: null,
      releaseDate: null,
      uploadDate: null,
      label: null,
      tracks: [
        { title: 'Track A', isrc: null, trackNumber: null, plainLyrics: null, syncedLyrics: null, credits: null, featured: [] },
        { title: 'Track B', isrc: null, trackNumber: null, plainLyrics: null, syncedLyrics: null, credits: null, featured: [] },
      ],
    };
    const r = scrapedReleaseToCanonical(sparse);
    expect(r.upc.status).toBe('NOT_CAPTURED');
    expect(r.upc.value).toBeUndefined();
    expect(r.artworkUrl.status).toBe('NOT_CAPTURED');
    expect(r.releaseDate.status).toBe('NOT_CAPTURED');
    // Optional fields are omitted entirely when the scrape had nothing.
    expect(r.uploadDate).toBeUndefined();
    expect(r.label).toBeUndefined();
    // Tracks are preserved; trackNumber falls back to 1-based ordinal; ISRC is NOT_CAPTURED.
    expect(r.tracks).toHaveLength(2);
    expect(r.tracks[0]).toMatchObject({ title: 'Track A', trackNumber: 1 });
    expect(r.tracks[1]).toMatchObject({ title: 'Track B', trackNumber: 2 });
    expect(r.tracks[0]!.isrc.status).toBe('NOT_CAPTURED');
  });

  it('trims whitespace and treats blank strings as not captured', () => {
    const r = scrapedReleaseToCanonical({ ...base, upc: '   ', title: '  Pesa  ' });
    expect(r.title).toBe('Pesa');
    expect(r.upc.status).toBe('NOT_CAPTURED');
  });

  it('carries per-track plain/synced lyric status into the canonical model', () => {
    const withLyrics: ScrapedReleaseDetail = {
      ...base,
      tracks: [
        { title: 'Heartless', isrc: 'QZHNA2281227', trackNumber: 1, plainLyrics: 'present', syncedLyrics: 'present', credits: null, featured: [] },
        { title: 'Pop Out', isrc: 'QZHNA2281228', trackNumber: 2, plainLyrics: 'present', syncedLyrics: 'processing', credits: null, featured: [] },
        { title: 'Interlude', isrc: null, trackNumber: 3, plainLyrics: 'none', syncedLyrics: 'none', credits: null, featured: [] },
      ],
    };
    const r = scrapedReleaseToCanonical(withLyrics);
    expect(r.tracks[0]!.lyrics).toEqual({ plain: 'present', synced: 'present' });
    expect(r.tracks[1]!.lyrics).toEqual({ plain: 'present', synced: 'processing' });
    expect(r.tracks[2]!.lyrics).toEqual({ plain: 'none', synced: 'none' });
  });

  it('defaults lyric status to unknown when the scrape could not read the cell (never none)', () => {
    // base fixture tracks carry plainLyrics/syncedLyrics = null (cell not read).
    const r = scrapedReleaseToCanonical(base);
    expect(r.tracks[0]!.lyrics).toEqual({ plain: 'unknown', synced: 'unknown' });
  });
});
