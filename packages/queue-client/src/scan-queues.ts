import { Queue, type ConnectionOptions } from 'bullmq';
import {
  PRESENCE_QUEUE,
  presenceJobSchema, parseJob,
  type PresenceJobPayload,
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
  /** Job counts for health reporting. Exposed as DATA rather than handing out the raw Queue —
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
    async counts() { return q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed'); },
    async close() { await q.close(); },
  };
}
