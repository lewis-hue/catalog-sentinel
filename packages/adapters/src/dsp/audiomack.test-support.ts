import type { DataSourceMode } from '@sentinel/core';
import { RateLimiter } from '../rate-limit';
import { normalizeIsrc, normalizeTitle, sameArtist } from '../stores/types';
import {
  AdapterUnavailableError,
  type ArtistCatalogInput,
  type ArtistProfileCandidate,
  type AvailabilityInput,
  type AvailabilitySnapshot,
  type DSPAdapter,
  type DSPCapabilities,
  type DSPCatalogSnapshot,
  type DSPReleaseMatch,
  type DSPTrackMatch,
  type RawDSPItem,
  type ReleaseLookupInput,
  type ResolveArtistInput,
  type TrackLookupInput,
} from '../types';

const CAPABILITIES: DSPCapabilities = {
  supportsOfficialApi: true, // via the Audiomack Data API (requires app key/secret)
  supportsSearchByISRC: false, // Audiomack search is by artist/slug/text, not ISRC
  supportsSearchByUPC: false,
  supportsArtistUploads: true,
  supportsArtistDiscography: true,
  supportsTrackAvailabilityMarkets: false,
  supportsLyricsLookup: false,
  supportsProfileIssueReports: true,
  supportsOAuth: true,
};

/** Deterministic dataset used only by automated tests. */
export interface AudiomackDataset {
  profiles: Record<string, { profile: ArtistProfileCandidate; items: RawDSPItem[] }>;
}

export interface AudiomackAdapterOptions {
  /** Deterministic test data. */
  dataset?: AudiomackDataset;
  /** Real Audiomack Data API credentials. When present (and no dataset), the
   *  adapter would call the live API, currently a documented TODO stub. */
  apiKey?: string;
  apiSecret?: string;
  pageSize?: number;
  ratePerMinute?: number;
  clockIso?: () => string;
  now?: () => number;
}

/**
 * Audiomack DSP contract double used by deterministic workflow tests. Runtime scans use
 * AudiomackStoreProvider, which calls the signed Audiomack Data API.
 */
export class AudiomackAdapter implements DSPAdapter {
  readonly platform = 'audiomack' as const;
  readonly capabilities = CAPABILITIES;
  private readonly sourceMode: DataSourceMode;
  private readonly pageSize: number;
  private readonly limiter: RateLimiter;
  private readonly clockIso: () => string;

  constructor(private readonly opts: AudiomackAdapterOptions = {}) {
    this.sourceMode = 'test-fixture';
    this.pageSize = Math.max(1, Math.floor(opts.pageSize ?? 25));
    this.clockIso = opts.clockIso ?? (() => new Date().toISOString());
    this.limiter = new RateLimiter(opts.ratePerMinute ?? 60, opts.ratePerMinute ?? 60, opts.now);
  }

  async resolveArtist(input: ResolveArtistInput): Promise<ArtistProfileCandidate[]> {
    const ds = this.requireDataset('resolveArtist');
    const slug = input.slug ?? this.slugFromUrl(input.url);
    if (slug && ds.profiles[slug]) {
      return [ds.profiles[slug]!.profile];
    }
    if (input.name) {
      const q = input.name.toLowerCase();
      return Object.values(ds.profiles)
        .map((p) => p.profile)
        .filter((p) => p.name.toLowerCase().includes(q));
    }
    return [];
  }

