import type { Severity } from './severity';

/**
 * Canonical issue reason codes (PRD §M). Every detected discrepancy carries
 * exactly one of these. The registry below attaches human-facing metadata,
 * a default severity, and a remediation hint used by the reports package.
 */
export const ISSUE_REASON_CODES = [
  'MISSING_ON_PLATFORM',
  'NOT_SELECTED_FOR_STORE',
  'AUDIOMACK_NOT_CONNECTED',
  'WRONG_ARTIST_PROFILE',
  'DUPLICATE_ARTIST_PROFILE',
  'FOREIGN_CONTENT_ON_PROFILE',
  'MISSING_PLAIN_LYRICS',
  'MISSING_SYNCED_LYRICS',
  'LYRICS_REJECTED',
  'CREDITS_MISSING',
  'ISRC_MISSING',
  'UPC_MISSING',
  'DUPLICATE_ISRC',
  'PROCESSING_DELAY',
  'COVER_LICENSE_DELAY',
  'CURATED_CATALOG',
  'TERRITORY_RESTRICTION',
  'CONTENT_ID_CONFLICT',
  'METADATA_REJECTION',
  'TAKEDOWN_OR_REMOVAL',
  'ROYALTY_STATS_ANOMALY',
  'SPLITS_ACTION_REQUIRED',
  'SUPPORT_DATA_INCOMPLETE',
  'UNKNOWN_NEEDS_REVIEW',
] as const;
export type IssueReasonCode = (typeof ISSUE_REASON_CODES)[number];

export interface ReasonCodeMeta {
  code: IssueReasonCode;
  title: string;
  description: string;
  defaultSeverity: Severity;
  category: 'availability' | 'identity' | 'lyrics' | 'credits' | 'identifier' | 'rights' | 'royalty' | 'process';
  /** Short, action-oriented remediation used in support packets. */
  remediation: string;
}

