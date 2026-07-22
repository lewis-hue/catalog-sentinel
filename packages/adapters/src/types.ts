import type {
  AlbumExtra,
  CreditsState,
  DataSourceMode,
  DistributorProvider,
  DSPPlatform,
  LyricsState,
  PresenceStatus,
  StoreDeliveryStatus,
} from '@sentinel/core';

// ============================================================================
// Adapter-facing DTOs. Adapters emit these "raw" shapes; the engine maps them
// onto the canonical @sentinel/core entities. Keeping them separate means an
// adapter never needs to mint domain ids or know about persistence.
// ============================================================================

export interface RawDistributorTrack {
  distributorTrackId: string | null;
  title: string;
  primaryArtist: string;
  featuredArtists: string[];
  isrc: string | null;
  trackNumber: number | null;
  durationSec: number | null;
  isExplicit: boolean | null;
  lyrics?: { plain: LyricsState; synced: LyricsState } | null;
  credits?: { state: CreditsState; hasSongwriter: boolean; hasProducer: boolean } | null;
}

export interface RawDistributorRelease {
  distributorReleaseId: string | null;
  title: string;
  primaryArtist: string;
  upc: string | null;
  releaseDate: string | null;
  /** Date the release was uploaded/added at the distributor (distinct from the DSP release date). */
  uploadDate: string | null;
  distributorUrl: string | null;
  label: string | null;
  /** Release cover art URL (highest-res found on the distributor's release page). */
  artworkUrl?: string | null;
  storeSelections: Array<{ platform: DSPPlatform; status: StoreDeliveryStatus }>;
  albumExtras: AlbumExtra[];
  tracks: RawDistributorTrack[];
}

export interface DistributorCatalogSnapshot {
  provider: DistributorProvider;
  sourceMode: DataSourceMode;
  capturedAt: string;
  artistName: string | null;
  releases: RawDistributorRelease[];
  /** Non-fatal issues surfaced during ingestion (unmapped columns, etc.). */
  warnings: string[];
}

export interface CatalogDiscoveryInput {
  /** Raw CSV/export text for import modes. */
  csvText?: string;
  artistName?: string;
  /** Opaque handle to an authorized session/token; NEVER a password. */
  credentialHandle?: string;
}

export type ReleaseDetails = RawDistributorRelease;
export type TrackDetails = RawDistributorTrack;

export interface StoreSelectionStatus {
  platform: DSPPlatform;
  status: StoreDeliveryStatus;
  observedAt: string;
}

export interface LyricsStatusResult {
  plain: LyricsState;
  synced: LyricsState;
  observedAt: string;
}

export interface CreditsStatusResult {
  state: CreditsState;
  hasSongwriter: boolean;
  hasProducer: boolean;
  observedAt: string;
}

export interface RoyaltyReportInput {
  periodStart: string;
  periodEnd: string;
  credentialHandle?: string;
}

export interface RoyaltyReportSnapshot {
  provider: DistributorProvider;
  periodStart: string;
  periodEnd: string;
  lineItems: Array<{ platform: DSPPlatform; isrc: string | null; streams: number | null; earnings: number | null; currency: string }>;
  warnings: string[];
}

export interface DistributorCapabilities {
  supportsOfficialApi: boolean;
  supportsCsvImport: boolean;
  supportsUserExport: boolean;
  supportsAttendedBrowserAssist: boolean;
  supportsLyricsStatus: boolean;
  supportsStoreSelectionStatus: boolean;
  supportsCreditsStatus: boolean;
  supportsRoyaltyReports: boolean;
  supportsSplits: boolean;
}

/**
 * Distributor adapter contract (PRD §B). Implementations declare capabilities;
 * an unavailable path throws {@link AdapterUnavailableError} rather than
 * fabricating data. `discoverCatalog` is the entry point for the MVP.
 */
