import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { InMemorySnapshotStore } from './snapshot-store';
import {
  finalizeDistroKidSnapshot, PipelineDeadlineExceededError,
  PipelineShutdownError, type PipelineDeps, type SnapshotRef, type FinalizeJob,
} from './pipeline';
import {
  DK_QUEUES,
  canCleanExpiredPipelineJobs,
  recoverFailedDistroKidJobs,
  runPipelineStage,
  type FailedRecoveryQueue,
} from './pipeline-queue';

const REF: SnapshotRef = {
  tenantId: 'tenant-1', connectionId: 'connection-1', snapshotId: 'snapshot-1', distributor: 'distrokid',
};

function depsWith(terminalFailure?: PipelineDeps['terminalFailure']): PipelineDeps {
  return {
    store: new InMemorySnapshotStore(),
    async readCatalogIndex() { return []; },
    async extractChunk() { return []; },
    async acquireLock() { return null; },
    enqueue: {
      async plan() {}, async chunk() {}, async retry() {}, async reconcile() {}, async finalize() {},
    },
    async persistSnapshot() {},
    ...(terminalFailure ? { terminalFailure } : {}),
  };
}

function stageJob(stageAttemptsMade = 2, configuredAttempts = 3): {
  job: Job<SnapshotRef>;
  progress: () => unknown;
} {
  let progress: unknown = {};
  const job = {
    id: 'job-1', data: REF, attemptsMade: stageAttemptsMade,
    opts: { attempts: configuredAttempts },
    get progress() { return progress; },
    async updateProgress(next: unknown) { progress = next; },
  } as unknown as Job<SnapshotRef>;
  return { job, progress: () => progress };
}

