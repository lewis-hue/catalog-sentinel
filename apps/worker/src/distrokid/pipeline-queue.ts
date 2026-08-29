import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import {
  extractDistroKidCatalogIndex, planDistroKidReleaseChunks, extractDistroKidReleaseChunk,
  retryFailedDistroKidReleases, reconcileDistroKidSnapshot, finalizeDistroKidSnapshot,
  jobIds, DISTROKID_MAX_ATTEMPTS, resumeTerminalFinalizer, terminalizeDistroKidFailure,
  PipelineDeadlineExceededError, InvalidPipelineDeadlineError, PipelineShutdownError,
  sanitizeRecoveredDistroKidFailure,
  type PipelineDeps, type CatalogIndexJob, type PlanChunksJob, type ReleaseChunkJob,
  type RetryFailedJob, type ReconcileJob, type FinalizeJob, type SnapshotRef,
} from './pipeline';

/**
 * BullMQ wiring for the release-chunked DistroKid pipeline.
 *
 * Queue-per-stage keeps the browser-bound stages (index, chunk) isolated from the cheap
 * bookkeeping stages (reconcile, finalize), so a slow browser read can't starve reconciliation.
 * Every job id is idempotent, so a duplicate delivery or a resumed run is a no-op.
 */

export const DK_QUEUES = {
  index: 'distrokid-catalog-index',
  plan: 'distrokid-plan-chunks',
  chunk: 'distrokid-release-chunk',
  retry: 'distrokid-retry-failed',
  reconcile: 'distrokid-reconcile',
  finalize: 'distrokid-finalize',
} as const;

/** Built-in exponential retry understood by every BullMQ worker. */
const defaultJobOptions = {
  attempts: DISTROKID_MAX_ATTEMPTS,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  // Jobs contain an envelope-encrypted Steel handoff. Bound it by BOTH age and count; the
  // periodic explicit cleanup below prevents low-traffic queues retaining an old job forever.
  removeOnComplete: { age: 60 * 60, count: 500 },
  // Failed jobs are the durable recovery ledger. Keep enough history for a recovery sweep after
  // an outage/redeploy, while bounding Redis growth by both age and count.
  // A Steel lease is at most one day for this workflow, so retaining a failed handoff longer
  // cannot recover browser work and only extends sensitive-data lifetime.
  removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
};

export interface DistroKidQueues {
  index: Queue<CatalogIndexJob>;
  plan: Queue<PlanChunksJob>;
  chunk: Queue<ReleaseChunkJob>;
  retry: Queue<RetryFailedJob>;
  reconcile: Queue<ReconcileJob>;
  finalize: Queue<FinalizeJob>;
  close(): Promise<void>;
}

export function createDistroKidQueues(connection: ConnectionOptions): DistroKidQueues {
  const mk = <T>(name: string): Queue<T> => new Queue<T>(name, { connection, defaultJobOptions });
  const index = mk<CatalogIndexJob>(DK_QUEUES.index);
  const plan = mk<PlanChunksJob>(DK_QUEUES.plan);
  const chunk = mk<ReleaseChunkJob>(DK_QUEUES.chunk);
  const retry = mk<RetryFailedJob>(DK_QUEUES.retry);
  const reconcile = mk<ReconcileJob>(DK_QUEUES.reconcile);
  const finalize = mk<FinalizeJob>(DK_QUEUES.finalize);
  return {
    index, plan, chunk, retry, reconcile, finalize,
    async close() { await Promise.all([index, plan, chunk, retry, reconcile, finalize].map((q) => q.close())); },
  };
}

/** Enqueue helpers bound to the queues, with idempotent job ids. */
export function enqueuers(q: DistroKidQueues): PipelineDeps['enqueue'] & { startSnapshot(job: CatalogIndexJob): Promise<void> } {
  return {
    async startSnapshot(job) { await q.index.add('run', job, { jobId: jobIds.index(job) }); },
    async plan(job) { await q.plan.add('run', job, { jobId: jobIds.plan(job) }); },
    async chunk(job, opts) {
      // `deferAttempt` and `pass` MUST feed the job id: a job re-added under an existing id is
      // silently discarded by BullMQ as a duplicate and never runs.
      await q.chunk.add('run', job, {
        jobId: jobIds.chunk(job, job.chunkIndex, job.deferAttempt ?? 0, job.pass ?? 1),
        ...(opts?.delayMs ? { delay: opts.delayMs } : {}),
      });
    },
    async retry(job) { await q.retry.add('run', job, { jobId: jobIds.retry(job, job.attempt) }); },
    // `pass` is load-bearing. BullMQ retains completed jobs (removeOnComplete: 500) and returns
    // the retained job for a colliding id, so without the pass, the retry sweep's reconciliation
    // reused pass 1's id, never ran, and the snapshot hung without ever finalizing.
    async reconcile(job) { await q.reconcile.add('run', job, { jobId: jobIds.reconcile(job, job.pass ?? 1) }); },
    async finalize(job) { await q.finalize.add('run', job, { jobId: jobIds.finalize(job, job.pass ?? 1) }); },
  };
}