export interface DistributorAdapter {
  readonly provider: DistributorProvider;
  readonly capabilities: DistributorCapabilities;
  discoverCatalog(input: CatalogDiscoveryInput): Promise<DistributorCatalogSnapshot>;
  discoverReleaseDetails(releaseId: string): Promise<ReleaseDetails>;
  discoverTrackDetails(trackId: string): Promise<TrackDetails>;
  discoverStoreSelection(releaseId: string): Promise<StoreSelectionStatus[]>;
  discoverLyricsStatus(trackId: string): Promise<LyricsStatusResult>;
  discoverCreditsStatus(trackId: string): Promise<CreditsStatusResult>;
  discoverRoyaltyReports?(input: RoyaltyReportInput): Promise<RoyaltyReportSnapshot>;
}

// ---------------------------------------------------------------------------
// DSP side (PRD §C)
// ---------------------------------------------------------------------------

export interface ArtistProfileCandidate {
  platform: DSPPlatform;
  externalId: string | null;
  slug: string | null;
  url: string | null;
  name: string;
  confidence: number;
  followerCount?: number | null;
  verified?: boolean | null;
}

export interface RawDSPItem {
  externalId: string;
  url: string | null;
  title: string;
  primaryArtist: string;
  featuredArtists: string[];
  isrc: string | null;
  upc: string | null;
  durationSec: number | null;
  kind: 'song' | 'album';
  status: PresenceStatus;
  artistProfileId: string | null;
  markets: string[];
}

export interface DSPCatalogSnapshot {
  platform: DSPPlatform;
  sourceMode: DataSourceMode;
  capturedAt: string;
  artistProfile: ArtistProfileCandidate | null;
  items: RawDSPItem[];
  pagination: { total: number | null; fetched: number; complete: boolean };
  warnings: string[];
}

export interface ResolveArtistInput {
  slug?: string;
  name?: string;
  url?: string;
}

export interface ArtistCatalogInput {
  profile: ArtistProfileCandidate;
  /** Cap total items fetched (rate-limit friendliness); adapters may paginate. */
  maxItems?: number;
}

export interface TrackLookupInput {
  isrc?: string | null;
  title?: string;
  artist?: string;
  durationSec?: number | null;
}

export type DSPTrackMatch = RawDSPItem;

export interface ReleaseLookupInput {
  upc?: string | null;
  title?: string;
  artist?: string;
}

export type DSPReleaseMatch = RawDSPItem;

export interface AvailabilityInput {
  externalId: string;
}

export interface AvailabilitySnapshot {
  externalId: string;
  markets: string[];
  status: PresenceStatus;
}

export interface DSPCapabilities {
  supportsOfficialApi: boolean;
  supportsSearchByISRC: boolean;
  supportsSearchByUPC: boolean;
  supportsArtistUploads: boolean;
  supportsArtistDiscography: boolean;
  supportsTrackAvailabilityMarkets: boolean;
  supportsLyricsLookup: boolean;
  supportsProfileIssueReports: boolean;
  supportsOAuth: boolean;
}

/** DSP adapter contract (PRD §C). */
export interface DSPAdapter {
  readonly platform: DSPPlatform;
  readonly capabilities: DSPCapabilities;
  resolveArtist(input: ResolveArtistInput): Promise<ArtistProfileCandidate[]>;
  listArtistCatalog(input: ArtistCatalogInput): Promise<DSPCatalogSnapshot>;
  findTrack(input: TrackLookupInput): Promise<DSPTrackMatch[]>;
  findRelease(input: ReleaseLookupInput): Promise<DSPReleaseMatch[]>;
  getAvailability?(input: AvailabilityInput): Promise<AvailabilitySnapshot>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an adapter path exists but is not usable (no creds, disabled). */
export class AdapterUnavailableError extends Error {
  constructor(
    public readonly adapter: string,
    public readonly mode: string,
    message?: string,
  ) {
    super(message ?? `${adapter} adapter path "${mode}" is unavailable in this environment.`);
    this.name = 'AdapterUnavailableError';
  }
}

/** Thrown for malformed input (e.g. an unparseable CSV). */
export class AdapterInputError extends Error {
  constructor(
    public readonly adapter: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterInputError';
  }
}
