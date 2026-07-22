import type { ExtractionCompleteness, SnapshotStatus } from '@sentinel/contracts';
import { isExtractionFailure, type CanonicalDistributorRelease, type ReleaseExtractionOutcome } from './metadata-model';

/**
 * Completeness reconciliation.
 *
 * The old extractor could return 98 releases with 46/107 ISRCs and be treated as success. A
 * snapshot may only be COMPLETE when every indexed release reached a TERMINAL result, and
 * coverage must be reported per identifier level (UPC/artwork are release-level; ISRC is
 * track-level) so we can see WHICH extraction failed.
 *
 * `ExtractionCompleteness`/`SnapshotStatus` are defined in `@sentinel/contracts` because they
 * travel on the finalize job between processes. Re-exported so consumers of this package don't
 * need to know that.
 */

export type { ExtractionCompleteness, SnapshotStatus } from '@sentinel/contracts';

export interface ReconcileInput {
  /** Release ids from the catalog index — the authoritative expectation. */
  expectedReleaseIds: string[];
  outcomes: ReleaseExtractionOutcome[];
  /** Track count expected from the index, when the index exposes it. */
  expectedTracks?: number;
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export function reconcile(input: ReconcileInput): { completeness: ExtractionCompleteness; status: SnapshotStatus } {
  const byId = new Map<string, ReleaseExtractionOutcome>();
  for (const o of input.outcomes) {
    const id = o.kind === 'COMPLETED' ? o.release.distributorReleaseId : o.distributorReleaseId;
    byId.set(id, o);
  }

  const completed: CanonicalDistributorRelease[] = [];
  const failureReasons: Record<string, number> = {};
  let failedReleases = 0;
  let skippedReleases = 0;

  for (const o of input.outcomes) {
    if (o.kind === 'COMPLETED') completed.push(o.release);
    else if (o.kind === 'FAILED') { failedReleases++; failureReasons[o.reason] = (failureReasons[o.reason] ?? 0) + 1; }
    else skippedReleases++;
  }

  // A release indexed but with NO terminal outcome is unresolved — this is what makes a
  // snapshot non-complete. Silent skips are exactly the bug we're preventing.
  const unresolvedReleaseIds = input.expectedReleaseIds.filter((id) => !byId.has(id));

  const tracks = completed.flatMap((r) => r.tracks);
  const completeness: ExtractionCompleteness = {
    expectedReleases: input.expectedReleaseIds.length,
    attemptedReleases: byId.size,
    completedReleases: completed.length,
    failedReleases,
    skippedReleases,

    // Keep a numeric observed fallback for dashboards/storage, but carry an explicit proof bit.
    // Without it, `42/42` falsely implied that the index independently expected 42 tracks when
    // both numbers actually came from the same extracted array.
    expectedTracksKnown: input.expectedTracks !== undefined,
    expectedTracks: input.expectedTracks ?? tracks.length,
    extractedTracks: tracks.length,

    releasesWithUpc: completed.filter((r) => r.upc.status === 'PRESENT').length,
    releasesWithArtwork: completed.filter((r) => r.artworkUrl.status === 'PRESENT').length,
    tracksWithIsrc: tracks.filter((t) => t.isrc.status === 'PRESENT').length,
    tracksWithDistributorId: tracks.filter((t) => !!t.distributorTrackId).length,

    releasesUpcAbsentAtSource: completed.filter((r) => r.upc.status === 'ABSENT_AT_SOURCE').length,
    tracksIsrcAbsentAtSource: tracks.filter((t) => t.isrc.status === 'ABSENT_AT_SOURCE').length,
    releasesUpcNotCaptured: completed.filter((r) => isExtractionFailure(r.upc)).length,
    tracksIsrcNotCaptured: tracks.filter((t) => isExtractionFailure(t.isrc)).length,

    unresolvedReleaseIds,
    failureReasons,
  };

  return { completeness, status: deriveStatus(completeness) };
}

export function deriveStatus(c: ExtractionCompleteness): SnapshotStatus {
  // Every indexed release must have a terminal result before anything can be "complete".
  if (c.unresolvedReleaseIds.length > 0) return 'PARTIAL_RETRYABLE';
  if (c.failureReasons['SCHEMA_CHANGED']) return 'FAILED_SCHEMA_CHANGED';
  if (c.failureReasons['REAUTH_REQUIRED']) return 'PARTIAL_REAUTH_REQUIRED';
  if (c.expectedReleases > 0 && c.completedReleases === 0) return 'FAILED';
  if (c.failedReleases > 0) return 'PARTIAL_RETRYABLE';
  // Only compare counts when the expectation is independent. A proven mismatch is incomplete;
  // an unknown expectation is reported as unknown rather than manufacturing equality.
  if (c.expectedTracksKnown && c.extractedTracks !== c.expectedTracks) return 'PARTIAL_RETRYABLE';
  // Everything was attempted and completed. If identifiers are missing only because the
  // distributor itself has none, that's a COMPLETE snapshot with source gaps — not our failure.
  const ourGaps = c.releasesUpcNotCaptured + c.tracksIsrcNotCaptured;
  if (ourGaps > 0) return 'PARTIAL_RETRYABLE';
  const sourceGaps = c.releasesUpcAbsentAtSource + c.tracksIsrcAbsentAtSource;
  return sourceGaps > 0 ? 'COMPLETE_WITH_SOURCE_GAPS' : 'COMPLETE';
}

/** Releases that should be retried — failures only, never the whole catalog. */
export function retryableReleaseIds(input: ReconcileInput): string[] {
  const retryable = new Set<string>(input.outcomes.filter((o) => o.kind === 'FAILED' && isRetryable(o.reason)).map((o) => (o as { distributorReleaseId: string }).distributorReleaseId));
  const attempted = new Set(input.outcomes.map((o) => (o.kind === 'COMPLETED' ? o.release.distributorReleaseId : o.distributorReleaseId)));
  for (const id of input.expectedReleaseIds) if (!attempted.has(id)) retryable.add(id);
  return [...retryable];
}

const NON_RETRYABLE = new Set(['NOT_AUTHORIZED', 'SCHEMA_CHANGED']);
export const isRetryable = (reason: string): boolean => !NON_RETRYABLE.has(reason);

/** Operator-facing one-liner with coverage reported per identifier level. */
export function describeCompleteness(c: ExtractionCompleteness, status: SnapshotStatus): string {
  return [
    `status=${status}`,
    `releases ${c.completedReleases}/${c.expectedReleases} (failed ${c.failedReleases}, unresolved ${c.unresolvedReleaseIds.length})`,
    `UPC ${c.releasesWithUpc}/${c.completedReleases} (${pct(c.releasesWithUpc, c.completedReleases)}%)`,
    `artwork ${c.releasesWithArtwork}/${c.completedReleases} (${pct(c.releasesWithArtwork, c.completedReleases)}%)`,
    `tracks ${c.extractedTracks}/${c.expectedTracksKnown ? c.expectedTracks : 'unknown'}`,
    `ISRC ${c.tracksWithIsrc}/${c.extractedTracks} (${pct(c.tracksWithIsrc, c.extractedTracks)}%)`,
    `not-captured: UPC ${c.releasesUpcNotCaptured}, ISRC ${c.tracksIsrcNotCaptured}`,
    `absent-at-source: UPC ${c.releasesUpcAbsentAtSource}, ISRC ${c.tracksIsrcAbsentAtSource}`,
  ].join(' · ');
}
