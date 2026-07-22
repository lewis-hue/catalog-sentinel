import { Queue, type ConnectionOptions } from 'bullmq';
import { DEEP_SCAN_QUEUE, deepScanJobSchema, parseJob, type DeepScanJobPayload } from '@sentinel/contracts';
import { connectionFromUrl } from './distrokid';

/**
 * PRODUCER for the legacy distributor deep-scan queue.
 *
 * The dispatcher used to live in `apps/worker` with both halves in one file: an `inline` mode that
 * executes the scan in the caller's process, and a `bullmq` mode that just enqueues. Because they
 * shared a module, the API had to import the worker — and with it Playwright and a scan executor —
 * to reach the half that only pushes JSON onto Redis.
 *
 * This is the enqueue half. The inline executor stays in the worker, where the runner lives.
 */
export interface DeepScanProducer {
  /** Idempotent: `jobId = deepScanRunId`, so a scan cannot be double-run. */
  dispatch(payload: DeepScanJobPayload): Promise<void>;
  close(): Promise<void>;
}

export function createDeepScanProducer(connection: ConnectionOptions): DeepScanProducer {
  const q = new Queue<DeepScanJobPayload>(DEEP_SCAN_QUEUE, {
    connection,
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
  });
  return {
    async dispatch(payload) {
      const job = parseJob(deepScanJobSchema, payload, DEEP_SCAN_QUEUE);
      await q.add('runDistributorDeepScan', job, { jobId: job.deepScanRunId });
    },
    async close() { await q.close(); },
  };
}

export function createDeepScanProducerFromUrl(redisUrl: string): DeepScanProducer {
  return createDeepScanProducer(connectionFromUrl(redisUrl));
}