export const REASON_CODE_REGISTRY: Record<IssueReasonCode, ReasonCodeMeta> = {
  MISSING_ON_PLATFORM: {
    code: 'MISSING_ON_PLATFORM',
    title: 'Missing on platform',
    description:
      'The track/release exists in the distributor source of truth and is expected on this DSP, but no matching item was found.',
    defaultSeverity: 'critical',
    category: 'availability',
    remediation: 'Ask the distributor to redeliver/reinstate the release, or confirm a delivery failure.',
  },
  NOT_SELECTED_FOR_STORE: {
    code: 'NOT_SELECTED_FOR_STORE',
    title: 'Not selected for store',
    description: 'The release is not selected for this target store, or is missing a required store/album extra.',
    defaultSeverity: 'high',
    category: 'availability',
    remediation: 'Enable the store selection / album extra in the distributor and re-deliver.',
  },
  AUDIOMACK_NOT_CONNECTED: {
    code: 'AUDIOMACK_NOT_CONNECTED',
    title: 'Audiomack account not connected',
    description:
      'Audiomack delivery is expected but the distributor↔Audiomack account connection is missing, disconnected, mapped to the wrong artist, or unauthorized.',
    defaultSeverity: 'high',
    category: 'availability',
    remediation: 'Reconnect/authorize the Audiomack account in the distributor and confirm the correct artist mapping.',
  },
  WRONG_ARTIST_PROFILE: {
    code: 'WRONG_ARTIST_PROFILE',
    title: 'Wrong artist profile',
    description: 'The track exists on the DSP but appears under a different artist profile than the confirmed one.',
    defaultSeverity: 'critical',
    category: 'identity',
    remediation: 'Open a DSP-for-artists request to move the release to the correct profile.',
  },
  DUPLICATE_ARTIST_PROFILE: {
    code: 'DUPLICATE_ARTIST_PROFILE',
    title: 'Duplicate artist profile',
    description: 'The artist has multiple profiles on this DSP and releases are split between them.',
    defaultSeverity: 'high',
    category: 'identity',
    remediation: 'Request a profile merge and consolidate the catalog under the canonical profile.',
  },
  FOREIGN_CONTENT_ON_PROFILE: {
    code: 'FOREIGN_CONTENT_ON_PROFILE',
    title: "Someone else's music on profile",
    description: 'The DSP profile contains releases not in the catalog and not matching known aliases/collaborations.',
    defaultSeverity: 'high',
    category: 'identity',
    remediation: 'Report mismatched content to the DSP and request separation of the profiles.',
  },
  MISSING_PLAIN_LYRICS: {
    code: 'MISSING_PLAIN_LYRICS',
    title: 'Missing plain lyrics',
    description: 'The distributor catalog indicates no plain lyrics were submitted for this track.',
    defaultSeverity: 'medium',
    category: 'lyrics',
    remediation: 'Submit plain lyrics through the distributor lyrics tool.',
  },
  MISSING_SYNCED_LYRICS: {
    code: 'MISSING_SYNCED_LYRICS',
    title: 'Missing synced lyrics',
    description: 'Plain lyrics exist but synced lyrics are missing where expected/subscribed.',
    defaultSeverity: 'medium',
    category: 'lyrics',
    remediation: 'Submit synced (time-aligned) lyrics where the plan/option supports it.',
  },
  LYRICS_REJECTED: {
    code: 'LYRICS_REJECTED',
    title: 'Lyrics rejected',
    description: 'Lyrics status shows rejected/blocked due to formatting or rules.',
    defaultSeverity: 'medium',
    category: 'lyrics',
    remediation: 'Fix formatting per platform rules and resubmit lyrics.',
  },
  CREDITS_MISSING: {
    code: 'CREDITS_MISSING',
    title: 'Missing credits',
    description: 'Songwriter/producer/liner-note credits are missing or not submitted.',
    defaultSeverity: 'medium',
    category: 'credits',
    remediation: 'Add songwriter/producer credits in the distributor and redeliver.',
  },
  ISRC_MISSING: {
    code: 'ISRC_MISSING',
    title: 'Missing ISRC',
    description: 'The track has no ISRC captured from the distributor source of truth.',
    defaultSeverity: 'high',
    category: 'identifier',
    remediation: 'Assign/capture an ISRC for the recording before requesting support.',
  },
  UPC_MISSING: {
    code: 'UPC_MISSING',
    title: 'Missing UPC',
    description: 'The release has no UPC/barcode captured.',
    defaultSeverity: 'high',
    category: 'identifier',
    remediation: 'Assign/capture the UPC/barcode for the release.',
  },
  DUPLICATE_ISRC: {
    code: 'DUPLICATE_ISRC',
    title: 'Duplicate ISRC conflict',
    description: 'Multiple different recordings/releases unexpectedly share the same ISRC.',
    defaultSeverity: 'high',
    category: 'identifier',
    remediation: 'Correct the duplicated ISRC assignment with the distributor.',
  },
  PROCESSING_DELAY: {
    code: 'PROCESSING_DELAY',
    title: 'Release processing delay',
    description: 'The release was uploaded but is not delivered/live after the expected SLA.',
    defaultSeverity: 'medium',
    category: 'process',
    remediation: 'Wait out the delivery SLA; if exceeded, ask the distributor to investigate delivery.',
  },
  COVER_LICENSE_DELAY: {
    code: 'COVER_LICENSE_DELAY',
    title: 'Cover license delay',
    description: 'The release appears delayed or withheld due to cover license timing.',
    defaultSeverity: 'medium',
    category: 'rights',
    remediation: 'Confirm the cover/mechanical license status with the distributor.',
  },
  CURATED_CATALOG: {
    code: 'CURATED_CATALOG',
    title: 'Curated catalog limitation',
    description: 'The DSP is curated and not guaranteed to carry all submitted content.',
    defaultSeverity: 'low',
    category: 'availability',
    remediation: 'No action guaranteed; treat absence as expected for curated platforms.',
  },
  TERRITORY_RESTRICTION: {
    code: 'TERRITORY_RESTRICTION',
    title: 'Territory / market availability gap',
    description: 'The track exists but is unavailable in certain countries/regions.',
    defaultSeverity: 'medium',
    category: 'availability',
    remediation: 'Review territory selections and licensing for the affected markets.',
  },
  CONTENT_ID_CONFLICT: {
    code: 'CONTENT_ID_CONFLICT',
    title: 'Content ID / UGC conflict',
    description: 'Monetization opt-in exists but claims, allowlisting, or eligibility issues remain (incl. self-claims).',
    defaultSeverity: 'medium',
    category: 'rights',
    remediation: 'Allowlist your own channels and dispute erroneous Content ID claims.',
  },
  METADATA_REJECTION: {
    code: 'METADATA_REJECTION',
    title: 'Metadata rejection',
    description: 'Artwork, title, artist name, collaborator role, or rights metadata caused a rejection.',
    defaultSeverity: 'high',
    category: 'process',
    remediation: 'Correct the flagged metadata field and resubmit.',
  },
  TAKEDOWN_OR_REMOVAL: {
    code: 'TAKEDOWN_OR_REMOVAL',
    title: 'Takedown / removal',
    description: 'Content was removed due to a copyright claim, misidentification, distributor takedown, or enforcement.',
    defaultSeverity: 'critical',
    category: 'rights',
    remediation: 'Open a dispute/reinstatement request with evidence of ownership.',
  },
  ROYALTY_STATS_ANOMALY: {
    code: 'ROYALTY_STATS_ANOMALY',
    title: 'Royalty / stat anomaly',
    description: 'Stream/earnings/stat data is missing, delayed, inconsistent, or dropped unexpectedly.',
    defaultSeverity: 'medium',
    category: 'royalty',
    remediation: 'Request a reporting reconciliation for the affected period.',
  },
  SPLITS_ACTION_REQUIRED: {
    code: 'SPLITS_ACTION_REQUIRED',
    title: 'Split / collaborator action required',
    description: 'A split participant has not accepted, an email is invalid, or percentages do not sum correctly.',
    defaultSeverity: 'medium',
    category: 'royalty',
    remediation: 'Fix the split configuration and re-send collaborator invites.',
  },
  SUPPORT_DATA_INCOMPLETE: {
    code: 'SUPPORT_DATA_INCOMPLETE',
    title: 'Support data incomplete',
    description: 'A support request is needed but required UPC/ISRC/profile links/evidence are missing.',
    defaultSeverity: 'low',
    category: 'process',
    remediation: 'Collect the missing identifiers/links before opening the support request.',
  },
  UNKNOWN_NEEDS_REVIEW: {
    code: 'UNKNOWN_NEEDS_REVIEW',
    title: 'Unknown, needs review',
    description: 'Platform data was incomplete or ambiguous; a human must confirm before action.',
    defaultSeverity: 'low',
    category: 'process',
    remediation: 'Manually verify against the platform and reclassify.',
  },
};

export function reasonMeta(code: IssueReasonCode): ReasonCodeMeta {
  return REASON_CODE_REGISTRY[code];
}