describe('pipeline terminal convergence', () => {
  it('never cleans the failed-job ledger when recovery did not fully converge', () => {
    expect(canCleanExpiredPipelineJobs({ terminalized: 0, finalizersRetried: 0, shutdownJobsRetried: 0, skipped: 0, failed: 1 })).toBe(false);
    expect(canCleanExpiredPipelineJobs({ terminalized: 1, finalizersRetried: 0, shutdownJobsRetried: 0, skipped: 0, failed: 0 })).toBe(true);
  });

  it('terminalizes a wall-clock deadline immediately and releases through the finalizer', async () => {
    const finalizers: FinalizeJob[] = [];
    const releaseSession = vi.fn(async () => undefined);
    const deps = depsWith();
    deps.enqueue.finalize = async (job) => { finalizers.push(job); };
    deps.releaseSession = releaseSession;
    const { job } = stageJob(0, 3);

    await expect(runPipelineStage(DK_QUEUES.chunk, job, deps, async () => {
      throw new PipelineDeadlineExceededError();
    })).rejects.toBeInstanceOf(PipelineDeadlineExceededError);

    expect(finalizers).toHaveLength(1);
    expect(finalizers[0]?.status).toBe('FAILED');
    await finalizeDistroKidSnapshot(finalizers[0]!, deps);
    expect(releaseSession).toHaveBeenCalledOnce();
  });

  it('awaits terminal failure projection inside the exhausted processor attempt', async () => {
    let unblock = (): void => {};
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const terminalFailure = vi.fn(async () => gate);
    const { job, progress } = stageJob();

    const attempt = runPipelineStage(
      DK_QUEUES.chunk,
      job,
      depsWith(terminalFailure),
      async () => { throw new Error('browser failed'); },
    );
    const observed = attempt.then(() => null, (error: unknown) => error);

    await vi.waitFor(() => expect(terminalFailure).toHaveBeenCalledTimes(1));
    let settled = false;
    void observed.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    unblock();
    await expect(observed).resolves.toMatchObject({ message: 'browser failed' });
    expect(progress()).toMatchObject({ distroKidTerminalFailureHandled: true });
  });

  it('does not terminalize a retryable attempt or recursively terminalize a finalizer', async () => {
    const terminalFailure = vi.fn(async () => undefined);
    const retryable = stageJob(1, 3).job;
    const finalizer = stageJob(2, 3).job;

    await expect(runPipelineStage(DK_QUEUES.index, retryable, depsWith(terminalFailure), async () => {
      throw new Error('retry me');
    })).rejects.toThrow('retry me');
    await expect(runPipelineStage(DK_QUEUES.finalize, finalizer, depsWith(terminalFailure), async () => {
      throw new Error('persistence down');
    })).rejects.toThrow('persistence down');

    expect(terminalFailure).not.toHaveBeenCalled();
  });

  it('treats shutdown as retryable ownership transfer, including after attempts are exhausted', async () => {
    const terminalFailure = vi.fn(async () => undefined);
    const exhausted = stageJob(2, 3).job;
    await expect(runPipelineStage(DK_QUEUES.chunk, exhausted, depsWith(terminalFailure), async () => {
      throw new PipelineShutdownError();
    })).rejects.toBeInstanceOf(PipelineShutdownError);
    expect(terminalFailure).not.toHaveBeenCalled();

    const retry = vi.fn(async () => undefined);
    const failedJob = {
      id: 'shutdown-job', data: REF, attemptsMade: 3, opts: { attempts: 3 },
      failedReason: 'PIPELINE_SHUTDOWN_RETRY: DistroKid pipeline worker is shutting down',
      progress: {}, async updateProgress() {}, retry,
    };
    const queue = { name: DK_QUEUES.chunk, async getFailed() { return [failedJob]; } } as unknown as FailedRecoveryQueue;
    const recovered = await recoverFailedDistroKidJobs([queue], depsWith(terminalFailure));
    expect(recovered.shutdownJobsRetried).toBe(1);
    expect(retry).toHaveBeenCalledWith('failed');
    expect(terminalFailure).not.toHaveBeenCalled();
  });

  it('recovers an unhandled non-final failure once and durably marks it handled', async () => {
    let progress: unknown = {};
    const failedJob = {
      id: 'failed-index', data: REF, attemptsMade: 3, opts: { attempts: 3 }, failedReason: 'exhausted',
      get progress() { return progress; },
      async updateProgress(next: unknown) { progress = next; },
      async retry() {},
    };
    const queue = {
      name: DK_QUEUES.index,
      async getFailed() { return [failedJob]; },
    } as unknown as FailedRecoveryQueue;
    const terminalFailure = vi.fn(async () => undefined);
    const deps = depsWith(terminalFailure);

    const first = await recoverFailedDistroKidJobs([queue], deps);
    const second = await recoverFailedDistroKidJobs([queue], deps);

    expect(first).toMatchObject({ terminalized: 1, failed: 0 });
    expect(second).toMatchObject({ terminalized: 0, skipped: 1 });
    expect(terminalFailure).toHaveBeenCalledTimes(1);
    expect(progress).toMatchObject({ distroKidTerminalFailureHandled: true });
  });

  it('retries an exhausted finalizer with a durable cooldown instead of mis-projecting it', async () => {
    let progress: unknown = {};
    const retry = vi.fn(async () => undefined);
    const failedJob = {
      id: 'failed-finalize', data: REF, attemptsMade: 3, opts: { attempts: 3 }, failedReason: 'database unavailable',
      get progress() { return progress; },
      async updateProgress(next: unknown) { progress = next; },
      retry,
    };
    const queue = {
      name: DK_QUEUES.finalize,
      async getFailed() { return [failedJob]; },
    } as unknown as FailedRecoveryQueue;
    const terminalFailure = vi.fn(async () => undefined);
    const deps = depsWith(terminalFailure);

    const first = await recoverFailedDistroKidJobs([queue], deps, { now: () => 1_000 });
    const duringCooldown = await recoverFailedDistroKidJobs([queue], deps, { now: () => 2_000 });

    expect(first).toMatchObject({ finalizersRetried: 1, failed: 0 });
    expect(duringCooldown).toMatchObject({ finalizersRetried: 0, skipped: 1 });
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith('failed');
    expect(terminalFailure).not.toHaveBeenCalled();
    expect(progress).toMatchObject({
      distroKidFinalizeRecoveryAttempts: 1,
      distroKidFinalizeRecoveryNotBefore: 31_000,
    });
  });
});
