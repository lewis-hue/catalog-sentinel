import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { LYRICS_QUEUE, lyricsJobSchema, parseJob, type LyricsJobPayload } from '@sentinel/contracts';
import { runLyricsVerification, type LyricsVerificationDeps } from './lyrics-verification';

/**
 * CONSUMER for the fault-isolated per-store lyric verification (Serper web search). Runs on its own
 * queue so a search-source outage cannot affect catalogue scraping or store-presence scanning. The queue
 * name + payload live in `@sentinel/contracts`; the producer in `@sentinel/queue-client`.
 */
export { LYRICS_QUEUE, type LyricsJobPayload } from '@sentinel/contracts';
export { createLyricsProducer } from '@sentinel/queue-client';

export function startLyricsVerificationWorker(connection: ConnectionOptions, deps: LyricsVerificationDeps & { concurrency?: number }): Worker {
  return new Worker(
    LYRICS_QUEUE,
    async (job: Job) => {
      // `searchId` is the snapshot id, the outcome-table key this worker reads/writes.
      const { searchId, tenantId } = parseJob(lyricsJobSchema, job.data, LYRICS_QUEUE) satisfies LyricsJobPayload;
      await runLyricsVerification({ snapshotId: searchId, tenantId }, {
        ...deps,
        log: (message, extra) => console.log(JSON.stringify({ level: 'info', queue: LYRICS_QUEUE, jobId: job.id, message, ...extra })),
      });
    },
    { connection, concurrency: deps.concurrency ?? 1 },
  );
}
