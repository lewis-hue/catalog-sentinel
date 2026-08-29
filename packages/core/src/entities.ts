import type {
  AlbumExtra,
  ConsentScope,
  CreditsState,
  DataSourceMode,
  DistributorProvider,
  DSPPlatform,
  IssueStatus,
  LyricsState,
  PresenceStatus,
  ScanStatus,
  StoreDeliveryStatus,
  UserRole,
} from './enums';
import type { ConfidenceBand } from './confidence';
import type { Isrc, Upc } from './identifiers';
import type { IssueReasonCode } from './reason-codes';
import type { Severity } from './severity';
import type {
  ArtistId,
  ArtistProfileId,
  AuditLogId,
  CatalogSnapshotId,
  ConsentGrantId,
  CredentialReferenceId,
  DistributorAccountId,
  DSPAccountId,
  EvidenceId,
  IssueId,
  ReleaseId,
  ScanJobId,
  ScanRunId,
  SupportPacketId,
  TenantId,
  TrackId,
  UserId,
  WorkspaceId,
} from './ids';

/** ISO-8601 timestamp string (kept as string for JSON/API portability). */
export type IsoTimestamp = string;

interface Timestamps {
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

// --- Tenancy & identity -----------------------------------------------------

export interface Tenant extends Timestamps {
  id: TenantId;
  name: string;
  /** Data-residency / plan hints; free-form for now. */
  plan: 'free' | 'pro' | 'label' | 'enterprise';
}

export interface User extends Timestamps {
  id: UserId;
  tenantId: TenantId;
  email: string;
  displayName: string;
  role: UserRole;
  mfaEnabled: boolean;
}

export interface Workspace extends Timestamps {
  id: WorkspaceId;
  tenantId: TenantId;
  name: string;
  /** The primary artist this workspace audits (workspaces are per-artist in MVP). */
  primaryArtistId: ArtistId | null;
}

export interface Artist extends Timestamps {
  id: ArtistId;
  workspaceId: WorkspaceId;
  name: string;
  aliases: ArtistAlias[];
  label: string | null;
  country: string | null;
  /** Confirmed DSP profile URLs/slugs keyed by platform. */
  profiles: ArtistProfile[];
}

export interface ArtistAlias {
  value: string;
  kind: 'alias' | 'legal-name' | 'former-name' | 'collaboration';
}

export interface ArtistProfile extends Timestamps {
  id: ArtistProfileId;
  artistId: ArtistId;
  platform: DSPPlatform;
  /** Platform-native artist id (e.g. Spotify artist id, Audiomack slug). */
  externalId: string | null;
  slug: string | null;
  url: string | null;
  confirmedByUser: boolean;
  isCanonical: boolean;
}

// --- Account connections (NEVER hold passwords, see CredentialReference) ----

export interface DistributorAccount extends Timestamps {
  id: DistributorAccountId;
  workspaceId: WorkspaceId;
  provider: DistributorProvider;
  displayLabel: string;
  ingestionMode: DataSourceMode;
  credentialReferenceId: CredentialReferenceId | null;
  connected: boolean;
}

export interface DSPAccount extends Timestamps {
  id: DSPAccountId;
  workspaceId: WorkspaceId;
  platform: DSPPlatform;
  displayLabel: string;
  ingestionMode: DataSourceMode;
  credentialReferenceId: CredentialReferenceId | null;
  connected: boolean;
}

/**
 * Opaque handle to a secret held by the KMS/Secrets abstraction. Stores a
 * provider + reference only. It NEVER stores a password or secret value.
 */
export interface CredentialReference extends Timestamps {
  id: CredentialReferenceId;
  workspaceId: WorkspaceId;
  provider: string;
  /** e.g. "aws-secretsmanager://…" or "local-kms://…". Not the secret itself. */
  secretHandle: string;
  kind: 'oauth-token' | 'api-key' | 'ephemeral-session' | 'none';
  expiresAt: IsoTimestamp | null;
}

// --- Catalog (distributor source of truth) ----------------------------------

export interface CatalogSnapshot extends Timestamps {
  id: CatalogSnapshotId;
  workspaceId: WorkspaceId;
  source: DistributorProvider | DSPPlatform;
  sourceMode: DataSourceMode;
  capturedAt: IsoTimestamp;
  releaseCount: number;
  trackCount: number;
  /** Free-form provenance notes (endpoint category, export filename, etc.). */
  notes: string | null;
}

export interface ReleaseIdentifier {
  type: 'upc' | 'distributor-release-id' | 'distributor-url' | 'dsp-album-id';
  platform?: DSPPlatform | DistributorProvider;
  value: string;
}

export interface TrackIdentifier {
  type:
    | 'isrc'
    | 'distributor-track-id'
    | 'spotify-track-id'
    | 'spotify-uri'
    | 'apple-song-id'
    | 'audiomack-music-id'
    | 'audiomack-song-slug'
    | 'youtube-video-id'
    | 'amazon-asin'
    | 'deezer-track-id'
    | 'tidal-track-id'
    | 'generic';
  platform?: DSPPlatform | DistributorProvider;
  value: string;
}

export interface Release extends Timestamps {
  id: ReleaseId;
  workspaceId: WorkspaceId;
  snapshotId: CatalogSnapshotId;
  title: string;
  primaryArtistName: string;
  upc: Upc | null;
  distributorReleaseId: string | null;
  distributorUrl: string | null;
  releaseDate: string | null; // ISO date (no time)
  label: string | null;
  identifiers: ReleaseIdentifier[];
  storeSelections: StoreSelection[];
  albumExtras: AlbumExtra[];
  trackIds: TrackId[];
}

export interface Track extends Timestamps {
  id: TrackId;
  workspaceId: WorkspaceId;
  releaseId: ReleaseId;
  title: string;
  /** Structured version info parsed from the title (remix/live/edit/etc.). */
  versionTags: string[];
  featuredArtists: string[];
  primaryArtistName: string;
  isrc: Isrc | null;
  trackNumber: number | null;
  durationSec: number | null;
  isExplicit: boolean | null;
  identifiers: TrackIdentifier[];
  lyrics: LyricsStatus | null;
  credits: CreditsStatus | null;
}

export interface StoreSelection {
  platform: DSPPlatform;
  status: StoreDeliveryStatus;
  observedAt: IsoTimestamp;
}

// --- DSP presence (observed on the platform side) ---------------------------

export interface DSPTrackPresence extends Timestamps {
  id: string;
  workspaceId: WorkspaceId;
  trackId: TrackId | null;
  platform: DSPPlatform;
  status: PresenceStatus;
  matchedExternalId: string | null;
  matchedUrl: string | null;
  matchedArtistProfileId: string | null;
  confidence: number;
  confidenceBand: ConfidenceBand;
  markets: string[];
  observedAt: IsoTimestamp;
}

export interface DSPReleasePresence extends Timestamps {
  id: string;
  workspaceId: WorkspaceId;
  releaseId: ReleaseId | null;
  platform: DSPPlatform;
  status: PresenceStatus;
  matchedExternalId: string | null;
  matchedUrl: string | null;
  confidence: number;
  confidenceBand: ConfidenceBand;
  observedAt: IsoTimestamp;
}

// --- Lyrics / credits -------------------------------------------------------

export interface LyricsStatus {
  plain: LyricsState;
  synced: LyricsState;
  /**
   * Status-only metadata. Copyrighted lyric TEXT is NOT stored here unless the
   * user explicitly provided/owns it (default: never). See docs/compliance.md.
   */
  textProvidedByOwner: boolean;
  observedAt: IsoTimestamp;
}

export interface CreditsStatus {
  state: CreditsState;
  hasSongwriter: boolean;
  hasProducer: boolean;
  observedAt: IsoTimestamp;
}

// --- Royalties / splits -----------------------------------------------------

export interface RoyaltyReport extends Timestamps {
  id: string;
  workspaceId: WorkspaceId;
  periodStart: string;
  periodEnd: string;
  source: DistributorProvider;
  lineItems: RoyaltyLineItem[];
}

export interface RoyaltyLineItem {
  platform: DSPPlatform;
  isrc: Isrc | null;
  streams: number | null;
  earnings: number | null;
  currency: string;
}

export interface SplitParticipant {
  email: string;
  name: string | null;
  percentage: number;
  accepted: boolean;
  role: 'artist' | 'producer' | 'writer' | 'other';
}

// --- Issues & evidence ------------------------------------------------------

export interface Issue extends Timestamps {
  id: IssueId;
  workspaceId: WorkspaceId;
  reasonCode: IssueReasonCode;
  severity: Severity;
  status: IssueStatus;
  platform: DSPPlatform | null;
  releaseId: ReleaseId | null;
  trackId: TrackId | null;
  summary: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  evidenceIds: EvidenceId[];
  recommendedAction: string;
}

/**
 * Evidence backing an issue (PRD §M). Records provenance WITHOUT secrets:
 * a source-mode/endpoint *category*, not URLs with tokens or credentials.
 */
export interface IssueEvidence extends Timestamps {
  id: EvidenceId;
  workspaceId: WorkspaceId;
  issueId: IssueId | null;
  snapshotId: CatalogSnapshotId | null;
  sourceMode: DataSourceMode;
  /** e.g. "audiomack:artist-uploads", a category, never a secret/token. */
  sourceEndpointCategory: string;
  scannedAt: IsoTimestamp;
  normalizedMetadata: Record<string, unknown>;
  matchCandidatesConsidered: number;
  confidence: number;
  confidenceBand: ConfidenceBand;
  reasonCode: IssueReasonCode;
  screenshotRef: string | null;
  remediation: string;
}

// --- Support packets --------------------------------------------------------

export interface SupportPacket extends Timestamps {
  id: SupportPacketId;
  workspaceId: WorkspaceId;
  template: string;
  targetAudience: 'distributor' | 'dsp';
  targetProvider: DistributorProvider | DSPPlatform;
  title: string;
  subject: string;
  bodyMarkdown: string;
  issueIds: IssueId[];
  artifactRefs: SupportPacketArtifactRef[];
}

export interface SupportPacketArtifactRef {
  format: 'csv' | 'html' | 'json' | 'pdf';
  /** Object-store reference or local path; downloaded via a signed URL in prod. */
  ref: string;
  byteSize: number;
}

// --- Scans, audit, consent, retention ---------------------------------------

export interface ScanJob extends Timestamps {
  id: ScanJobId;
  workspaceId: WorkspaceId;
  kind: string;
  params: Record<string, unknown>;
  schedule: 'on-demand' | 'daily' | 'weekly';
}

export interface ScanRun extends Timestamps {
  id: ScanRunId;
  scanJobId: ScanJobId;
  workspaceId: WorkspaceId;
  status: ScanStatus;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  /** Idempotency key so re-running the same scan is a no-op. */
  idempotencyKey: string;
  stats: Record<string, number>;
  error: string | null;
}

export interface AuditLog extends Timestamps {
  id: AuditLogId;
  tenantId: TenantId;
  workspaceId: WorkspaceId | null;
  actorUserId: UserId | null;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Redacted metadata only, never secrets or PII. */
  metadata: Record<string, unknown>;
}

export interface ConsentGrant extends Timestamps {
  id: ConsentGrantId;
  workspaceId: WorkspaceId;
  grantedByUserId: UserId;
  scopes: ConsentScope[];
  /** What data is accessed, why, and retention, shown to the user at grant. */
  purpose: string;
  retentionDays: number;
  grantedAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
}

export interface DataRetentionPolicy {
  workspaceId: WorkspaceId;
  snapshotRetentionDays: number;
  evidenceRetentionDays: number;
  screenshotRetentionDays: number;
  auditLogRetentionDays: number;
}
