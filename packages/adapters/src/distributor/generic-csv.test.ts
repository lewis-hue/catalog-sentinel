import { describe, it, expect } from 'vitest';
import { GenericCsvDistributorAdapter, parseDuration } from './generic-csv';
import { AdapterInputError } from '../types';

const fixedClock = () => '2026-07-07T00:00:00.000Z';

const CSV = [
  'Release Title,Track Title,Artist,ISRC,UPC,Release Date,DistroKid URL,Stores,Plain Lyrics,Synced Lyrics,Songwriter,Duration,Explicit',
  'Lagos Nights,Lagos City Nights,Lewis KE,US-RC1-17-00001,088807219903,2023-04-01,https://distrokid.com/hyperfollow/lewiske/lagos-nights,"Spotify, Apple Music, Audiomack",Approved,,Lewis K,3:31,No',
  'Lagos Nights,Interlude,Lewis KE,US-RC1-17-00002,088807219903,2023-04-01,https://distrokid.com/hyperfollow/lewiske/lagos-nights,"Spotify, Apple Music, Audiomack",No,,Lewis K,1:12,No',
  'Solo Single,Alone Tonight,Lewis KE,US-RC1-17-00003,088807219904,2024-01-10,https://distrokid.com/hyperfollow/lewiske/solo,"Spotify, Apple Music",Rejected,,,4:02,Yes',
].join('\n');

describe('GenericCsvDistributorAdapter', () => {
  it('groups rows into releases with tracks and normalizes store selections', async () => {
    const adapter = new GenericCsvDistributorAdapter('distrokid', 'csv-import', fixedClock);
    const snap = await adapter.discoverCatalog({ csvText: CSV, artistName: 'Lewis KE' });

    expect(snap.releases).toHaveLength(2);
    const lagos = snap.releases.find((r) => r.title === 'Lagos Nights')!;
    expect(lagos.tracks).toHaveLength(2);
    expect(lagos.upc).toBe('088807219903');
    expect(lagos.distributorUrl).toContain('distrokid.com');
    expect(lagos.storeSelections.map((s) => s.platform).sort()).toEqual(['apple-music', 'audiomack', 'spotify']);
    // Audiomack selected -> album extra recorded
    expect(lagos.albumExtras).toContain('audiomack-opt-in');
  });

  it('parses lyrics status and explicit flags', async () => {
    const adapter = new GenericCsvDistributorAdapter('distrokid', 'csv-import', fixedClock);
    const snap = await adapter.discoverCatalog({ csvText: CSV });
    const solo = snap.releases.find((r) => r.title === 'Solo Single')!;
    expect(solo.tracks[0]?.lyrics?.plain).toBe('rejected');
    expect(solo.tracks[0]?.isExplicit).toBe(true);
    expect(solo.storeSelections.some((s) => s.platform === 'audiomack')).toBe(false);
  });

  it('is idempotent: re-importing the same CSV yields the same catalog', async () => {
    const adapter = new GenericCsvDistributorAdapter('distrokid', 'csv-import', fixedClock);
    const a = await adapter.discoverCatalog({ csvText: CSV, artistName: 'Lewis KE' });
    const b = await adapter.discoverCatalog({ csvText: CSV, artistName: 'Lewis KE' });
    expect(b).toEqual(a);
  });

  it('emits warnings for missing columns rather than throwing', async () => {
    const adapter = new GenericCsvDistributorAdapter('distrokid', 'csv-import', fixedClock);
    const snap = await adapter.discoverCatalog({ csvText: 'Song,Artist\nMy Song,Lewis KE\n' });
    expect(snap.releases).toHaveLength(1);
    expect(snap.warnings.some((w) => w.includes('ISRC'))).toBe(true);
  });

  it('throws AdapterInputError on empty input', async () => {
    const adapter = new GenericCsvDistributorAdapter();
    await expect(adapter.discoverCatalog({ csvText: '' })).rejects.toBeInstanceOf(AdapterInputError);
  });
});

describe('parseDuration', () => {
  it('parses m:ss, h:mm:ss, and raw seconds', () => {
    expect(parseDuration('3:31')).toBe(211);
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('245')).toBe(245);
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});
