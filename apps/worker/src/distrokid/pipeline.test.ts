import { describe, it, expect, vi } from 'vitest';
import type { ReleaseExtractionOutcome, CanonicalDistributorRelease } from '@sentinel/browser-assist';
import { present, absentAtSource } from '@sentinel/browser-assist';
import { InMemorySnapshotStore, type ReleaseRefRecord } from './snapshot-store';
import { InMemoryConnectionLock, backoffWithJitter, startLockHeartbeat, type HeldLock } from './locks';
import {
  extractDistroKidCatalogIndex, planDistroKidReleaseChunks, extractDistroKidReleaseChunk,
  retryFailedDistroKidReleases, reconcileDistroKidSnapshot, finalizeDistroKidSnapshot,
  jobIds, chunkReleases, DISTROKID_RELEASE_CHUNK_SIZE, AccountLockUnavailableError,
  LockLostError, terminalizeDistroKidFailure,
  type PipelineDeps, type ReleaseChunkJob, type SnapshotRef, type FinalizeJob,
} from './pipeline';
import { InMemoryExtractionMetrics, extractionLog } from './metrics';

const REF: SnapshotRef = { tenantId: 't1', connectionId: 'c1', snapshotId: 's1', distributor: 'distrokid' };

const mkRelease = (id: string, withIsrc = true): CanonicalDistributorRelease => ({
  distributorReleaseId: id,
  title: `Release ${id}`,
  upc: present('199751675992', 'NETWORK_JSON', 'v1'),
  artworkUrl: present('https://cdn/x.jpg', 'NETWORK_JSON', 'v1'),
  releaseDate: present('2025-01-01', 'NETWORK_JSON', 'v1'),
  tracks: [{ title: `Track ${id}`, isrc: withIsrc ? present(`USKE1231${id.padStart(4, '0')}`, 'NETWORK_JSON', 'v1') : absentAtSource('NETWORK_JSON', 'v1') }],
});
const completed = (id: string): ReleaseExtractionOutcome => ({ kind: 'COMPLETED', release: mkRelease(id), source: 'NETWORK_JSON', elapsedMs: 5 });
const failed = (id: string, reason: 'TIMEOUT' | 'NOT_AUTHORIZED' = 'TIMEOUT'): ReleaseExtractionOutcome => ({ kind: 'FAILED', distributorReleaseId: id, reason, detail: 'x', elapsedMs: 5 });

