import type { CreditsState, DataSourceMode, DistributorProvider, LyricsState, StoreDeliveryStatus } from '@sentinel/core';
import { parseCsv } from '../csv';
import { parseStoreList } from '../platform-names';
import { resolveColumns, type ColumnMap } from './column-map';
import {
  AdapterInputError,
  AdapterUnavailableError,
  type CatalogDiscoveryInput,
  type CreditsStatusResult,
  type DistributorAdapter,
  type DistributorCapabilities,
  type DistributorCatalogSnapshot,
  type LyricsStatusResult,
  type RawDistributorRelease,
  type RawDistributorTrack,
  type ReleaseDetails,
  type StoreSelectionStatus,
  type TrackDetails,
} from '../types';

const CAPABILITIES: DistributorCapabilities = {
  supportsOfficialApi: false,
  supportsCsvImport: true,
  supportsUserExport: true,
  supportsAttendedBrowserAssist: false,
  supportsLyricsStatus: true,
  supportsStoreSelectionStatus: true,
  supportsCreditsStatus: true,
  supportsRoyaltyReports: false,
  supportsSplits: false,
};

const TRUTHY = new Set(['yes', 'y', 'true', '1', 'x', 'selected', '✓', 'live', 'delivered', 'on']);

function isTruthy(v: string | undefined): boolean {
  return v != null && TRUTHY.has(v.trim().toLowerCase());
}

