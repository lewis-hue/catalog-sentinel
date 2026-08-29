import type { ConfidenceBand, IssueReasonCode, Severity } from '@sentinel/core';

/** One row of a support packet's evidence table (e.g. a missing Audiomack song). */
export interface PacketRow {
  releaseTitle: string;
  trackTitle: string;
  isrc: string | null;
  upc: string | null;
  distributorUrl: string | null;
  releaseDate: string | null;
  /** Expected state per the distributor source of truth, e.g. "Selected for Audiomack". */
  expectedStatus: string;
  /** Platform-side evidence, e.g. "Absent from 132 scanned uploads and search". */
  evidence: string;
  confidence: number;
  confidenceBand: ConfidenceBand;
  reasonCode: IssueReasonCode;
  severity: Severity;
  remediation: string;
}

export type PacketTemplateId =
  | 'distrokid-missing-audiomack'
  | 'wrong-artist-profile'
  | 'duplicate-artist-profile'
  | 'foreign-content-on-profile'
  | 'missing-lyrics'
  | 'credits-not-showing'
  | 'metadata-rejection'
  | 'takedown-dispute'
  | 'royalty-anomaly'
  | 'splits-issue'
  | 'audiomack-verify';

/**
 * Everything a support packet needs, deliberately free of secrets. The
 * `distributorAccountRef` is an account LABEL or masked email, never a password.
 */
export interface SupportPacketData {
  template: PacketTemplateId;
  targetAudience: 'distributor' | 'dsp';
  targetProvider: string;
  artistName: string;
  distributorAccountRef: string;
  audiomackProfileUrl: string | null;
  incorrectProfileUrl?: string | null;
  correctProfileUrl?: string | null;
  affectedPlatform?: string | null;
  scanTimestamp: string;
  rows: PacketRow[];
  summary?: string;
  requestedAction?: string;
}

export interface GeneratedArtifact {
  format: 'csv' | 'html' | 'json';
  filename: string;
  content: string;
  byteSize: number;
}

export interface GeneratedPacket {
  subject: string;
  bodyMarkdown: string;
  artifacts: GeneratedArtifact[];
  missingCount: number;
}