function refs(n: number, offset = 0): ReleaseRefRecord[] {
  return Array.from({ length: n }, (_, i) => ({ releaseId: `R${i + offset}`, dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${i + offset}` }));
}

/** Test harness: records what was enqueued, so we can assert the pipeline's control flow. */
function harness(overrides: Partial<PipelineDeps> = {}) {
  const store = new InMemorySnapshotStore();
  const lock = new InMemoryConnectionLock();
  const enqueued = { plan: [] as unknown[], chunk: [] as ReleaseChunkJob[], retry: [] as unknown[], reconcile: [] as unknown[], finalize: [] as FinalizeJob[] };
  const persisted: ReleaseExtractionOutcome[][] = [];
  const metrics = new InMemoryExtractionMetrics();
  const deps: PipelineDeps = {
    store,
    metrics,
    async readCatalogIndex() { return refs(5); },
    async extractChunk(job, r) { return r.map((x) => completed(x.releaseId)); },
    async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
    enqueue: {
      async plan(j) { enqueued.plan.push(j); },
      async chunk(j) { enqueued.chunk.push(j); },
      async retry(j) { enqueued.retry.push(j); },
      async reconcile(j) { enqueued.reconcile.push(j); },
      async finalize(j) { enqueued.finalize.push(j); },
    },
    async persistSnapshot(_job, outcomes) { persisted.push(outcomes); },
    ...overrides,
  };
  return { deps, store, lock, enqueued, persisted, metrics };
}

describe('pipeline: idempotent job ids', () => {
  it('is stable per (tenant, connection, snapshot, chunk) so duplicates are no-ops', () => {
    // This deliberately asserts PROPERTIES, not a literal. It used to pin the exact string
    // `distrokid-release-chunk:t1:c1:s1:3` — which BullMQ rejects outright ("Custom Id cannot
    // contain :"), so the test was locking in a format that could never enqueue. Pinning the
    // literal made the broken format look intentional; see packages/contracts/src/job-ids.test.ts.
    expect(jobIds.chunk(REF, 3)).not.toContain(':');
    expect(jobIds.chunk(REF, 3)).toBe(jobIds.chunk(REF, 3));
    expect(jobIds.chunk(REF, 4)).not.toBe(jobIds.chunk(REF, 3));
    expect(jobIds.index(REF)).not.toBe(jobIds.reconcile(REF));
    // A retry pass must not collide with the original chunk job id.
    expect(jobIds.retry(REF, 2)).not.toBe(jobIds.chunk(REF, 2));
    // A lock-deferred chunk must get a DIFFERENT id, or BullMQ discards it as a duplicate and
    // the chunk is silently never run.
    expect(jobIds.chunk(REF, 3, 1)).not.toBe(jobIds.chunk(REF, 3, 0));
  });
});

describe('pipeline: index → plan → chunks', () => {
  it('records the index as the authoritative expectation and plans release chunks', async () => {
    const h = harness({ async readCatalogIndex() { return refs(45); } });
    await extractDistroKidCatalogIndex({ ...REF, artists: ['Lewis KE'] }, h.deps);
    expect((await h.store.getIndex('s1')).length).toBe(45);
    expect(h.enqueued.plan.length).toBe(1);

    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    // 45 releases / 20 per chunk = 3 chunks
    expect(h.enqueued.chunk.length).toBe(1); // only the head of the durable sequential chain
    expect(h.enqueued.chunk[0]!.releaseIds.length).toBe(DISTROKID_RELEASE_CHUNK_SIZE);
    expect((await h.store.getPassPlan('s1', 1))?.map((chunk) => chunk.length)).toEqual([20, 20, 5]);
  });

  it('chunks by RELEASE, not by track', () => {
    expect(chunkReleases(refs(45)).map((c) => c.length)).toEqual([20, 20, 5]);
  });

  it('uses the per-account distributed lock for the catalog index too', async () => {
    const h = harness();
    await h.lock.acquire('t1', 'c1');
    await expect(extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps))
      .rejects.toBeInstanceOf(AccountLockUnavailableError);
    expect(await h.store.getIndex('s1')).toEqual([]);
  });

  it('RESUME: a replanned snapshot skips chunks already completed', async () => {
    const h = harness({ async readCatalogIndex() { return refs(45); } });
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await h.store.markChunkComplete('s1', 1, 0);
    await h.store.markChunkComplete('s1', 1, 1);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    expect(h.enqueued.chunk.map((c) => c.chunkIndex)).toEqual([2]); // only the unfinished chunk
  });
});

describe('pipeline: chunk extraction, locking, checkpointing', () => {
  it('extracts a chunk and checkpoints outcomes idempotently', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(3));
    await h.store.putProgress({ snapshotId: 's1', tenantId: 't1', connectionId: 'c1', distributor: 'distrokid', status: 'RUNNING', expectedReleases: 3, completedReleases: 0, failedReleases: 0, chunkCount: 1, completedChunks: [], startedAt: 'x', updatedAt: 'x' });
    const res = await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1', 'R2'] }, h.deps);
    expect(res.completed).toBe(3);
    expect((await h.store.getOutcomes('s1')).length).toBe(3);
    expect(await h.store.completedChunks('s1', 1)).toEqual([0]);
    // Last chunk done → reconcile is enqueued automatically.
    expect(h.enqueued.reconcile.length).toBe(1);
  });

  it('re-running the same chunk does not duplicate records (idempotent by releaseId)', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(3));
    const job: ReleaseChunkJob = { ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1', 'R2'] };
    await extractDistroKidReleaseChunk(job, h.deps);
    await extractDistroKidReleaseChunk(job, h.deps);
    expect((await h.store.getOutcomes('s1')).length).toBe(3); // not 6
  });

  it('defers (requeues) rather than hammering an account another worker holds', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await h.lock.acquire('t1', 'c1'); // simulate another worker holding this connection
    const res = await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0'] }, h.deps);
    expect(res.deferred).toBe(true);
    expect(h.enqueued.chunk.length).toBe(1); // requeued, not dropped
  });

  it('releases the lock so a subsequent chunk can proceed', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0'] }, h.deps);
    const after = await h.lock.acquire('t1', 'c1');
    expect(after).not.toBeNull();
  });

  it('CRASH RESUME: already-completed releases inside a chunk are not re-extracted', async () => {
    const seen: string[] = [];
    const h = harness({
      async extractChunk(_job, r) { seen.push(...r.map((x) => x.releaseId)); return r.map((x) => completed(x.releaseId)); },
    });
    await h.store.putIndex('s1', refs(3));
    await h.store.putOutcomes('s1', [completed('R0')]); // R0 done before the "crash"
    await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1', 'R2'] }, h.deps);
    expect(seen).toEqual(['R1', 'R2']); // R0 skipped
  });

  it('checkpoints mid-chunk so a crash resumes from the last checkpoint', async () => {
    const h = harness({
      async extractChunk(_job, r, onCheckpoint) {
        const out: ReleaseExtractionOutcome[] = [];
        for (const x of r) {
          out.push(completed(x.releaseId));
          if (out.length % 2 === 0) await onCheckpoint([...out]); // batched checkpoint
        }
        return out;
      },
    });
    await h.store.putIndex('s1', refs(4));
    await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1', 'R2', 'R3'] }, h.deps);
    expect((await h.store.getOutcomes('s1')).length).toBe(4);
  });

  it('checks lock ownership before every release and quiesces before releasing a lost lock', async () => {
    vi.useFakeTimers();
    try {
      let navigations = 0;
      let released = false;
      const held: HeldLock = {
        key: 'k', token: 't',
        async extend() { return false; },
        async release() { released = true; },
      };
      const h = harness({
        async acquireLock() { return held; },
        async extractChunk(_job, r, _checkpoint, control) {
          const out: ReleaseExtractionOutcome[] = [];
          for (const ref of r) {
            await control.assertCanContinue();
            navigations++;
            out.push(completed(ref.releaseId));
            if (navigations === 1) await vi.advanceTimersByTimeAsync(40_100);
            await control.assertCanContinue();
          }
          return out;
        },
      });
      await h.store.putIndex('s1', refs(3));
      await expect(extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1', 'R2'] }, h.deps))
        .rejects.toBeInstanceOf(LockLostError);
      expect(navigations).toBe(1);
      expect(released).toBe(true);
      expect(await h.store.getOutcomes('s1')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pipeline: retry FAILED releases only', () => {
  it('re-enqueues only the failed/unresolved releases, never the whole catalogue', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(4));
    await h.store.putOutcomes('s1', [completed('R0'), completed('R1'), failed('R2')]); // R3 never attempted
    await retryFailedDistroKidReleases({ ...REF, attempt: 2 }, h.deps);
    expect(h.enqueued.chunk.length).toBe(1);
    expect(h.enqueued.chunk[0]!.releaseIds.sort()).toEqual(['R2', 'R3']);
  });

  it('does not retry a non-retryable failure (NOT_AUTHORIZED)', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(1));
    await h.store.putOutcomes('s1', [failed('R0', 'NOT_AUTHORIZED')]);
    await retryFailedDistroKidReleases({ ...REF, attempt: 2 }, h.deps);
    expect(h.enqueued.chunk.length).toBe(0);
    expect(h.enqueued.reconcile.length).toBe(1); // goes straight to reconcile
  });

  it('stops retrying past the max attempts', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await h.store.putOutcomes('s1', [failed('R0')]);
    await retryFailedDistroKidReleases({ ...REF, attempt: 99 }, h.deps);
    expect(h.enqueued.chunk.length).toBe(0);
    expect(h.enqueued.reconcile.length).toBe(1);
  });
});

describe('pipeline: reconcile + finalize', () => {
  it('a fully-successful snapshot finalizes as COMPLETE', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await h.store.putOutcomes('s1', [completed('R0'), completed('R1')]);
    const { status } = await reconcileDistroKidSnapshot({ ...REF }, h.deps);
    expect(status).toBe('COMPLETE');
    expect(h.enqueued.finalize.length).toBe(1);
    await finalizeDistroKidSnapshot(h.enqueued.finalize[0]!, h.deps);
    expect(h.persisted[0]!.length).toBe(2);
    expect((await h.store.getProgress('s1'))?.status).toBe('COMPLETE');
  });

  it('uses independently indexed track counts and refuses a truncated release result', async () => {
    const h = harness();
    await h.store.putIndex('s1', [
      { ...refs(1)[0]!, expectedTrackCount: 2 },
      { ...refs(1, 1)[0]!, expectedTrackCount: 1 },
    ]);
    await h.store.putOutcomes('s1', [completed('R0'), completed('R1')]);
    const { status, completeness } = await reconcileDistroKidSnapshot({ ...REF, pass: 99 }, h.deps);
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(completeness).toMatchObject({ expectedTracksKnown: true, expectedTracks: 3, extractedTracks: 2 });
  });

  it('a snapshot with gaps triggers a targeted retry pass instead of finalizing', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await h.store.putOutcomes('s1', [completed('R0'), failed('R1')]);
    const { status } = await reconcileDistroKidSnapshot({ ...REF, pass: 1 }, h.deps);
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(h.enqueued.retry.length).toBe(1);
    expect(h.enqueued.finalize.length).toBe(0); // NOT marked complete
  });

  it('finalizes as PARTIAL_RETRYABLE once retries are exhausted — never silently "complete"', async () => {
    const h = harness();
    await h.store.putIndex('s1', refs(2));
    await h.store.putOutcomes('s1', [completed('R0'), failed('R1')]);
    const { status } = await reconcileDistroKidSnapshot({ ...REF, pass: 99 }, h.deps);
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(h.enqueued.finalize.length).toBe(1);
  });

  it('checkpoints the terminal projection before session cleanup and retries cleanup only', async () => {
    const persistSnapshot = vi.fn(async () => undefined);
    let releaseCalls = 0;
    const releaseSession = vi.fn(async () => {
      releaseCalls++;
      if (releaseCalls === 1) throw new Error('provider temporarily unavailable');
    });
    const h = harness({ persistSnapshot, releaseSession });
    await h.store.putIndex('s1', refs(1));
    await h.store.putOutcomes('s1', [completed('R0')]);
    await reconcileDistroKidSnapshot({ ...REF }, h.deps);
    const finalJob = h.enqueued.finalize[0]!;

    // Projection and progress succeed; only remote cleanup fails.
    await expect(finalizeDistroKidSnapshot(finalJob, h.deps)).rejects.toThrow(/provider/i);
    expect(persistSnapshot).toHaveBeenCalledTimes(1);
    expect((await h.store.getProgress('s1'))?.status).toBe('COMPLETE');

    // BullMQ/recovery retries the finalizer, but the durable projection is not run twice.
    await finalizeDistroKidSnapshot(finalJob, h.deps);
    expect(persistSnapshot).toHaveBeenCalledTimes(1);
    expect(releaseSession).toHaveBeenCalledTimes(2);
  });

  it('makes the first terminal verdict immutable and queued siblings no-op', async () => {
    const extractChunk = vi.fn(async () => [completed('R0')]);
    const h = harness({ extractChunk });
    await h.store.putIndex('s1', refs(1));
    await h.store.putOutcomes('s1', [completed('R0')]);
    await reconcileDistroKidSnapshot({ ...REF, pass: 1 }, h.deps);
    expect((await h.store.getTerminal('s1'))?.kind).toBe('TERMINAL');

    const sibling = await extractDistroKidReleaseChunk({ ...REF, pass: 1, chunkIndex: 0, releaseIds: ['R0'] }, h.deps);
    expect(sibling.stopped).toBe(true);
    expect(extractChunk).not.toHaveBeenCalled();

    await terminalizeDistroKidFailure(REF, 'late-sibling', new Error('late failure'), h.deps);
    const tombstone = await h.store.getTerminal('s1');
    expect(tombstone?.kind === 'TERMINAL' ? tombstone.finalizeJob.status : null).toBe('COMPLETE');
  });
});

describe('backoff + observability', () => {
  it('exponential backoff is jittered (never a synchronized retry storm)', () => {
    expect(backoffWithJitter(1, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffWithJitter(3, 1000, 60_000, () => 1)).toBe(4000);
    expect(backoffWithJitter(3, 1000, 60_000, () => 0)).toBe(0); // full jitter can be 0
    expect(backoffWithJitter(99, 1000, 60_000, () => 1)).toBe(60_000); // capped
  });

  it('metrics track coverage and endpoint success rate', () => {
    const m = new InMemoryExtractionMetrics();
    m.releasesExpected(10, REF);
    m.releasesCompleted(8, REF);
    m.releasesFailed(2, REF);
    m.tracks(20, 18);
    m.releaseCoverage(7, 6);
    m.endpointOutcome('fingerprint-abc', true);
    m.endpointOutcome('fingerprint-abc', false);
    m.schemaDrift();
    m.chunkDuration(1200, REF);
    const snap = m.read();
    expect(snap.releasesExpected).toBe(10);
    expect(snap.releasesAttempted).toBe(10);
    expect(snap.tracksWithIsrc).toBe(18);
    expect(snap.releasesWithUpc).toBe(7);
    expect(snap.schemaDriftCount).toBe(1);
    expect(m.endpointSuccessRate('fingerprint-abc')).toBe(0.5);
    expect(m.avgChunkMs).toBe(1200);
  });

  it('structured logs carry ids + fingerprint only — never secrets or bodies', () => {
    const line = extractionLog({
      tenantId: 't1', connectionId: 'c1', scanId: 's1', releaseId: 'R1',
      endpointFingerprint: 'abcdef0123456789deadbeef', parserVersion: 'distrokid-parser-v1',
      outcome: 'COMPLETED', elapsedMs: 42,
    }, REF);
    const parsed = JSON.parse(line);
    expect(parsed.tenantId).toBe('t1');
    expect(parsed.endpointFingerprint).toBe('abcdef0123456789'); // truncated hash
    expect(line).not.toMatch(/cookie|authorization|token|password/i);
  });
});

describe('pipeline: the account lock is renewed on a TIMER, not on checkpoint cadence', () => {
  it('renews the lock while a slow release runs, without any checkpoint being written', async () => {
    // The defect: renewal only happened when a checkpoint batch was written (every 10 releases).
    // A single release slower than the 120s TTL let the lock expire mid-chunk, so a second worker
    // could start reading the same distributor account — the exact thing the lock prevents,
    // happening when the account is already slowest.
    vi.useFakeTimers();
    try {
      const extends_: number[] = [];
      const lock: HeldLock = {
        key: 'k', token: 't',
        async extend(ttl) { extends_.push(ttl); return true; },
        async release() {},
      };
      const hb = startLockHeartbeat(lock, { ttlMs: 3_000, onLost: () => {} });
      // 10 seconds of one slow release: no checkpoints, no batches, no progress at all.
      await vi.advanceTimersByTimeAsync(10_000);
      hb.stop();
      // Renewal happens on the clock. Renewing at a third of the TTL tolerates a blip or two
      // before anything expires.
      expect(extends_.length).toBeGreaterThanOrEqual(3);
      expect(extends_.every((t) => t === 3_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the lock LOST when renewal fails — the caller must abort, not carry on', async () => {
    vi.useFakeTimers();
    try {
      let lost: string | null = null;
      const lock: HeldLock = {
        key: 'k', token: 't',
        // false = someone else holds it now (our token no longer matches).
        async extend() { return false; },
        async release() {},
      };
      startLockHeartbeat(lock, { ttlMs: 3_000, onLost: (r) => { lost = r; } });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(lost).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats repeated Redis renewal errors beyond the TTL as lock loss', async () => {
    vi.useFakeTimers();
    try {
      let lost: string | null = null;
      const lock: HeldLock = {
        key: 'k', token: 't',
        async extend() { throw new Error('redis unavailable'); },
        async release() {},
      };
      startLockHeartbeat(lock, { ttlMs: 3_000, onLost: (reason) => { lost = reason; } });
      await vi.advanceTimersByTimeAsync(3_100);
      expect(lost).toMatch(/TTL expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops renewing once stopped, so a finished chunk never holds an account open', async () => {
    vi.useFakeTimers();
    try {
      let count = 0;
      const lock: HeldLock = { key: 'k', token: 't', async extend() { count++; return true; }, async release() {} };
      const hb = startLockHeartbeat(lock, { ttlMs: 3_000, onLost: () => {} });
      await vi.advanceTimersByTimeAsync(2_000);
      const afterStop = count;
      hb.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(count).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });
});
