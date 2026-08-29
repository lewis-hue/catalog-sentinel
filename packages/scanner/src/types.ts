import type { Page } from 'playwright';

/** Canonical store-status enum (spec "Store status enum"). */
export const STORE_STATUSES = [
  'SELECTED',
  'NOT_SELECTED',
  'UNKNOWN',
  'DELIVERED',
  'PROCESSING',
  'FAILED',
  'REMOVED',
  'TAKEDOWN',
  'NEEDS_ACTION',
  'CURATED_OR_NOT_GUARANTEED',
] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];

/** Canonical lyrics-status enum (spec "Lyrics status enum"). */
export const LYRICS_STATUSES = [
  'UNKNOWN',
  'MISSING',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'SYNCED_MISSING',
  'SYNCED_SUBMITTED',
  'NOT_SUPPORTED',
] as const;
export type LyricsStatusValue = (typeof LYRICS_STATUSES)[number];

export const CREDITS_STATUSES = ['UNKNOWN', 'MISSING', 'SUBMITTED', 'DISPLAYED', 'NOT_SUPPORTED'] as const;
export type CreditsStatusValue = (typeof CREDITS_STATUSES)[number];

export type DistributorProviderName = 'distrokid' | 'tunecore' | 'cdbaby' | 'unitedmasters' | 'ditto' | 'amuse' | 'routenote' | 'landr' | 'symphonic';

/** Provenance stamped on every scanned data point (spec: source, timestamp, confidence). */
export interface Provenance {
  sourceUrlCategory: string;
  scannedAt: string;
  confidence: number;
}

export interface ScanContext {
  baseUrl: string;
  minDelayMs: number;
  onEvent?: (event: ScanEvent) => void;
  /** Idempotency/resume checkpoint: releases already scanned. */
  scannedReleaseIds?: Set<string>;
}

export type ScanEvent =
  | { type: 'scan_started'; at: string }
  | { type: 'scan_progress'; at: string; percent: number; step: string }
  | { type: 'release_found'; at: string; releaseTitle: string }
  | { type: 'track_found'; at: string; trackTitle: string }
  | { type: 'scan_paused_needs_user'; at: string; reason: string }
  | { type: 'scan_completed'; at: string; releases: number; tracks: number }
  | { type: 'scan_failed'; at: string; error: string }
  | { type: 'page_shape_changed'; at: string; page: string };

export interface LoginValidationResult {
  loggedIn: boolean;
  reason?: string;
}

export interface ReleaseIndexItem {
  releaseId: string | null;
  title: string;
  artist: string | null;
  url: string;
}

export interface TrackIndexItem {
  trackId: string | null;
  title: string;
  url: string | null;
}

export interface StoreStatusSnapshot {
  store: string;
  status: StoreStatus;
  provenance: Provenance;
}

export interface LyricsStatusSnapshot {
  plain: LyricsStatusValue;
  synced: LyricsStatusValue;
  provenance: Provenance;
}

export interface CreditsStatusSnapshot {
  status: CreditsStatusValue;
  provenance: Provenance;
}

export interface DistributorTrackSnapshot {
  trackId: string | null;
  trackUrl: string | null;
  title: string;
  trackNumber: number | null;
  isrc: string | null;
  lyrics: LyricsStatusSnapshot;
  credits: CreditsStatusSnapshot;
  provenance: Provenance;
  rawSource: Record<string, unknown>;
}

export interface DistributorReleaseSnapshot {
  releaseId: string | null;
  releaseUrl: string;
  title: string;
  artist: string | null;
  upc: string | null;
  releaseDate: string | null;
  stores: StoreStatusSnapshot[];
  tracks: DistributorTrackSnapshot[];
  warnings: string[];
  provenance: Provenance;
}

/**
 * Distributor scanner contract (spec "DistroKid adapter"). Adapters own their
 * distributor-specific, resilient locators; the deep-scan worker orchestrates.
 * When a field cannot be read confidently, return UNKNOWN, never guess.
 */
export interface DistributorScanner {
  readonly distributor: DistributorProviderName;
  validateLoggedIn(page: Page): Promise<LoginValidationResult>;
  discoverCatalogIndex(page: Page, ctx: ScanContext): Promise<ReleaseIndexItem[]>;
  scanRelease(page: Page, release: ReleaseIndexItem, ctx: ScanContext): Promise<DistributorReleaseSnapshot>;
  scanStoreStatus(page: Page, release: ReleaseIndexItem, ctx: ScanContext): Promise<StoreStatusSnapshot[]>;
  scanLyricsStatus(page: Page, track: TrackIndexItem, ctx: ScanContext): Promise<LyricsStatusSnapshot>;
  scanCreditsStatus(page: Page, track: TrackIndexItem, ctx: ScanContext): Promise<CreditsStatusSnapshot>;
}

/** Thrown when a page shape is unrecognized, worker converts to a NEEDS_MAINTENANCE issue. */
export class PageShapeError extends Error {
  constructor(
    public readonly pageKind: string,
    message: string,
  ) {
    super(message);
    this.name = 'PageShapeError';
  }
}
