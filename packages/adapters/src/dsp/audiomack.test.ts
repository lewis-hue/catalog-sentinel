import { describe, it, expect } from 'vitest';
import { AudiomackAdapter, type AudiomackDataset } from './audiomack.test-support';
import { AdapterUnavailableError, type RawDSPItem } from '../types';

function song(id: string, title: string, extra: Partial<RawDSPItem> = {}): RawDSPItem {
  return {
    externalId: id,
    url: `https://audiomack.com/lewis_ke/song/${id}`,
    title,
    primaryArtist: 'Lewis KE',
    featuredArtists: [],
    isrc: null,
    upc: null,
    durationSec: 200,
    kind: 'song',
    status: 'confirmed-live',
    artistProfileId: 'am_lewis_ke',
    markets: ['US', 'NG'],
    ...extra,
  };
}

const dataset: AudiomackDataset = {
  profiles: {
    lewis_ke: {
      profile: {
        platform: 'audiomack',
        externalId: 'am_lewis_ke',
        slug: 'lewis_ke',
        url: 'https://audiomack.com/lewis_ke',
        name: 'Lewis KE',
        confidence: 1,
        verified: true,
      },
      items: [
        song('s1', 'Lagos City Nights'),
        song('s2', 'Alone Tonight'),
        song('s3', 'Hidden Track', { status: 'private-unplayable' }),
        song('s4', 'Homecoming'),
        song('s5', 'Sunrise'),
      ],
    },
  },
};

const clock = () => '2026-07-07T00:00:00.000Z';

describe('AudiomackAdapter (mock/fixtures)', () => {
  it('resolves an artist by slug, url, and name', async () => {
    const a = new AudiomackAdapter({ dataset, clockIso: clock });
    expect((await a.resolveArtist({ slug: 'lewis_ke' }))[0]?.name).toBe('Lewis KE');
    expect((await a.resolveArtist({ url: 'https://audiomack.com/lewis_ke' }))[0]?.slug).toBe('lewis_ke');
    expect((await a.resolveArtist({ name: 'lewis' }))).toHaveLength(1);
    expect(await a.resolveArtist({ slug: 'nobody' })).toEqual([]);
  });

  it('lists artist uploads with pagination and includes private/unplayable items', async () => {
    const a = new AudiomackAdapter({ dataset, pageSize: 2, clockIso: clock });
    const profile = (await a.resolveArtist({ slug: 'lewis_ke' }))[0]!;
    const snap = await a.listArtistCatalog({ profile });
    expect(snap.items).toHaveLength(5);
    expect(snap.pagination).toEqual({ total: 5, fetched: 5, complete: true });
    expect(snap.items.find((i) => i.title === 'Hidden Track')?.status).toBe('private-unplayable');
  });

  it('reports a not-found profile clearly without fabricating uploads', async () => {
    const a = new AudiomackAdapter({ dataset, clockIso: clock });
    const snap = await a.listArtistCatalog({
      profile: { platform: 'audiomack', externalId: null, slug: 'ghost', url: null, name: 'Ghost', confidence: 0.5 },
    });
    expect(snap.items).toEqual([]);
    expect(snap.pagination.complete).toBe(false);
    expect(snap.warnings[0]).toMatch(/No Audiomack profile/);
  });

  it('reports maxItems truncation explicitly', async () => {
    const a = new AudiomackAdapter({ dataset, pageSize: 2, clockIso: clock });
    const profile = (await a.resolveArtist({ slug: 'lewis_ke' }))[0]!;
    const snap = await a.listArtistCatalog({ profile, maxItems: 2 });
    expect(snap.pagination).toEqual({ total: 5, fetched: 2, complete: false });
    expect(snap.warnings.join(' ')).toMatch(/maxItems|cannot be verified/i);
  });

  it('honors the rate limiter and reports incomplete pagination under backpressure', async () => {
    // 2 tokens, no refill (fixed now), pageSize 1 => only 2 of 5 pages fetched.
    const a = new AudiomackAdapter({ dataset, pageSize: 1, ratePerMinute: 2, now: () => 1000, clockIso: clock });
    const profile = (await a.resolveArtist({ slug: 'lewis_ke' }))[0]!;
    const snap = await a.listArtistCatalog({ profile });
    expect(snap.pagination.complete).toBe(false);
    expect(snap.items.length).toBeLessThan(5);
    expect(snap.warnings.some((w) => /rate limit/i.test(w))).toBe(true);
  });

  it('throws AdapterUnavailableError when neither fixtures nor API creds exist', async () => {
    const a = new AudiomackAdapter({});
    await expect(a.resolveArtist({ slug: 'x' })).rejects.toBeInstanceOf(AdapterUnavailableError);
  });

  it('finds tracks by title', async () => {
    const a = new AudiomackAdapter({ dataset, clockIso: clock });
    const hits = await a.findTrack({ title: 'Homecoming' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.externalId).toBe('s4');
  });

  it('requires all supplied lookup fields, preserving artist scope', async () => {
    const a = new AudiomackAdapter({ dataset, clockIso: clock });
    expect(await a.findTrack({ title: 'Homecoming', artist: 'Different Artist' })).toEqual([]);
    expect(await a.findTrack({ title: 'Homecoming', artist: 'Lewis KE' })).toHaveLength(1);
  });

  it('rejects a catalog request whose profile identity conflicts with the resolved slug', async () => {
    const a = new AudiomackAdapter({ dataset, clockIso: clock });
    const snap = await a.listArtistCatalog({
      profile: { platform: 'audiomack', externalId: 'someone-else', slug: 'lewis_ke', url: null, name: 'Other Artist', confidence: 1 },
    });
    expect(snap.items).toEqual([]);
    expect(snap.pagination.complete).toBe(false);
    expect(snap.warnings.join(' ')).toMatch(/does not match/i);
  });
});