export interface StartPipelineOptions {
  connection: ConnectionOptions;
  deps: PipelineDeps;
  /** Concurrency ACROSS accounts. Within one account the connection lock enforces 1. */
  chunkConcurrency?: number;
  /** How often durable failed jobs are reconciled. Defaults to 15 seconds. */
  terminalRecoveryIntervalMs?: number;
  /** Maximum failed jobs read from each stage in one recovery sweep. */
  terminalRecoveryBatchSize?: number;
}

type PipelineStageJob<T extends SnapshotRef = SnapshotRef> = Pick<
  Job<T>,
  'id' | 'data' | 'attemptsMade' | 'opts' | 'progress' | 'updateProgress'
>;

type FailedRecoveryJob = PipelineStageJob & Pick<Job<SnapshotRef>, 'failedReason' | 'retry'>;

export interface FailedRecoveryQueue {
  name: string;
  getFailed(start?: number, end?: number): Promise<FailedRecoveryJob[]>;
}

export interface FailedRecoveryStats {
  terminalized: number;
  finalizersRetried: number;
  shutdownJobsRetried: number;
  skipped: number;
  failed: number;
}

/** Never delete the recovery ledger in a sweep where any convergence operation failed. */
export const canCleanExpiredPipelineJobs = (stats: FailedRecoveryStats): boolean => stats.failed === 0;

const TERMINAL_FAILURE_HANDLED = 'distroKidTerminalFailureHandled';
const FINALIZE_RECOVERY_ATTEMPTS = 'distroKidFinalizeRecoveryAttempts';
const FINALIZE_RECOVERY_NOT_BEFORE = 'distroKidFinalizeRecoveryNotBefore';

const errorOf = (value: unknown): Error => {
  if (value instanceof Error) return value;
  const error = new Error('pipeline stage failed with a non-Error value');
  error.name = 'PipelineStageError';
  return error;
};

const progressObject = (job: Pick<PipelineStageJob, 'progress'>): Record<string, unknown> =>
  job.progress && typeof job.progress === 'object' && !Array.isArray(job.progress)
    ? { ...(job.progress as Record<string, unknown>) }
    : {};

async function markTerminalFailureHandled(job: PipelineStageJob, stage: string): Promise<void> {
  await job.updateProgress({
    ...progressObject(job),
    [TERMINAL_FAILURE_HANDLED]: true,
    distroKidTerminalFailureStage: stage,
    distroKidTerminalFailureHandledAt: new Date().toISOString(),
  });
}

/**
 * Run one BullMQ attempt and synchronously project an exhausted non-final stage to FAILED.
 *
 * The worker `failed` event is notification-only: BullMQ does not await event listeners, so an
 * async terminal callback there can be lost when the process exits. This wrapper runs inside the
 * processor promise; BullMQ cannot mark the last attempt failed until terminalization resolves.
 */
export async function runPipelineStage<T extends SnapshotRef, R>(
  stage: string,
  job: PipelineStageJob<T>,
  deps: PipelineDeps,
  processor: () => Promise<R>,
): Promise<R> {
  if (stage !== DK_QUEUES.finalize && await resumeTerminalFinalizer(job.data, deps)) {
    return undefined as R;
  }
  try {
    return await processor();
  } catch (value) {
    const stageError = errorOf(value);
    // Shutdown is an ownership transfer, not a customer-visible extraction failure. Let BullMQ
    // retry it on the next worker; exhausted shutdown attempts are revived by durable recovery.
    if (stageError instanceof PipelineShutdownError) throw stageError;
    const configuredAttempts = Math.max(1, Number(job.opts.attempts) || 1);
    const exhaustedAfterThisAttempt = job.attemptsMade + 1 >= configuredAttempts;
    const fatalNow = stageError instanceof PipelineDeadlineExceededError
      || stageError instanceof InvalidPipelineDeadlineError;
    if (stage !== DK_QUEUES.finalize && (fatalNow || exhaustedAfterThisAttempt)) {
      try {
        await terminalizeDistroKidFailure(job.data, stage, stageError, deps);
      } catch (terminalValue) {
        const terminalError = errorOf(terminalValue);
        deps.log?.('terminal snapshot projection failed; durable recovery will retry it', {
          stage,
          error: terminalError.name,
        });
        const convergenceError = new Error(
          `exhausted pipeline stage ${stage} could not record its terminal failure`,
          { cause: terminalError },
        );
        convergenceError.name = 'TerminalFailureConvergenceError';
        throw convergenceError;
      }
      // The projection is already durable. This marker prevents the periodic recovery sweep from
      // repeating it; if this best-effort marker write fails, the idempotent callback is retried.
      await markTerminalFailureHandled(job, stage).catch((markerValue) => {
        deps.log?.('could not mark terminal snapshot projection handled', {
          stage,
          error: errorOf(markerValue).name,
        });
      });
    }
    throw stageError;
  }
}

