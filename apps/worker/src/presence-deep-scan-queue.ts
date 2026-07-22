import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { PRESENCE_QUEUE, presenceJobSchema, parseJob, type PresenceJobPayload } from '@sentinel/contracts';
import { runStorePresenceDeepScan, type DeepScanPresenceDeps } from './deep-scan-presence';

/**
 * CONSUMER for the background multi-platform deep scan.
 *
 * The queue name and payload live in `@sentinel/contracts`, and the producer in
 * `@sentinel/queue-client` — so the API can enqueue without importing this application (and with
 * it, Playwright and a browser runtime it never uses). Both halves read the same contract, so a
 * rename can't leave one side writing to a queue the other never reads.
 */
export { PRESENCE_QUEUE, type PresenceJobPayload } from '@sentinel/contracts';
export { createPresenceProducer } from '@sentinel/queue-client';

/**
 * Start a presence deep-scan worker. Concurrency defaults to 1: Brave web search is a
 * GLOBAL 1 query/sec per key, so parallel Brave-heavy scans would 429. Scale only when
 * platforms are covered by their own (per-artist) official APIs.
 */
export function startPresenceDeepScanWorker(connection: ConnectionOptions, deps: DeepScanPresenceDeps & { concurrency?: number }): Worker {
  return new Worker(
    PRESENCE_QUEUE,
    async (job: Job) => {
      // Validate at the boundary: a malformed payload should fail loudly here, not partway
      // through a scan. The error names FIELDS, never values.
      const { searchId, tenantId } = parseJob(presenceJobSchema, job.data, PRESENCE_QUEUE) satisfies PresenceJobPayload;
      await runStorePresenceDeepScan(searchId, {
        ...deps,
        log: (message, extra) => console.log(JSON.stringify({ level: 'info', queue: PRESENCE_QUEUE, jobId: job.id, message, ...extra })),
      }, tenantId);
    },
    { connection, concurrency: deps.concurrency ?? 1 },
  );
}
