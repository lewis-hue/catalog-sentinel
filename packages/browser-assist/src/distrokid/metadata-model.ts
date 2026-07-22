import type { MetadataField, MetadataFieldStatus, MetadataSource } from '@sentinel/contracts';

/**
 * Canonical distributor metadata model — constructors and predicates.
 *
 * The TYPES live in `@sentinel/contracts` because they cross process boundaries (extractor →
 * pipeline → persistence) and the Postgres layer must be able to name them without importing this
 * package, which would drag Playwright into the database. Re-exported here so existing imports
 * keep working.
 */

export type {
  MetadataFieldStatus, MetadataSource, MetadataField,
  CanonicalDistributorTrack, CanonicalDistributorRelease,
  ReleaseExtractionOutcome, ReleaseFailureReason,
} from '@sentinel/contracts';

const now = (): string => new Date().toISOString();

/** A field we successfully read. */
export function present<T>(value: T, source: MetadataSource, parserVersion: string): MetadataField<T> {
  return { value, status: 'PRESENT', source, capturedAt: now(), parserVersion };
}

/** The source was read successfully and genuinely has no value for this field. */
export function absentAtSource<T>(source: MetadataSource, parserVersion: string): MetadataField<T> {
  return { status: 'ABSENT_AT_SOURCE', source, capturedAt: now(), parserVersion };
}

/** We never got to read it (timeout, request failure, …). NOT the same as absent. */
export function notCaptured<T>(status: Exclude<MetadataFieldStatus, 'PRESENT' | 'ABSENT_AT_SOURCE'>, source: MetadataSource, parserVersion: string): MetadataField<T> {
  return { status, source, capturedAt: now(), parserVersion };
}

/** True only when the distributor was actually read and reported nothing. */
export const isAbsentAtSource = (f: MetadataField<unknown>): boolean => f.status === 'ABSENT_AT_SOURCE';
/** True when our extraction failed — the value may well exist at the distributor. */
export const isExtractionFailure = (f: MetadataField<unknown>): boolean =>
  f.status !== 'PRESENT' && f.status !== 'ABSENT_AT_SOURCE';

/** Operator/user-facing explanation. Never renders a not-captured field as "Missing". */
export function explainField(f: MetadataField<unknown>, label: string): string {
  switch (f.status) {
    case 'PRESENT': return `${label}: ${String(f.value)}`;
    case 'ABSENT_AT_SOURCE': return `${label}: none at distributor`;
    case 'TIMEOUT': return `${label}: not captured — distributor metadata request timed out`;
    case 'REQUEST_FAILED': return `${label}: not captured — distributor metadata request failed`;
    case 'PARSE_FAILED': return `${label}: not captured — distributor response could not be parsed`;
    case 'REAUTH_REQUIRED': return `${label}: not captured — distributor login expired`;
    case 'NOT_AUTHORIZED': return `${label}: not captured — not authorized`;
    case 'NOT_CAPTURED': return `${label}: not captured`;
    default: return `${label}: unknown`;
  }
}
