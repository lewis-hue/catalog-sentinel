import type { FinalizeJob, MetadataField, ReleaseExtractionOutcome } from '@sentinel/contracts';
import {
  ownerOf,
  type CatalogMetadataFieldLike,
  type CatalogTrackLike,
  type ReleasedTrackLike,
  type SearchRecord,
} from '@sentinel/search-store';

/**
 * Project a terminal, normalized DistroKid snapshot into the customer-facing search record.
 *
 * The pipeline previously persisted its private outcome tables and left the public record on
 * `__reading_in_progress__` forever. This projection is intentionally pure so the handoff can be
 * regression-tested without Redis, Postgres, BullMQ, or a browser.
 */
export function projectFinalizedSnapshot(
  record: SearchRecord,
  job: FinalizeJob,
  outcomes: readonly ReleaseExtractionOutcome[],
  nowIso = new Date().toISOString(),
  // When false, the catalogue is projected but store-presence verification is NOT queued, it
  // waits for an explicit on-demand trigger. The record lands on `idle` (a CTA state), never
  // `queued`, so the UI does not poll for a job that will never arrive. Defaults true so existing
  // callers and tests keep the legacy scrape→verify chain unless a caller opts out.
  autoPresence = true,
): SearchRecord {
  if (ownerOf(record) !== job.tenantId) {
    throw new Error('finalized snapshot tenant does not own the target search record');
  }

  // A finalizer can be retried after the public projection succeeds (for example, because the
  // presence enqueue or remote-session release failed). Once this record has crossed from the
  // reading sentinel into the presence-scan handoff, that worker owns `perStore`, summary,
  // platform and deep-scan progress. Rebuilding the projection here would erase completed
  // presence evidence and turn a finished report back into "queued".
  //
  // `deepScan` is created by the first projection and the reading sentinel is removed by it, so
  // together they are a durable, rolling-upgrade-safe indication that this exact handoff already
  // happened. Returning the current record also preserves human review decisions made meanwhile.
  const alreadyProjected = Boolean(
    record.deepScan
    && !record.result.warnings.includes('__reading_in_progress__'),
  );
  if (alreadyProjected) return record;

  const released: ReleasedTrackLike[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind !== 'COMPLETED') continue;
    const release = outcome.release;
    for (const track of release.tracks) {
      const title = track.title.trim() || release.title.trim();
      released.push({
        title,
        primaryArtist: release.primaryArtist || record.artist,
        ...(release.featuredArtists ? { featuredArtists: [...release.featuredArtists] } : {}),
        isrc: valueOf(track.isrc),
        releaseTitle: release.title || null,
        artworkUrl: valueOf(release.artworkUrl),
        label: valueOf(release.label),
        upc: valueOf(release.upc),
        releaseDate: valueOf(release.releaseDate),
        uploadDate: valueOf(release.uploadDate),
        metadata: {
          isrc: publicField(track.isrc),
          upc: publicField(release.upc),
          artworkUrl: publicField(release.artworkUrl),
          releaseDate: publicField(release.releaseDate),
          ...(release.label ? { label: publicField(release.label) } : {}),
          ...(release.uploadDate ? { uploadDate: publicField(release.uploadDate) } : {}),
        },
      });
    }
  }

  const tracks: CatalogTrackLike[] = released.map((track) => ({
    title: track.title,
    primaryArtist: track.primaryArtist,
    ...(track.featuredArtists ? { featuredArtists: [...track.featuredArtists] } : {}),
    album: track.releaseTitle ?? null,
    isrc: track.isrc,
    artworkUrl: track.artworkUrl ?? null,
    label: track.label ?? null,
    upc: track.upc ?? null,
    releaseDate: track.releaseDate ?? null,
    uploadDate: track.uploadDate ?? null,
    metadata: track.metadata,
    // Presence verification is a separate, durable job. An empty matrix means unknown/not yet
    // checked; it must never be rendered as "not live".
    perStore: [],
  }));

  const failures = outcomes.filter((o) => o.kind === 'FAILED');
  const skipped = outcomes.filter((o) => o.kind === 'SKIPPED');
  const warnings: string[] = [];
  if (job.status !== 'COMPLETE') {
    warnings.push(`Distributor extraction finished with status ${job.status}; unresolved metadata is not treated as missing.`);
  }
  if (failures.length) {
    const byReason = new Map<string, number>();
    for (const failure of failures) byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
    warnings.push(`Could not verify ${failures.length} release(s): ${[...byReason].map(([reason, count]) => `${reason} ${count}`).join(', ')}.`);
  }
  if (skipped.length) warnings.push(`${skipped.length} release(s) were not extracted and remain unverified.`);
  if (!released.length) warnings.push('No tracks were verified from the distributor snapshot.');

  const hasReleased = released.length > 0;
  const willDeepScan = hasReleased && autoPresence;
  const note = !hasReleased
    ? 'The distributor snapshot reached a terminal state, but no tracks were verified. Retry the attended connection or use a distributor export.'
    : willDeepScan
      ? `Verified ${job.completeness.completedReleases}/${job.completeness.expectedReleases} distributor release(s). Store-presence verification is queued; no missing-store claim is made until that evidence arrives.`
      : `Verified ${job.completeness.completedReleases}/${job.completeness.expectedReleases} distributor release(s). Run a store-presence check to verify each track's availability across stores; no missing-store claim is made until then.`;
  return {
    ...record,
    tenantId: job.tenantId,
    platforms: [],
    released,
    result: {
      artist: record.artist,
      stores: [],
      profiles: [],
      tracks,
      summary: { tracks: tracks.length, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
      generatedAt: nowIso,
      warnings,
      distributorExtraction: {
        engine: 'NETWORK_FIRST',
        status: job.status,
        finalizedAt: nowIso,
        completeness: {
          ...job.completeness,
          unresolvedReleaseIds: [...job.completeness.unresolvedReleaseIds],
          failureReasons: { ...job.completeness.failureReasons },
        },
      },
      note,
    },
    deepScan: {
      // hasReleased && !auto → `unchecked` (terminal CTA state), never `idle` (which the active-scan
      // guard would treat as still-in-progress and block deletion / re-trigger).
      status: willDeepScan ? 'queued' : hasReleased ? 'unchecked' : 'done',
      platformsPending: [],
      platformsDone: [],
      updatedAt: nowIso,
      tracksScanned: 0,
    },
  };
}

function valueOf<T>(field: MetadataField<T> | undefined): T | null {
  return field?.status === 'PRESENT' && field.value !== undefined ? field.value : null;
}

function publicField<T>(field: MetadataField<T>): CatalogMetadataFieldLike<T> {
  return {
    ...(field.value !== undefined ? { value: field.value } : {}),
    status: field.status,
    source: field.source,
    capturedAt: field.capturedAt,
    parserVersion: field.parserVersion,
  };
}
