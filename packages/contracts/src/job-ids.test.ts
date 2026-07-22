import { describe, it, expect } from 'vitest';
import {
  jobIds, isValidBullJobId, DK_QUEUES, finalizeJobSchema, parseJob, type SnapshotRef,
} from './distrokid-pipeline';

/**
 * Job-id construction.
 *
 * These exist because of a real defect: the ids were colon-joined, and BullMQ REJECTS a custom
 * job id containing ":" ("Custom Id cannot contain :") since it namespaces its own Redis keys
 * that way. Every enqueue would have thrown, so the pipeline could never have processed a job in
 * production — yet the whole suite passed, because every test dispatched to the stage handlers
 * through a fake queue and never asked BullMQ to accept an id.
 *
 * A real-Redis end-to-end test caught it in the first run. These unit tests pin the invariant so
 * it fails fast and locally next time.
 */

const REF: SnapshotRef = {
  // Deliberately colon-bearing: this is the real shape the API produces, since a connection id
  // is `${tenantId}:${distributor}`.
  tenantId: 'tenant-1', connectionId: 'tenant-1:distrokid', snapshotId: 'search_abc', distributor: 'distrokid',
};

describe('job ids — BullMQ compatibility', () => {
  it('never contains a colon, even when the inputs do', () => {
    const ids = [
      jobIds.index(REF), jobIds.plan(REF), jobIds.chunk(REF, 3),
      jobIds.retry(REF, 1), jobIds.reconcile(REF), jobIds.finalize(REF),
    ];
    for (const id of ids) {
      expect(id, `"${id}" must not contain ":" — BullMQ rejects it`).not.toContain(':');
      expect(isValidBullJobId(id)).toBe(true);
    }
  });

  it('is deterministic — the same work always yields the same id (idempotent redelivery)', () => {
    expect(jobIds.index(REF)).toBe(jobIds.index({ ...REF }));
    expect(jobIds.chunk(REF, 2)).toBe(jobIds.chunk({ ...REF }, 2));
  });

  it('distinguishes every stage, chunk and attempt', () => {
    const all = new Set([
      jobIds.index(REF), jobIds.plan(REF), jobIds.reconcile(REF), jobIds.finalize(REF),
      jobIds.chunk(REF, 0), jobIds.chunk(REF, 1),
      jobIds.retry(REF, 0), jobIds.retry(REF, 1),
    ]);
    expect(all.size).toBe(8);
  });

  it('does NOT collide when sanitizing makes two different inputs look alike', () => {
    // Without the hash suffix, "a:b" and "a-b" both sanitize to "a-b" — two different accounts
    // would share a job id and silently deduplicate each other's scans. That is a data-leak-
    // shaped bug (one tenant's scan swallowed by another's), not a cosmetic one.
    const a = jobIds.index({ ...REF, connectionId: 'a:b' });
    const b = jobIds.index({ ...REF, connectionId: 'a-b' });
    expect(a).not.toBe(b);
  });

  it('scopes by tenant, connection and snapshot', () => {
    const base = jobIds.index(REF);
    expect(jobIds.index({ ...REF, tenantId: 'other' })).not.toBe(base);
    expect(jobIds.index({ ...REF, connectionId: 'other' })).not.toBe(base);
    expect(jobIds.index({ ...REF, snapshotId: 'other' })).not.toBe(base);
  });

  it('stays readable — the queue and the ids are still visible for debugging', () => {
    expect(jobIds.index(REF)).toContain(DK_QUEUES.index);
    expect(jobIds.index(REF)).toContain('tenant-1');
    expect(jobIds.index(REF)).toContain('search_abc');
  });
});

describe('finalize job rolling-deploy compatibility', () => {
  it('treats an old payload without expectedTracksKnown as unproven', () => {
    const oldPayload = {
      ...REF,
      status: 'COMPLETE',
      completeness: {
        expectedReleases: 1, attemptedReleases: 1, completedReleases: 1,
        failedReleases: 0, skippedReleases: 0,
        expectedTracks: 1, extractedTracks: 1,
        releasesWithUpc: 1, releasesWithArtwork: 1,
        tracksWithIsrc: 1, tracksWithDistributorId: 1,
        releasesUpcAbsentAtSource: 0, tracksIsrcAbsentAtSource: 0,
        releasesUpcNotCaptured: 0, tracksIsrcNotCaptured: 0,
        unresolvedReleaseIds: [], failureReasons: {},
      },
      pass: 1,
    };

    const parsed = parseJob(finalizeJobSchema, oldPayload, DK_QUEUES.finalize);
    expect(parsed.completeness.expectedTracksKnown).toBe(false);
  });
});
