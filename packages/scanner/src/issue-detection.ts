import type { Severity } from '@sentinel/core';
import type { CanonicalRelease, CanonicalTrack } from './normalization';

export type ScanIssueCode =
  | 'MISSING_ISRC'
  | 'MISSING_UPC'
  | 'MISSING_PLAIN_LYRICS'
  | 'MISSING_SYNCED_LYRICS'
  | 'MISSING_CREDITS'
  | 'NOT_SELECTED_FOR_AUDIOMACK'
  | 'AUDIOMACK_DELIVERY_FAILED_OR_UNKNOWN'
  | 'RELEASE_PROCESSING_TOO_LONG'
  | 'SUPPORT_DATA_INCOMPLETE';

export interface ScanIssue {
  code: ScanIssueCode;
  severity: Severity;
  subjectType: 'release' | 'track';
  subjectId: string;
  summary: string;
  evidence: Record<string, unknown>;
}

const AUDIOMACK_KEYS = new Set(['audiomack']);

export interface DetectInput {
  releases: CanonicalRelease[];
  tracks: CanonicalTrack[];
  /** Now, for the processing-delay rule. */
  nowMs?: number;
}

/**
 * Post-scan issue detection over the canonical catalog (spec "Issue detection").
 * Availability rules that need a DSP comparison (e.g. missing-on-Audiomack) are
 * produced later by the DSP-comparison layer; these are the distributor-side
 * rules derivable from the scan itself.
 */
export function detectDistributorIssues(input: DetectInput): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const releaseById = new Map(input.releases.map((r) => [r.id, r]));

  for (const t of input.tracks) {
    if (!t.isrc) {
      issues.push(issue('MISSING_ISRC', 'high', 'track', t.id, `Track "${t.title}" has no ISRC.`, { releaseTitle: t.releaseTitle }));
    }
    if (t.lyricsStatus === 'MISSING') {
      issues.push(issue('MISSING_PLAIN_LYRICS', 'medium', 'track', t.id, `Track "${t.title}" is missing plain lyrics.`, {}));
    }
    if (t.syncedLyricsStatus === 'SYNCED_MISSING') {
      issues.push(issue('MISSING_SYNCED_LYRICS', 'medium', 'track', t.id, `Track "${t.title}" is missing synced lyrics.`, {}));
    }
    if (t.creditsStatus === 'MISSING') {
      issues.push(issue('MISSING_CREDITS', 'medium', 'track', t.id, `Track "${t.title}" is missing credits.`, {}));
    }
  }

  for (const r of input.releases) {
    if (!r.upc) {
      issues.push(issue('MISSING_UPC', 'high', 'release', r.id, `Release "${r.title}" has no UPC.`, {}));
    }
    const audiomack = r.stores.find((s) => AUDIOMACK_KEYS.has(s.normalizedStore));
    if (!audiomack || audiomack.status === 'NOT_SELECTED') {
      issues.push(
        issue('NOT_SELECTED_FOR_AUDIOMACK', 'high', 'release', r.id, `Release "${r.title}" is not selected for Audiomack.`, {
          audiomackStatus: audiomack?.status ?? 'not-listed',
        }),
      );
    } else if (audiomack.status === 'FAILED' || audiomack.status === 'UNKNOWN' || audiomack.status === 'NEEDS_ACTION') {
      issues.push(
        issue('AUDIOMACK_DELIVERY_FAILED_OR_UNKNOWN', 'high', 'release', r.id, `Release "${r.title}" Audiomack delivery is ${audiomack.status}.`, {
          audiomackStatus: audiomack.status,
        }),
      );
    }
    void releaseById;
  }

  return issues;
}

function issue(code: ScanIssueCode, severity: Severity, subjectType: ScanIssue['subjectType'], subjectId: string, summary: string, evidence: Record<string, unknown>): ScanIssue {
  return { code, severity, subjectType, subjectId, summary, evidence };
}
