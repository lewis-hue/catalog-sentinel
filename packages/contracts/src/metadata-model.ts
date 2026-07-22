/**
 * Canonical distributor metadata model.
 *
 * Lives in contracts because it crosses process boundaries (extractor → pipeline → persistence)
 * and because the durable store must be able to name these shapes without depending on the
 * package that produces them — persistence importing browser-assist would drag Playwright into
 * the database layer.
 *
 * Two corrections over the older shape, both load-bearing:
 *
 * 1. IDENTIFIER MODELING. UPC and artwork are RELEASE-level; ISRC is TRACK-level (a recording
 *    fingerprint). Flattening UPC onto tracks and reporting one combined "ISRC/UPC" number hid
 *    which extraction was actually failing.
 *
 * 2. FIELD-LEVEL STATUS. `null` is not enough: "the distributor has no ISRC for this track" and
 *    "our request timed out" are different facts with different remedies. Every field carries a
 *    status + provenance so the UI can say "Not captured — request timed out" instead of the
 *    false "Missing".
 */

/** Why a field does or doesn't have a value. NOT_CAPTURED must never be shown as "missing". */
export type MetadataFieldStatus =
  | 'PRESENT'
  | 'ABSENT_AT_SOURCE'
  | 'NOT_CAPTURED'
  | 'PARSE_FAILED'
  | 'REQUEST_FAILED'
  | 'TIMEOUT'
  | 'REAUTH_REQUIRED'
  | 'NOT_AUTHORIZED'
  | 'UNKNOWN';

/** Where a value came from — mirrors the extraction hierarchy (network JSON preferred). */
export type MetadataSource = 'OFFICIAL_API' | 'NETWORK_JSON' | 'DIRECT_JSON' | 'PAGE_STATE' | 'DOM' | 'CSV_IMPORT';

export interface MetadataField<T> {
  value?: T;
  status: MetadataFieldStatus;
  source: MetadataSource;
  capturedAt: string;
  parserVersion: string;
}

export interface CanonicalDistributorTrack {
  distributorTrackId?: string;
  title: string;
  /** TRACK-level recording identifier. */
  isrc: MetadataField<string>;
  trackNumber?: number;
  durationSec?: number;
}

export interface CanonicalDistributorRelease {
  distributorReleaseId: string;
  title: string;
  primaryArtist?: string;
  featuredArtists?: string[];
  /** RELEASE-level identifiers. */
  upc: MetadataField<string>;
  artworkUrl: MetadataField<string>;
  releaseDate: MetadataField<string>;
  uploadDate?: MetadataField<string>;
  label?: MetadataField<string>;
  tracks: CanonicalDistributorTrack[];
}

/**
 * Terminal outcome for ONE release. Every indexed release must end with one of these.
 *
 * `endpointFingerprint` is the sanitized identity hash of the endpoint that produced the data —
 * the durable link from a release back to the endpoint profile it came from. Without it, a
 * persisted release cannot answer "which endpoint served this, and is that endpoint still
 * healthy?", which is the question you need when a profile degrades and you must decide what to
 * re-read. It is a hash of shape only: never a URL with values in it.
 */
export type ReleaseExtractionOutcome =
  | { kind: 'COMPLETED'; release: CanonicalDistributorRelease; source: MetadataSource; elapsedMs: number; endpointFingerprint?: string }
  | { kind: 'FAILED'; distributorReleaseId: string; reason: ReleaseFailureReason; detail: string; elapsedMs: number; endpointFingerprint?: string }
  | { kind: 'SKIPPED'; distributorReleaseId: string; reason: string };

export type ReleaseFailureReason =
  | 'TIMEOUT'
  | 'REQUEST_FAILED'
  | 'PARSE_FAILED'
  | 'SCHEMA_CHANGED'
  | 'REAUTH_REQUIRED'
  | 'NOT_AUTHORIZED'
  | 'RATE_LIMITED'
  | 'BUDGET_EXHAUSTED'
  | 'UNKNOWN';