/**
 * Reconcile BullMQ's durable failed sets after a crash or dependency outage.
 *
 * - Exhausted non-final stages retry the idempotent terminal FAILED projection.
 * - Exhausted finalizers are moved back to waiting with a durable exponential cooldown. They
 *   cannot call `terminalFailure` because finalization/persistence is the operation that failed.
 */
export async function recoverFailedDistroKidJobs(
  queues: readonly FailedRecoveryQueue[],
  deps: PipelineDeps,
  options: { batchSize?: number; now?: () => number } = {},
): Promise<FailedRecoveryStats> {
  const stats: FailedRecoveryStats = { terminalized: 0, finalizersRetried: 0, shutdownJobsRetried: 0, skipped: 0, failed: 0 };
  // Match the retained-failure count by default. A smaller fixed first page would repeatedly see
  // the same handled newest jobs and could starve older failures forever.
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 5_000));
  const now = options.now ?? Date.now;

  for (const queue of queues) {
    let jobs: FailedRecoveryJob[];
    try {
      jobs = await queue.getFailed(0, batchSize - 1);
    } catch (value) {
      stats.failed++;
      deps.log?.('failed-job recovery could not read queue', { stage: queue.name, error: errorOf(value).name });
      continue;
    }

    for (const job of jobs) {
      const progress = progressObject(job);
      try {
        if (job.failedReason?.includes('PIPELINE_SHUTDOWN_RETRY')) {
          await job.retry('failed');
          stats.shutdownJobsRetried++;
          continue;
        }
        if (queue.name === DK_QUEUES.finalize) {
          const notBefore = Number(progress[FINALIZE_RECOVERY_NOT_BEFORE] ?? 0);
          if (Number.isFinite(notBefore) && notBefore > now()) {
            stats.skipped++;
            continue;
          }
          const recoveryAttempt = Math.max(0, Number(progress[FINALIZE_RECOVERY_ATTEMPTS]) || 0) + 1;
          const cooldownMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.min(recoveryAttempt - 1, 5)));
          await job.updateProgress({
            ...progress,
            [FINALIZE_RECOVERY_ATTEMPTS]: recoveryAttempt,
            [FINALIZE_RECOVERY_NOT_BEFORE]: now() + cooldownMs,
          });
          await job.retry('failed');
          stats.finalizersRetried++;
          continue;
        }

        if (progress[TERMINAL_FAILURE_HANDLED] === true) {
          stats.skipped++;
          continue;
        }
        await terminalizeDistroKidFailure(
          job.data,
          queue.name,
          sanitizeRecoveredDistroKidFailure(queue.name, job.failedReason),
          deps,
        );
        await markTerminalFailureHandled(job, queue.name);
        stats.terminalized++;
      } catch (value) {
        stats.failed++;
        deps.log?.('failed-job recovery attempt did not converge', {
          stage: queue.name,
          jobId: job.id,
          error: errorOf(value).name,
        });
      }
    }
  }
  return stats;
}

export interface DistroKidPipelineWorkers {
  workers: Worker[];
  /** Run the durable reconciliation immediately (also runs periodically in the background). */
  recoverFailedJobs(): Promise<FailedRecoveryStats>;
  close(): Promise<void>;
}