/** Parse "3:45" (m:ss / h:mm:ss) or a raw seconds value. */
export function parseDuration(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v === '') return null;
  if (v.includes(':')) {
    const parts = v.split(':').map((p) => Number(p.trim()));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parsePlainLyrics(raw: string | undefined): LyricsState {
  const v = (raw ?? '').toLowerCase();
  if (v.includes('reject')) return 'rejected';
  if (v.includes('not visible') || v.includes('notvisible')) return 'submitted-not-visible';
  if (v.includes('approv')) return 'plain-approved';
  if (isTruthy(raw) || v.includes('submit') || v.includes('plain')) return 'plain-submitted';
  return 'none';
}

function parseSyncedLyrics(raw: string | undefined): LyricsState {
  const v = (raw ?? '').toLowerCase();
  if (v.includes('reject')) return 'rejected';
  if (v.includes('approv')) return 'synced-approved';
  if (isTruthy(raw) || v.includes('submit') || v.includes('synced')) return 'synced-submitted';
  return 'none';
}

function splitFeatured(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/,|&|\/|\bfeat\.?\b|\bft\.?\b|\bx\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Generic distributor CSV adapter. Ingests a user-uploaded/distributor-provided
 * export with flexible column mapping and groups rows into releases + tracks.
 * The DistroKid adapter subclasses this for CSV mode. No network access; the
 * whole catalog is returned in one snapshot.
 */
export class GenericCsvDistributorAdapter implements DistributorAdapter {
  readonly capabilities = CAPABILITIES;
  private lastSnapshot: DistributorCatalogSnapshot | null = null;

  constructor(
    public readonly provider: DistributorProvider = 'generic-csv',
    protected readonly sourceMode: DataSourceMode = 'csv-import',
    private readonly clockIso: () => string = () => new Date().toISOString(),
  ) {}

  async discoverCatalog(input: CatalogDiscoveryInput): Promise<DistributorCatalogSnapshot> {
    if (!input.csvText || input.csvText.trim() === '') {
      throw new AdapterInputError(this.provider, 'No CSV text provided for import.');
    }
    const snapshot = this.parseCatalog(input.csvText, input.artistName ?? null);
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Pure parse — exposed for testing and reuse without touching instance state. */
  parseCatalog(csvText: string, artistName: string | null): DistributorCatalogSnapshot {
    const { headers, rows } = parseCsv(csvText);
    if (headers.length === 0) throw new AdapterInputError(this.provider, 'CSV had no header row.');
    const cols = resolveColumns(headers);
    const warnings = this.collectWarnings(cols);

    const releasesByKey = new Map<string, RawDistributorRelease>();
    const capturedAt = this.clockIso();

    rows.forEach((row, index) => {
      const track = this.buildTrack(row, cols);
      const releaseTitle = this.cell(row, cols, 'releaseTitle') || track.title;
      const upc = this.cell(row, cols, 'upc') || null;
      const releaseId = this.cell(row, cols, 'releaseId') || null;
      const key = (upc || releaseId || releaseTitle).toLowerCase();

      let release = releasesByKey.get(key);
      if (!release) {
        release = this.buildRelease(row, cols, releaseTitle, upc, releaseId, capturedAt, artistName);
        releasesByKey.set(key, release);
      }
      // Assign a track number if the CSV omitted one.
      if (track.trackNumber == null) track.trackNumber = release.tracks.length + 1;
      release.tracks.push(track);
      void index;
    });

    const releases = [...releasesByKey.values()];
    return {
      provider: this.provider,
      sourceMode: this.sourceMode,
      capturedAt,
      artistName: artistName ?? releases[0]?.primaryArtist ?? null,
      releases,
      warnings,
    };
  }

  private buildRelease(
    row: Record<string, string>,
    cols: ColumnMap,
    title: string,
    upc: string | null,
    releaseId: string | null,
    capturedAt: string,
    artistName: string | null,
  ): RawDistributorRelease {
    const storeCodes = parseStoreList(this.cell(row, cols, 'stores'));
    const audiomackOptIn = isTruthy(this.cell(row, cols, 'audiomackFlag'));
    const storeStatus: StoreDeliveryStatus = 'selected';
    const selections = storeCodes.map((platform) => ({ platform, status: storeStatus }));
    if (audiomackOptIn && !storeCodes.includes('audiomack')) {
      selections.push({ platform: 'audiomack', status: 'selected' });
    }
    const albumExtras = audiomackOptIn || storeCodes.includes('audiomack') ? (['audiomack-opt-in'] as const) : [];

    return {
      distributorReleaseId: releaseId,
      title,
      primaryArtist: this.cell(row, cols, 'primaryArtist') || artistName || 'Unknown Artist',
      upc,
      releaseDate: this.cell(row, cols, 'releaseDate') || null,
      uploadDate: this.cell(row, cols, 'uploadDate') || null,
      distributorUrl: this.cell(row, cols, 'distributorUrl') || null,
      label: this.cell(row, cols, 'label') || null,
      storeSelections: selections,
      albumExtras: [...albumExtras],
      tracks: [],
    };
  }

  private buildTrack(row: Record<string, string>, cols: ColumnMap): RawDistributorTrack {
    const credits = this.buildCredits(row, cols);
    return {
      distributorTrackId: this.cell(row, cols, 'releaseId') ? `${this.cell(row, cols, 'releaseId')}` : null,
      title: this.cell(row, cols, 'trackTitle') || 'Untitled',
      primaryArtist: this.cell(row, cols, 'primaryArtist') || 'Unknown Artist',
      featuredArtists: splitFeatured(this.cell(row, cols, 'featuredArtists')),
      isrc: this.cell(row, cols, 'isrc') || null,
      trackNumber: this.parseTrackNumber(this.cell(row, cols, 'trackNumber')),
      durationSec: parseDuration(this.cell(row, cols, 'duration')),
      isExplicit: cols.isExplicit ? isTruthy(this.cell(row, cols, 'isExplicit')) : null,
      lyrics: cols.plainLyrics || cols.syncedLyrics ? {
        plain: parsePlainLyrics(this.cell(row, cols, 'plainLyrics')),
        synced: parseSyncedLyrics(this.cell(row, cols, 'syncedLyrics')),
      } : null,
      credits,
    };
  }

  private buildCredits(row: Record<string, string>, cols: ColumnMap): RawDistributorTrack['credits'] {
    if (!cols.credits && !cols.songwriter && !cols.producer) return null;
    const hasSongwriter = cols.songwriter ? this.cell(row, cols, 'songwriter').trim() !== '' : false;
    const hasProducer = cols.producer ? this.cell(row, cols, 'producer').trim() !== '' : false;
    const creditsCol = this.cell(row, cols, 'credits');
    let state: CreditsState = 'none';
    if (creditsCol.toLowerCase().includes('display')) state = 'displayed';
    else if (hasSongwriter || hasProducer || isTruthy(creditsCol)) state = 'submitted';
    return { state, hasSongwriter, hasProducer };
  }

  private parseTrackNumber(raw: string): number | null {
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  }

  private cell(row: Record<string, string>, cols: ColumnMap, logical: keyof ColumnMap): string {
    const header = cols[logical];
    return header ? (row[header] ?? '') : '';
  }

  private collectWarnings(cols: ColumnMap): string[] {
    const warnings: string[] = [];
    if (!cols.trackTitle) warnings.push('No track/song title column detected — using "Untitled".');
    if (!cols.isrc) warnings.push('No ISRC column detected — ISRC-based matching will be unavailable.');
    if (!cols.upc) warnings.push('No UPC column detected — releases grouped by title.');
    if (!cols.stores && !cols.audiomackFlag) {
      warnings.push('No store-selection column detected — store coverage cannot be verified from the export.');
    }
    return warnings;
  }

  // --- Detail lookups operate on the last imported snapshot -------------------

  private requireSnapshot(): DistributorCatalogSnapshot {
    if (!this.lastSnapshot) {
      throw new AdapterUnavailableError(this.provider, 'detail-lookup', 'Import a catalog with discoverCatalog first.');
    }
    return this.lastSnapshot;
  }

  async discoverReleaseDetails(releaseId: string): Promise<ReleaseDetails> {
    const snap = this.requireSnapshot();
    const found = snap.releases.find(
      (r) => r.distributorReleaseId === releaseId || r.title.toLowerCase() === releaseId.toLowerCase(),
    );
    if (!found) throw new AdapterInputError(this.provider, `Release not found in imported catalog: ${releaseId}`);
    return found;
  }

  async discoverTrackDetails(trackId: string): Promise<TrackDetails> {
    const snap = this.requireSnapshot();
    for (const r of snap.releases) {
      const t = r.tracks.find((t) => t.distributorTrackId === trackId || t.title.toLowerCase() === trackId.toLowerCase());
      if (t) return t;
    }
    throw new AdapterInputError(this.provider, `Track not found in imported catalog: ${trackId}`);
  }

  async discoverStoreSelection(releaseId: string): Promise<StoreSelectionStatus[]> {
    const rel = await this.discoverReleaseDetails(releaseId);
    const observedAt = this.clockIso();
    return rel.storeSelections.map((s) => ({ ...s, observedAt }));
  }

  async discoverLyricsStatus(trackId: string): Promise<LyricsStatusResult> {
    const track = await this.discoverTrackDetails(trackId);
    return {
      plain: track.lyrics?.plain ?? 'unknown',
      synced: track.lyrics?.synced ?? 'unknown',
      observedAt: this.clockIso(),
    };
  }

  async discoverCreditsStatus(trackId: string): Promise<CreditsStatusResult> {
    const track = await this.discoverTrackDetails(trackId);
    return {
      state: track.credits?.state ?? 'unknown',
      hasSongwriter: track.credits?.hasSongwriter ?? false,
      hasProducer: track.credits?.hasProducer ?? false,
      observedAt: this.clockIso(),
    };
  }
}
