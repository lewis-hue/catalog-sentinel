import { randomUUID, createHash } from 'node:crypto';

/**
 * Nominal (branded) ID types. They are `string` at runtime but incompatible at
 * the type level, so you cannot pass a TrackId where a ReleaseId is expected.
 */
declare const __brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [__brand]: B };

export type TenantId = Branded<string, 'TenantId'>;
export type UserId = Branded<string, 'UserId'>;
export type ArtistId = Branded<string, 'ArtistId'>;
export type WorkspaceId = Branded<string, 'WorkspaceId'>;
export type DistributorAccountId = Branded<string, 'DistributorAccountId'>;
export type DSPAccountId = Branded<string, 'DSPAccountId'>;
export type ArtistProfileId = Branded<string, 'ArtistProfileId'>;
export type CatalogSnapshotId = Branded<string, 'CatalogSnapshotId'>;
export type ReleaseId = Branded<string, 'ReleaseId'>;
export type TrackId = Branded<string, 'TrackId'>;
export type IssueId = Branded<string, 'IssueId'>;
export type EvidenceId = Branded<string, 'EvidenceId'>;
export type SupportPacketId = Branded<string, 'SupportPacketId'>;
export type ScanJobId = Branded<string, 'ScanJobId'>;
export type ScanRunId = Branded<string, 'ScanRunId'>;
export type AuditLogId = Branded<string, 'AuditLogId'>;
export type ConsentGrantId = Branded<string, 'ConsentGrantId'>;
export type CredentialReferenceId = Branded<string, 'CredentialReferenceId'>;

/** Mint a fresh, prefixed unique id, e.g. `id('trk') -> "trk_9f8c…"`. */
export function id<T extends string>(prefix: string): Branded<string, T> {
  return `${prefix}_${randomUUID()}` as Branded<string, T>;
}

/**
 * Stable id derived from a namespace + natural key. Same inputs always yield the
 * same id, which makes scans idempotent (re-importing the same catalog does not
 * create duplicate entities) and makes fixtures reproducible.
 */
export function stableId<T extends string>(prefix: string, ...parts: Array<string | number>): Branded<string, T> {
  const hash = createHash('sha256').update(parts.join('')).digest('hex').slice(0, 24);
  return `${prefix}_${hash}` as Branded<string, T>;
}
