import { describe, expect, it, vi } from 'vitest';
import { DISTROKID_JOB_SCHEMA_VERSION, type CatalogIndexJob } from '@sentinel/contracts';
import type { DistroKidRecoveryRepository } from '@sentinel/db';
import { InMemorySnapshotStore } from './snapshot-store';
import { InMemoryConnectionLock } from './locks';
import { recoverDurableDistroKidSnapshots } from './composition';
import type { PipelineDeps } from './pipeline';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');

function recoveryJob(snapshotId: string): CatalogIndexJob {
  return {
    tenantId: 'tenant-recovery',
    connectionId: 'connection-recovery',
    snapshotId,
    distributor: 'distrokid',
    artists: ['Recovery Artist'],
    consentId: 'consent-recovery',
    artistWorkspaceId: 'workspace-recovery',
    steelSessionId: 'v1.encrypted-steel-session-handle',
    sessionExpiresAt: new Date(NOW + 30 * 60_000).toISOString(),
    deadlineAt: new Date(NOW + 20 * 60_000).toISOString(),
    schemaVersion: DISTROKID_JOB_SCHEMA_VERSION,
  };
}

function recoveryRepository(jobs: CatalogIndexJob[]): DistroKidRecoveryRepository & {
  clear: ReturnType<typeof vi.fn>;
} {
  return {
    async prepare(job) { return job; },
    async list() { return jobs; },
    clear: vi.fn(async () => true),
  };
}

function pipelineDeps(store: InMemorySnapshotStore) {
  const lock = new InMemoryConnectionLock();
  const enqueue = {
    plan: vi.fn(async () => undefined),
    chunk: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
  };
  const deps: PipelineDeps = {
    store,
    acquireLock: async (job) => lock.acquire(job.tenantId, job.connectionId),
    readCatalogIndex: vi.fn(async () => []),
    extractChunk: vi.fn(async () => []),
    enqueue,
    persistSnapshot: vi.fn(async () => undefined),
    now: () => NOW,
    requireDeadline: true,
  };
  return { deps, enqueue };
}

describe('durable DistroKid queue-loss recovery', () => {
  it('requeues the catalog index with the same encrypted Steel handle when Redis lost stage one', async () => {
    const job = recoveryJob('recovery-no-index');
    const store = new InMemorySnapshotStore();
    const recovery = recoveryRepository([job]);
    const { deps, enqueue } = pipelineDeps(store);
    const startSnapshot = vi.fn(async (_job: CatalogIndexJob) => undefined);
    const releaseCancelled = vi.fn(async () => undefined);

    const stats = await recoverDurableDistroKidSnapshots(
      recovery,
      deps,
      startSnapshot,
      releaseCancelled,
      { now: () => NOW },
    );

    expect(stats).toEqual({
      examined: 1,
      indexRequeued: 1,
      checkpointResumed: 0,
      finalizersRequeued: 0,
      expiredTerminalized: 0,
      cancelledReleased: 0,
      failed: 0,
    });
    expect(startSnapshot).toHaveBeenCalledOnce();
    expect(startSnapshot).toHaveBeenCalledWith(job);
    expect(startSnapshot.mock.calls[0]![0].steelSessionId).toBe(job.steelSessionId);
    expect(enqueue.chunk).not.toHaveBeenCalled();
    expect(recovery.clear).not.toHaveBeenCalled();
  });

  it('rebuilds only the first unfinished chunk from durable checkpoints after queue loss', async () => {
    const job = recoveryJob('recovery-checkpointed');
    const store = new InMemorySnapshotStore();
    await store.bindSnapshot({
      tenantId: job.tenantId,
      connectionId: job.connectionId,
      snapshotId: job.snapshotId,
      distributor: job.distributor,
    });
    const releaseIds = Array.from({ length: 45 }, (_, index) => `release-${index}`);
    await store.putIndex(job.snapshotId, releaseIds.map((releaseId) => ({
      releaseId,
      dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=${releaseId}`,
    })));
    await store.putPassPlan(job.snapshotId, 1, [
      releaseIds.slice(0, 20),
      releaseIds.slice(20, 40),
      releaseIds.slice(40),
    ]);
    await store.markChunkComplete(job.snapshotId, 1, 0);

    const recovery = recoveryRepository([job]);
    const { deps, enqueue } = pipelineDeps(store);
    const startSnapshot = vi.fn(async (_job: CatalogIndexJob) => undefined);

    const stats = await recoverDurableDistroKidSnapshots(
      recovery,
      deps,
      startSnapshot,
      vi.fn(async () => undefined),
      { now: () => NOW },
    );

    expect(stats.checkpointResumed).toBe(1);
    expect(stats.failed).toBe(0);
    expect(startSnapshot).not.toHaveBeenCalled();
    expect(enqueue.chunk).toHaveBeenCalledOnce();
    expect(enqueue.chunk).toHaveBeenCalledWith(expect.objectContaining({
      snapshotId: job.snapshotId,
      chunkIndex: 1,
      pass: 1,
      passChunkCount: 3,
      releaseIds: releaseIds.slice(20, 40),
      steelSessionId: job.steelSessionId,
      deadlineAt: job.deadlineAt,
      sessionExpiresAt: job.sessionExpiresAt,
    }));
    expect(recovery.clear).not.toHaveBeenCalled();
  });
});
