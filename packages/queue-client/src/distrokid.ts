import { Queue, type ConnectionOptions } from 'bullmq';
import {
  DK_QUEUES, DISTROKID_MAX_ATTEMPTS, DISTROKID_JOB_SCHEMA_VERSION,
  DISTROKID_SESSION_CLEANUP_GRACE_MS, catalogIndexJobSchema, jobIds, parseJob,
  type CatalogIndexJob,
} from '@sentinel/contracts';

/**
 * Producer-side client for the DistroKid pipeline.
 *
 * This exists so the API can START a snapshot without importing `@sentinel/worker`. Previously
 * the six-stage pipeline had workers but NO producer: the API enqueued the older `catalogue-read`
 * job instead, so the pipeline's queues sat empty forever while tests passed. A consumer with no
 * producer is not "wired", this module is the missing half.
 */

/** Must mirror the worker's `defaultJobOptions` so a job's retry policy doesn't depend on who enqueued it. */
const defaultJobOptions = {
  attempts: DISTROKID_MAX_ATTEMPTS,
  // Built-in strategy: every worker understands it. `custom` without a registered
  // backoffStrategy fails exactly when a retry is needed.
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 60 * 60, count: 500 },
  removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
};

export interface DistroKidProducer {
  /**
   * Start a catalogue snapshot. IDEMPOTENT SUBMISSION: the job id is derived from
   * (tenant, connection, snapshot), so a double-submitted scan converges on one job rather than
   * opening a second browser session against the same account.
   *
   * `accepted` means "this snapshot is queued", NOT "this call created the job". Whether *this*
   * call or a concurrent one won the race is not knowable from `add()` alone, BullMQ returns the
   * existing job with the requested id on collision, so an equality check on the returned id
   * reports "created" for both. Rather than report that unreliably, we don't claim it: callers
   * want to know the work is queued, and that is exactly what this says.
   */
  startSnapshot(job: CatalogIndexJob): Promise<{ jobId: string; accepted: true; alreadyTerminal?: true }>;
  close(): Promise<void>;
}

export interface DistroKidProducerOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Reserved lease time for durable terminal persistence and the Steel release call. */
  cleanupGraceMs?: number;
  /**
   * Persist and return the canonical recovery envelope before Redis submission. A replay may
   * return the first durable ciphertext/deadline, which keeps randomized encryption idempotent.
   */
  prepareJob?: (job: CatalogIndexJob) => Promise<CatalogIndexJob | null>;
}

const isProduction = (env: NodeJS.ProcessEnv): boolean =>
  [env.NODE_ENV, env.APP_ENV, env.DEPLOYMENT_ENV].some((value) => value?.trim().toLowerCase() === 'production');

/**
 * Anchor the pipeline budget once, at the producer boundary. It must be immutable across retries
 * and queue hops; recomputing `now + maxDuration` in each worker would turn a ten-minute budget
 * into an unbounded sequence of ten-minute budgets.
 */
export function withDistroKidDeadline(
  job: CatalogIndexJob,
  options: DistroKidProducerOptions = {},
): CatalogIndexJob {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? Date.now();
  const configured = Number(env.CATALOG_READ_MAX_DURATION_MS);
  const maxDurationMs = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 600_000;
  const cleanupGraceMs = Math.max(1, Math.floor(options.cleanupGraceMs ?? DISTROKID_SESSION_CLEANUP_GRACE_MS));
  const sessionExpiry = job.sessionExpiresAt ? Date.parse(job.sessionExpiresAt) : Number.POSITIVE_INFINITY;

  if (isProduction(env) && !Number.isFinite(sessionExpiry)) {
    throw new Error('production DistroKid jobs require the actual Steel session expiry');
  }
  if (job.sessionExpiresAt && !Number.isFinite(sessionExpiry)) {
    throw new Error('invalid Steel session expiry on DistroKid job');
  }
  // A brand-new scan must have the full configured budget. A replay carrying the already
  // anchored deadline only needs that original deadline to remain live; requiring a fresh full
  // budget would make an idempotent retry fail merely because persistence consumed milliseconds.
  if (!job.deadlineAt && Number.isFinite(sessionExpiry) && sessionExpiry - now < maxDurationMs + cleanupGraceMs) {
    throw new Error('Steel session does not have the full configured catalogue-read budget remaining');
  }

  const latestSafeDeadline = sessionExpiry - cleanupGraceMs;
  const requestedDeadline = job.deadlineAt ? Date.parse(job.deadlineAt) : now + maxDurationMs;
  if (!Number.isFinite(requestedDeadline)) throw new Error('invalid DistroKid pipeline deadline');
  const deadline = Math.min(requestedDeadline, now + maxDurationMs, latestSafeDeadline);
  if (deadline <= now) {
    throw new Error('Steel session has too little lease remaining to start a DistroKid catalogue read');
  }

  return { ...job, deadlineAt: new Date(deadline).toISOString() };
}

export function createDistroKidProducer(
  connection: ConnectionOptions,
  options: DistroKidProducerOptions = {},
): DistroKidProducer {
  const index = new Queue<CatalogIndexJob>(DK_QUEUES.index, { connection, defaultJobOptions });
  return {
    async startSnapshot(job) {
      // Validate at the edge: a malformed job should fail in the API request that caused it,
      // not halfway through a catalogue read in a worker an hour later.
      const budgeted = withDistroKidDeadline(job, options);
      const versioned = parseJob(
        catalogIndexJobSchema,
        { schemaVersion: DISTROKID_JOB_SCHEMA_VERSION, ...budgeted },
        DK_QUEUES.index,
      );
      const prepared = options.prepareJob ? await options.prepareJob(versioned) : versioned;
      if (prepared === null) {
        // PostgreSQL already contains a terminal checkpoint and terminal cleanup has removed its
        // reconnect authority. Treat the delayed/idempotent confirmation as durably handled;
        // re-enqueuing after BullMQ retention expires could otherwise reopen a released session.
        return { jobId: jobIds.index(versioned), accepted: true, alreadyTerminal: true };
      }
      // A durable replay returns the original immutable deadline. Re-validate it against the
      // current clock so recovery cannot accidentally extend or revive an exhausted lease.
      const valid = parseJob(
        catalogIndexJobSchema,
        withDistroKidDeadline(prepared, options),
        DK_QUEUES.index,
      );
      const jobId = jobIds.index(valid);
      await index.add('run', valid, { jobId });
      return { jobId, accepted: true };
    },
    async close() { await index.close(); },
  };
}

/** Parse an explicit Redis URL into BullMQ/ioredis connection options, preserving TLS. */
export function connectionFromUrl(url: string): ConnectionOptions {
  const u = new URL(url);
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
