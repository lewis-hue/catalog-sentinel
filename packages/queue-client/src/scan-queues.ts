import { Queue, type ConnectionOptions } from 'bullmq';
import {
  PRESENCE_QUEUE,
  presenceJobSchema, parseJob,
  type PresenceJobPayload,
  LYRICS_QUEUE,
  lyricsJobSchema,
  type LyricsJobPayload,
  DISTROKID_LYRIC_SCAN_QUEUE,
  distroKidLyricScanJobSchema,
  type DistroKidLyricScanJobPayload,
} from '@sentinel/contracts';

/**
 * Producer-side client for store-presence verification.
 *
 * The API used to reach these through `@sentinel/worker`, which meant an HTTP server imported a
 * browser runtime, a scan executor and Playwright in order to push two small JSON payloads onto
 * Redis. This module is the producer half; the consumers stay in the worker.
 *
 * Retry policies must MIRROR the worker's, since whoever enqueues sets them: a job's behaviour
 * shouldn't depend on which process created it.
 */

/** Queue depth, for readiness reporting. */
export type QueueCounts = Record<string, number>;

export interface PresenceProducer {
  /** Idempotent: `jobId = searchId`, so a duplicate submit is a no-op, not a second scan. */
  enqueue(searchId: string, tenantId: string): Promise<void>;
  /**
   * Drop any retained job for this search so a subsequent {@link enqueue} starts a genuinely fresh
   * scan. `jobId = searchId` plus `removeOnComplete` retention means a completed job blocks re-adds
   * with the same id; an on-demand re-check must clear it first. Best-effort: absent or in-flight
   * (locked) jobs resolve without throwing, so callers can call it unconditionally.
   */
  remove(searchId: string): Promise<void>;
  /** Job counts for health reporting. Exposed as DATA rather than handing out the raw Queue -
   *  a health check needs to observe depth, not to be able to enqueue or obliterate. */
  counts(): Promise<QueueCounts>;
  close(): Promise<void>;
}

export function createPresenceProducer(connection: ConnectionOptions): PresenceProducer {
  const q = new Queue<PresenceJobPayload>(PRESENCE_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 500, removeOnFail: 500 },
  });
  return {
    async enqueue(searchId, tenantId) {
      const job = parseJob(presenceJobSchema, { searchId, tenantId }, PRESENCE_QUEUE);
      await q.add('run', job, { jobId: searchId });
    },
    async remove(searchId) {
      // `Queue.remove` throws when the job is locked (currently processing); the on-demand endpoint
      // guards against re-triggering an in-flight scan, and either way a failure to remove must not
      // surface as a 5xx, worst case the following enqueue is the intended no-op.
      try { await q.remove(searchId); } catch { /* absent or in-flight, nothing to clear */ }
    },
    async counts() { return q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'); },
    async close() { await q.close(); },
  };
}

export interface DistroKidLyricScanProducer {
  /** Idempotent per snapshot (`jobId = snapshotId`). Carries the session handle for re-attach. */
  enqueue(payload: DistroKidLyricScanJobPayload): Promise<void>;
  remove(snapshotId: string): Promise<void>;
  counts(): Promise<QueueCounts>;
  close(): Promise<void>;
}

/** Producer for the dedicated DistroKid lyric scan queue (re-attaches to the warm Steel session and
 *  reads each album's lyric state). Separate from every other queue, fault-isolated. */
export function createDistroKidLyricScanProducer(connection: ConnectionOptions): DistroKidLyricScanProducer {
  const q = new Queue<DistroKidLyricScanJobPayload>(DISTROKID_LYRIC_SCAN_QUEUE, {
    connection,
    // attempts:1, a re-attach failure (session gone) must not thrash; the pass is best-effort.
    defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  });
  return {
    async enqueue(payload) {
      const job = parseJob(distroKidLyricScanJobSchema, payload, DISTROKID_LYRIC_SCAN_QUEUE);
      await q.add('run', job, { jobId: job.snapshotId });
    },
    async remove(snapshotId) { try { await q.remove(snapshotId); } catch { /* absent or in-flight */ } },
    async counts() { return q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'); },
    async close() { await q.close(); },
  };
}

export interface LyricsProducer {
  /** Idempotent: `jobId = searchId`, so a duplicate submit is a no-op, not a second check. */
  enqueue(searchId: string, tenantId: string): Promise<void>;
  /** Drop any retained job for this search so a subsequent enqueue starts a fresh check. Best-effort. */
  remove(searchId: string): Promise<void>;
  counts(): Promise<QueueCounts>;
  close(): Promise<void>;
}

/**
 * Producer for the lyric-availability verification queue. Mirrors {@link createPresenceProducer}
 * but on a SEPARATE queue: a lyrics-store outage must never touch catalogue scraping or the
 * store-presence scan.
 */
export function createLyricsProducer(connection: ConnectionOptions): LyricsProducer {
  const q = new Queue<LyricsJobPayload>(LYRICS_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 500, removeOnFail: 500 },
  });
  return {
    async enqueue(searchId, tenantId) {
      const job = parseJob(lyricsJobSchema, { searchId, tenantId }, LYRICS_QUEUE);
      await q.add('run', job, { jobId: searchId });
    },
    async remove(searchId) {
      try { await q.remove(searchId); } catch { /* absent or in-flight, nothing to clear */ }
    },
    async counts() { return q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'); },
    async close() { await q.close(); },
  };
}