  async listArtistCatalog(input: ArtistCatalogInput): Promise<DSPCatalogSnapshot> {
    const ds = this.requireDataset('listArtistCatalog');
    const slug = input.profile.slug ?? this.slugFromUrl(input.profile.url);
    const entry = slug ? ds.profiles[slug] : undefined;
    const capturedAt = this.clockIso();

    if (!entry) {
      // Profile not found on Audiomack, report clearly, never fabricate uploads.
      return {
        platform: this.platform,
        sourceMode: this.sourceMode,
        capturedAt,
        artistProfile: input.profile,
        items: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: [`No Audiomack profile found for slug "${slug ?? '(unknown)'}"; absence cannot be verified.`],
      };
    }

    const externalIdMismatch = Boolean(
      input.profile.externalId
      && entry.profile.externalId
      && input.profile.externalId !== entry.profile.externalId,
    );
    if (externalIdMismatch || !sameArtist(input.profile.name, entry.profile.name)) {
      return {
        platform: this.platform,
        sourceMode: this.sourceMode,
        capturedAt,
        artistProfile: input.profile,
        items: [],
        pagination: { total: null, fetched: 0, complete: false },
        warnings: ['Resolved Audiomack profile does not match the requested artist identity; absence cannot be verified.'],
      };
    }

    // Simulate paginated fetch of artist uploads, honoring the rate limiter.
    const all = entry.items.filter((item) => !entry.profile.externalId || !item.artistProfileId || item.artistProfileId === entry.profile.externalId);
    const requestedCap = input.maxItems ?? all.length;
    const cap = Number.isFinite(requestedCap) ? Math.max(0, Math.floor(requestedCap)) : all.length;
    const collected: RawDSPItem[] = [];
    for (let offset = 0; offset < all.length && collected.length < cap; offset += this.pageSize) {
      if (!this.limiter.tryRemove()) {
        // Tests record backpressure deterministically instead of sleeping.
        return {
          platform: this.platform,
          sourceMode: this.sourceMode,
          capturedAt,
          artistProfile: entry.profile,
          items: collected,
          pagination: { total: all.length, fetched: collected.length, complete: false },
          warnings: ['Rate limit reached before the full catalog was fetched.'],
        };
      }
      collected.push(...all.slice(offset, offset + this.pageSize).slice(0, cap - collected.length));
    }

    const complete = collected.length >= all.length;
    return {
      platform: this.platform,
      sourceMode: this.sourceMode,
      capturedAt,
      artistProfile: entry.profile,
      items: collected,
      pagination: { total: all.length, fetched: collected.length, complete },
      warnings: complete ? [] : [`Catalog stopped at the configured maxItems cap (${cap}); absence cannot be verified.`],
    };
  }

  async findTrack(input: TrackLookupInput): Promise<DSPTrackMatch[]> {
    const ds = this.requireDataset('findTrack');
    const title = input.title ? normalizeTitle(input.title) : null;
    const artist = input.artist?.trim() || null;
    const isrc = normalizeIsrc(input.isrc);
    const hasCriterion = Boolean(title || artist || isrc || input.durationSec != null);
    if (!hasCriterion) return [];
    const results: RawDSPItem[] = [];
    for (const { items } of Object.values(ds.profiles)) {
      for (const it of items) {
        if (it.kind !== 'song') continue;
        if (title && normalizeTitle(it.title) !== title) continue;
        if (artist && !sameArtist(it.primaryArtist, artist) && !it.featuredArtists.some((credit) => sameArtist(credit, artist))) continue;
        if (isrc && normalizeIsrc(it.isrc) !== isrc) continue;
        if (input.durationSec != null && (it.durationSec == null || Math.abs(it.durationSec - input.durationSec) > 2)) continue;
        results.push(it);
      }
    }
    return results;
  }

  async findRelease(input: ReleaseLookupInput): Promise<DSPReleaseMatch[]> {
    const ds = this.requireDataset('findRelease');
    const title = input.title ? normalizeTitle(input.title) : null;
    const artist = input.artist?.trim() || null;
    const upc = normalizeUpc(input.upc);
    if (!title && !artist && !upc) return [];
    const results: RawDSPItem[] = [];
    for (const { items } of Object.values(ds.profiles)) {
      for (const it of items) {
        if (it.kind !== 'album') continue;
        if (title && normalizeTitle(it.title) !== title) continue;
        if (artist && !sameArtist(it.primaryArtist, artist) && !it.featuredArtists.some((credit) => sameArtist(credit, artist))) continue;
        if (upc && normalizeUpc(it.upc) !== upc) continue;
        results.push(it);
      }
    }
    return results;
  }

  async getAvailability(input: AvailabilityInput): Promise<AvailabilitySnapshot> {
    const ds = this.requireDataset('getAvailability');
    for (const { items } of Object.values(ds.profiles)) {
      const found = items.find((i) => i.externalId === input.externalId);
      if (found) return { externalId: found.externalId, markets: found.markets, status: found.status };
    }
    return { externalId: input.externalId, markets: [], status: 'missing' };
  }

  private requireDataset(op: string): AudiomackDataset {
    if (this.opts.dataset) return this.opts.dataset;
    // Test construction must always provide deterministic data.
    throw new AdapterUnavailableError(
      'audiomack',
      this.opts.apiKey ? 'official-api' : 'unconfigured',
      this.opts.apiKey
        ? `Test adapter cannot use API credentials (op: ${op}).`
        : `Audiomack test data was not provided (op: ${op}).`,
    );
  }

  private slugFromUrl(url: string | null | undefined): string | undefined {
    if (!url) return undefined;
    const m = url.match(/audiomack\.com\/([^/?#]+)/i);
    return m?.[1];
  }
}

function normalizeUpc(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}
