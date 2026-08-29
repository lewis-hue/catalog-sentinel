import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import { DISTROKID_LYRIC_SCAN_QUEUE, distroKidLyricScanJobSchema, parseJob, type DistroKidLyricScanJobPayload } from '@sentinel/contracts';
import { runDistroKidLyricScan, type DistroKidLyricScanDeps } from './distrokid-lyric-scan';

/**
 * CONSUMER for the dedicated DistroKid lyric scan. Its own fault-isolated queue so a re-attach
 * failure or a slow sweep can never affect catalogue scraping, store presence, or LRCLIB checks.
 */
export { DISTROKID_LYRIC_SCAN_QUEUE, type DistroKidLyricScanJobPayload } from '@sentinel/contracts';
export { createDistroKidLyricScanProducer } from '@sentinel/queue-client';

export function startDistroKidLyricScanWorker(connection: ConnectionOptions, deps: DistroKidLyricScanDeps & { concurrency?: number }): Worker {
  return new Worker(
    DISTROKID_LYRIC_SCAN_QUEUE,
    async (job: Job) => {
      const payload = parseJob(distroKidLyricScanJobSchema, job.data, DISTROKID_LYRIC_SCAN_QUEUE) satisfies DistroKidLyricScanJobPayload;
      await runDistroKidLyricScan(payload, {
        ...deps,
        log: (message, extra) => console.log(JSON.stringify({ level: 'info', queue: DISTROKID_LYRIC_SCAN_QUEUE, jobId: job.id, message, ...extra })),
      });
    },
    // concurrency 1: sequential per-album sweep on one re-attached session.
    { connection, concurrency: 1 },
  );
}