export function startDistroKidPipelineWorkers(opts: StartPipelineOptions): DistroKidPipelineWorkers {
  const { connection, deps } = opts;
  const log = (queue: string, job: Job) => (message: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', queue, jobId: job.id, message, ...extra }));

  const workers: Worker[] = [
    new Worker<CatalogIndexJob>(DK_QUEUES.index, async (job) => runPipelineStage(DK_QUEUES.index, job, deps, () => extractDistroKidCatalogIndex(job.data, { ...deps, log: log(DK_QUEUES.index, job) })), { connection, concurrency: opts.chunkConcurrency ?? 4 }),
    new Worker<PlanChunksJob>(DK_QUEUES.plan, async (job) => runPipelineStage(DK_QUEUES.plan, job, deps, () => planDistroKidReleaseChunks(job.data, { ...deps, log: log(DK_QUEUES.plan, job) })), { connection, concurrency: 4 }),
    // Browser-bound: concurrency here is ACROSS accounts; the per-connection lock caps one account to 1.
    new Worker<ReleaseChunkJob>(DK_QUEUES.chunk, async (job) => runPipelineStage(DK_QUEUES.chunk, job, deps, () => extractDistroKidReleaseChunk(job.data, { ...deps, log: log(DK_QUEUES.chunk, job) })), { connection, concurrency: opts.chunkConcurrency ?? 4 }),
    new Worker<RetryFailedJob>(DK_QUEUES.retry, async (job) => runPipelineStage(DK_QUEUES.retry, job, deps, () => retryFailedDistroKidReleases(job.data, { ...deps, log: log(DK_QUEUES.retry, job) })), { connection, concurrency: 2 }),
    new Worker<ReconcileJob>(DK_QUEUES.reconcile, async (job) => runPipelineStage(DK_QUEUES.reconcile, job, deps, () => reconcileDistroKidSnapshot(job.data, { ...deps, log: log(DK_QUEUES.reconcile, job) })), { connection, concurrency: 2 }),
    new Worker<FinalizeJob>(DK_QUEUES.finalize, async (job) => runPipelineStage(DK_QUEUES.finalize, job, deps, () => finalizeDistroKidSnapshot(job.data, { ...deps, log: log(DK_QUEUES.finalize, job) })), { connection, concurrency: 2 }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(JSON.stringify({ level: 'error', queue: w.name, jobId: job?.id, message: 'job failed', error: err?.name ?? 'Error' }));
    });
  }

  const recoveryClients = Object.values(DK_QUEUES).map((name) => new Queue<SnapshotRef>(name, { connection }));
  const recoveryQueues: FailedRecoveryQueue[] = recoveryClients.map((queue) => ({
    name: queue.name,
    async getFailed(start, end) {
      return queue.getFailed(start, end) as Promise<FailedRecoveryJob[]>;
    },
  }));
  const recoverFailedJobs = (): Promise<FailedRecoveryStats> =>
    recoverFailedDistroKidJobs(recoveryQueues, deps, { batchSize: opts.terminalRecoveryBatchSize });

  const cleanExpiredJobs = async (): Promise<void> => {
    await Promise.all(recoveryClients.flatMap((queue) => [
      queue.clean(60 * 60_000, 1_000, 'completed'),
      queue.clean(24 * 60 * 60_000, 1_000, 'failed'),
    ]));
  };

  let recoveryInFlight: Promise<FailedRecoveryStats> | null = null;
  const triggerRecovery = (): void => {
    if (recoveryInFlight) return;
    const running = recoverFailedJobs()
      .then((stats) => {
        if (stats.terminalized || stats.finalizersRetried || stats.shutdownJobsRetried || stats.failed) {
          console.log(JSON.stringify({ level: stats.failed ? 'error' : 'info', message: 'distrokid failed-job recovery sweep', ...stats }));
        }
        return stats;
      })
      // Recovery must run before deletion so a retained terminal/finalizer failure gets one last
      // convergence attempt before its now-expired Steel handoff is purged.
      .then(async (stats) => {
        if (canCleanExpiredPipelineJobs(stats)) await cleanExpiredJobs();
        else deps.log?.('skipping expired-job cleanup because recovery did not converge', { failures: stats.failed });
        return stats;
      })
      .catch((value) => {
        console.error(JSON.stringify({ level: 'error', message: 'distrokid failed-job recovery sweep crashed', error: errorOf(value).name }));
        return { terminalized: 0, finalizersRetried: 0, shutdownJobsRetried: 0, skipped: 0, failed: 1 };
      })
      .finally(() => { if (recoveryInFlight === running) recoveryInFlight = null; });
    recoveryInFlight = running;
  };

  // Sweep once at boot to recover failures retained across a deployment, then continuously.
  triggerRecovery();
  const recoveryIntervalMs = Math.max(1_000, opts.terminalRecoveryIntervalMs ?? 15_000);
  const recoveryTimer = setInterval(triggerRecovery, recoveryIntervalMs);
  recoveryTimer.unref();

  return {
    workers,
    recoverFailedJobs,
    close: async () => {
      clearInterval(recoveryTimer);
      await recoveryInFlight?.catch(() => undefined);
      await Promise.all([
        ...workers.map((worker) => worker.close()),
        ...recoveryClients.map((queue) => queue.close()),
      ]);
    },
  };
}
