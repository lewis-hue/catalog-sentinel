import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

/**
 * BullMQ (Redis-backed) queues + workers, the Node/TypeScript analog of Celery
 * for heavy workloads. Heavy, long-running work (deep catalog scans, report/PDF
 * generation) runs on dedicated worker processes, not in the API request path.
 * Jobs are retryable with backoff, rate-limited, and observable.
 *
 * Queues (spec "Queue design"): browser-link, deep-scan, report-generation,
 * retention-cleanup. This module wires the transport; the deep-scan job body is
 * `runDeepScanJob` (unit-tested independently of Redis).
 */
export const QUEUE_NAMES = ['browser-link', 'deep-scan', 'report-generation', 'retention-cleanup'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error('Redis connection URL must use redis:// or rediss://.');
  }
  if (!u.hostname) throw new Error('Redis connection URL must include a hostname.');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export interface DeepScanJobPayload {
  tenantId: string;
  artistWorkspaceId: string;
  deepScanRunId: string;
  distributorConnectionId: string;
}

export interface QueueBundle {
  connection: ConnectionOptions;
  queues: Record<QueueName, Queue>;
  close(): Promise<void>;
}

/** Create the queue producers. Rate limits/concurrency are set on the workers. */
export function createQueues(redisUrl: string): QueueBundle {
  const connection = connectionFromUrl(redisUrl);
  const queues = Object.fromEntries(
    QUEUE_NAMES.map((name) => [name, new Queue(name, { connection, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 } })]),
  ) as Record<QueueName, Queue>;
  return {
    connection,
    queues,
    close: async () => {
      await Promise.all(Object.values(queues).map((q) => q.close()));
    },
  };
}

export interface DeepScanWorkerDeps {
  /** Load context + run the scan + persist results. Injected so this module has
   *  no DB coupling; the app supplies the real implementation (calls runDeepScanJob). */
  processDeepScan: (payload: DeepScanJobPayload, job: Job) => Promise<{ status: string; releases: number; tracks: number }>;
  /** DEEP_SCAN_MAX_CONCURRENCY, serialize distributor scans by default (=1). */
  concurrency?: number;
  /** DISTRIBUTOR_SCAN_MIN_DELAY_MS becomes the queue's rate limit window. */
  minDelayMs?: number;
}

/**
 * Start the deep-scan worker. Concurrency defaults to 1 and a rate limiter caps
 * throughput so we never run aggressive parallel automation against a distributor.
 */
export function startDeepScanWorker(redisUrl: string, deps: DeepScanWorkerDeps): Worker {
  const connection = connectionFromUrl(redisUrl);
  return new Worker(
    'deep-scan',
    async (job: Job) => deps.processDeepScan(job.data as DeepScanJobPayload, job),
    {
      connection,
      concurrency: deps.concurrency ?? 1,
      limiter: { max: 1, duration: Math.max(1000, deps.minDelayMs ?? 1500) },
    },
  );
}
