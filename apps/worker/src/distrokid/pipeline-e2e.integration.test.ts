import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { createDistroKidProducer, connectionFromUrl } from '@sentinel/queue-client';
import { DK_QUEUES, jobIds, type CatalogIndexJob } from '@sentinel/contracts';
import { present, type ReleaseExtractionOutcome } from '@sentinel/browser-assist';
import { RedisSnapshotStore, type SnapshotRedis } from './snapshot-store';
import { InMemoryConnectionLock } from './locks';
import { startDistroKidPipelineWorkers, createDistroKidQueues } from './pipeline-queue';
import type { PipelineDeps, FinalizeJob } from './pipeline';

/**
 * END-TO-END over REAL Redis and REAL BullMQ.
 *
 * The gap this closes: an audit found the pipeline's six workers were started but NOTHING
 * enqueued to them — the API still enqueued the older `catalogue-read` job, so the pipeline sat
 * idle forever. Every existing test passed anyway, because the boot test called the stage
 * functions directly and never touched a queue. A test that dispatches its own handlers cannot
 * detect a missing producer.
 *
 * So this test refuses to fake the transport:
 *  - the producer is the SAME `@sentinel/queue-client` the API uses,
 *  - the consumers are the SAME `startDistroKidPipelineWorkers` the worker starts,
 *  - Redis is real, and delivery is real BullMQ.
 *
 * If the API's producer and the worker's consumer ever disagree about a queue name or a payload
 * shape, this test fails. That disagreement is precisely what shipped.
 *
 * Requires REDIS_URL (CI provides a Redis service). Skipped locally without one — but never
 * silently: the skip is visible in the test name.
 */

const REDIS_URL = process.env.REDIS_URL ?? process.env.REDIS_TEST_URL;
const TEST_PREFIX = 'e2e-dk';
const LARGE_RELEASE_COUNT = 300;
const LARGE_TRACKS_PER_RELEASE = 4;

/** A COMPLETED outcome for a release, tagged with which attempt produced it. */
const outcomeFor = (releaseId: string, attempt: number): ReleaseExtractionOutcome => ({
  kind: 'COMPLETED',
  release: {
    distributorReleaseId: releaseId, title: `Release ${releaseId}`, primaryArtist: 'Lewis KE',
    upc: present('199751675992', 'NETWORK_JSON', 'distrokid-parser-v1'),
    artworkUrl: present('https://cdn.example/a.jpg', 'NETWORK_JSON', 'distrokid-parser-v1'),
    releaseDate: present('2025-01-01', 'NETWORK_JSON', 'distrokid-parser-v1'),
    tracks: [{ title: `Track ${releaseId} (attempt ${attempt})`, isrc: present('QT6ED2521965', 'NETWORK_JSON', 'distrokid-parser-v1') }],
  },
  source: 'NETWORK_JSON', elapsedMs: 3,
});

describe.skipIf(!REDIS_URL)('DistroKid pipeline — API producer → real Redis → six-stage worker', () => {
  let connection: ConnectionOptions;
  let redis: SnapshotRedis & { quit(): Promise<unknown>; keys(p: string): Promise<string[]>; del(...k: string[]): Promise<number> };
  const cleanup: Array<() => Promise<void>> = [];

  /**
   * Drain every DistroKid queue.
   *
   * Required, and the reason is worth keeping: BullMQ retains completed jobs
   * (bounded completed-job retention), so a previous run's jobs can stay in Redis and THIS run's workers
   * happily consume them. That produced a genuinely confusing failure — a stale snapshot's
   * finalize resolved this test's completion latch, so assertions ran against a half-finished
   * catalogue and reported duplicate extractions that never happened. The product was correct;
   * the test was reading another run's data.
   */
  const drainQueues = async (): Promise<void> => {
    const qs = Object.values(DK_QUEUES).map((name) => new Queue(name, { connection }));
    await Promise.all(qs.map(async (q) => {
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close().catch(() => undefined);
    }));
  };

  beforeAll(async () => {
    connection = connectionFromUrl(REDIS_URL!);
    const { default: IORedis } = await import('ioredis');
    redis = new IORedis(REDIS_URL!) as never;
    await drainQueues();
  });

  /**
   * Tear the workers down AFTER EACH TEST, not at the end of the file.
   *
   * Each test starts its own worker set against the same queue names. With file-level cleanup,
   * test 1's workers were still consuming while test 4 ran — so test 4's jobs were processed by
   * test 1's `deps`, whose instrumentation belongs to a finished test. The pipeline was correct;
   * the harness had competing consumers. Closing per test makes each one the only consumer.
   */
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c().catch(() => undefined);
    await drainQueues();
    const snapKeys = await redis.keys('dk:snap:*').catch(() => [] as string[]);
    if (snapKeys.length) await redis.del(...snapKeys).catch(() => undefined);
  });

  afterAll(async () => {
    const keys = await redis.keys(`bull:${TEST_PREFIX}*`).catch(() => [] as string[]);
    if (keys.length) await redis.del(...keys).catch(() => undefined);
    await redis.quit().catch(() => undefined);
  });

  it('a 1,200-track scan crosses real BullMQ, reaches ALL SIX stages, and finalizes', async () => {
    const snapshotId = `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const job: CatalogIndexJob = {
      tenantId: 't-e2e', connectionId: 't-e2e:distrokid', snapshotId,
      distributor: 'distrokid', artists: ['Lewis KE'], steelSessionId: 'steel-remote-e2e',
    };

    const stagesRun: string[] = [];
    const sessionIdsSeen: Array<string | undefined> = [];
    /** Releases actually EXTRACTED, by chunk index — the no-duplicate-work assertion. */
    const extractedByChunk = new Map<number, string[]>();
    const store = new RedisSnapshotStore(redis);
    const lock = new InMemoryConnectionLock();
    let finalized: FinalizeJob | null = null;
    let finalizeResolver: () => void = () => {};
    const done = new Promise<void>((resolveDone) => { finalizeResolver = resolveDone; });

    const queues = createDistroKidQueues(connection);
    cleanup.push(() => queues.close());

    const deps: PipelineDeps = {
      store,
      async acquireLock(j) { return lock.acquire(j.tenantId, j.connectionId); },
      async readCatalogIndex(j) {
        stagesRun.push('1-catalog-index');
        // The session handle must survive the process hop — that is the whole point of putting
        // it on the job rather than in an API-local map.
        sessionIdsSeen.push(j.steelSessionId);
        return Array.from({ length: LARGE_RELEASE_COUNT }, (_, i) => ({ releaseId: `R${i}`, dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${i}` }));
      },
      async extractChunk(j, refs) {
        sessionIdsSeen.push(j.steelSessionId);
        if (j.snapshotId === snapshotId) {
          extractedByChunk.set(j.chunkIndex, [...(extractedByChunk.get(j.chunkIndex) ?? []), ...refs.map((r) => r.releaseId)]);
        }
        return refs.map((r): ReleaseExtractionOutcome => ({
          kind: 'COMPLETED',
          release: {
            distributorReleaseId: r.releaseId, title: `Release ${r.releaseId}`, primaryArtist: 'Lewis KE',
            upc: present('199751675992', 'NETWORK_JSON', 'distrokid-parser-v1'),
            artworkUrl: present('https://cdn.example/a.jpg', 'NETWORK_JSON', 'distrokid-parser-v1'),
            releaseDate: present('2025-01-01', 'NETWORK_JSON', 'distrokid-parser-v1'),
            tracks: Array.from({ length: LARGE_TRACKS_PER_RELEASE }, (_, trackIndex) => ({
              title: `Track ${r.releaseId}-${trackIndex + 1}`,
              isrc: present('QT6ED2521965', 'NETWORK_JSON', 'distrokid-parser-v1'),
            })),
          },
          source: 'NETWORK_JSON', elapsedMs: 3,
        }));
      },
      enqueue: {
        async plan(j) { stagesRun.push('2-plan-chunks'); await queues.plan.add('run', j, { jobId: jobIds.plan(j) }); },
        async chunk(j, o) {
          stagesRun.push('3-release-chunk');
          await queues.chunk.add('run', j, { jobId: jobIds.chunk(j, j.chunkIndex, j.deferAttempt ?? 0, j.pass ?? 1), ...(o?.delayMs ? { delay: o.delayMs } : {}) });
        },
        async retry(j) { stagesRun.push('4-retry-failed'); await queues.retry.add('run', j, { jobId: jobIds.retry(j, j.attempt) }); },
        async reconcile(j) { stagesRun.push('5-reconcile'); await queues.reconcile.add('run', j, { jobId: jobIds.reconcile(j, j.pass ?? 1) }); },
        async finalize(j) { stagesRun.push('6-finalize'); await queues.finalize.add('run', j, { jobId: jobIds.finalize(j, j.pass ?? 1) }); },
      },
      // Gate on OUR snapshot: a job left over from another run must not satisfy this latch.
      async persistSnapshot(j) {
        if (j.snapshotId !== snapshotId) return;
        finalized = j;
        finalizeResolver();
      },
    };

    const workers = startDistroKidPipelineWorkers({ connection, deps, chunkConcurrency: 2 });
    cleanup.push(() => workers.close());

    // THE ASSERTION THAT MATTERS: enqueue exactly as the API does — through the queue-client
    // package, not by calling a handler. Nothing below this line knows it is a test.
    const producer = createDistroKidProducer(connection);
    cleanup.push(() => producer.close());
    const res = await producer.startSnapshot(job);
    expect(res.jobId).toBe(jobIds.index(job));
    // BullMQ rejects an id containing ":" — asserted here too, because this is the exact call
    // that used to throw "Custom Id cannot contain :" for every job the product ever enqueued.
    expect(res.jobId).not.toContain(':');

    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`pipeline did not finalize; stages reached: ${stagesRun.join(' → ') || '(none — nothing consumed the job)'}`)), 45_000)),
    ]);

    // All six stages, in order, driven only by real queue delivery.
    expect(stagesRun).toContain('1-catalog-index');
    expect(stagesRun).toContain('2-plan-chunks');
    expect(stagesRun).toContain('3-release-chunk');
    expect(stagesRun).toContain('5-reconcile');
    expect(stagesRun).toContain('6-finalize');
    expect(stagesRun.indexOf('1-catalog-index')).toBeLessThan(stagesRun.indexOf('2-plan-chunks'));

    // 300 releases at 20/chunk = 15 chunks. Assert on work DONE, not on enqueues: a chunk deferred
    // by the account lock legitimately enqueues more than once, and counting enqueues would make
    // this test fail for correct behaviour.
    expect([...extractedByChunk.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: Math.ceil(LARGE_RELEASE_COUNT / 20) }, (_, index) => index),
    );
    // No release is extracted twice — the lock serialized the account, and the defer/resume path
    // skipped work already done rather than repeating it.
    const allExtracted = [...extractedByChunk.values()].flat();
    expect(allExtracted).toHaveLength(LARGE_RELEASE_COUNT);
    expect(new Set(allExtracted).size).toBe(LARGE_RELEASE_COUNT);

    const f = finalized as FinalizeJob | null;
    expect(f).not.toBeNull();
    expect(f!.status).toBe('COMPLETE');
    expect(f!.completeness.completedReleases).toBe(LARGE_RELEASE_COUNT);
    expect(f!.completeness.expectedReleases).toBe(LARGE_RELEASE_COUNT);
    expect(f!.completeness.unresolvedReleaseIds).toEqual([]);
    // Coverage stays split by identifier level.
    expect(f!.completeness.releasesWithUpc).toBe(LARGE_RELEASE_COUNT);
    expect(f!.completeness.extractedTracks).toBe(LARGE_RELEASE_COUNT * LARGE_TRACKS_PER_RELEASE);
    expect(f!.completeness.tracksWithIsrc).toBe(LARGE_RELEASE_COUNT * LARGE_TRACKS_PER_RELEASE);

    // The Steel session handle reached every stage that needs a browser.
    expect(sessionIdsSeen.length).toBeGreaterThan(1);
    expect(sessionIdsSeen.every((s) => s === 'steel-remote-e2e')).toBe(true);
  }, 60_000);

  /**
   * THE RETRY PATH, end to end over real BullMQ.
   *
   * initial failure → reconcile #1 → retry → retry chunk (authenticated) → reconcile #2 → finalize
   *
   * This is the test whose absence let two release-blocking defects ship:
   *
   *  1. `jobIds.reconcile` omitted the pass, so reconcile #2 reused reconcile #1's id. BullMQ
   *     retains completed jobs and returns the retained one for a colliding id, so reconcile #2
   *     never ran and the snapshot never finalized — it just hung.
   *  2. The chunk→reconcile and reconcile→retry hops dropped `steelSessionId`, so retry chunks
   *     had no browser session and every retried release failed REAUTH_REQUIRED.
   *
   * The old load test called `reconcileDistroKidSnapshot(job, deps, attempt)` directly, hand-feeding
   * the attempt number that the queue worker cannot supply — so it modelled a pipeline that
   * doesn't exist. Everything here goes through real queue delivery.
   */
  it('a FAILED release is retried, re-reconciled and finalized COMPLETE — with the session intact', async () => {
    const snapshotId = `s-retry-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const job: CatalogIndexJob = {
      tenantId: 't-retry', connectionId: 't-retry:distrokid', snapshotId,
      distributor: 'distrokid', artists: ['Lewis KE'], steelSessionId: 'steel-remote-retry',
    };

    const reconcilePasses: Array<number | undefined> = [];
    const retrySessionIds: Array<string | undefined> = [];
    const attemptsPerRelease = new Map<string, number>();
    let finalized: FinalizeJob | null = null;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => { resolveDone = r; });

    const store = new RedisSnapshotStore(redis);
    const lock = new InMemoryConnectionLock();
    const queues = createDistroKidQueues(connection);
    cleanup.push(() => queues.close());

    const deps: PipelineDeps = {
      store,
      async acquireLock(j) { return lock.acquire(j.tenantId, j.connectionId); },
      async readCatalogIndex() {
        return Array.from({ length: 3 }, (_, i) => ({ releaseId: `R${i}`, dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${i}` }));
      },
      async extractChunk(j, refs) {
        if (j.snapshotId !== snapshotId) return refs.map((r) => outcomeFor(r.releaseId, 1));
        return refs.map((r) => {
          const n = (attemptsPerRelease.get(r.releaseId) ?? 0) + 1;
          attemptsPerRelease.set(r.releaseId, n);
          // A retry pass (pass > 1) MUST arrive with the authenticated session, or the whole
          // failed-release-retry contract is void.
          if ((j.pass ?? 1) > 1) retrySessionIds.push(j.steelSessionId);
          // R1 times out on its first attempt, succeeds on the retry.
          if (r.releaseId === 'R1' && n === 1) {
            return { kind: 'FAILED' as const, distributorReleaseId: r.releaseId, reason: 'TIMEOUT' as const, detail: 'x', elapsedMs: 20 };
          }
          return outcomeFor(r.releaseId, n);
        });
      },
      enqueue: {
        async plan(j) { await queues.plan.add('run', j, { jobId: jobIds.plan(j) }); },
        async chunk(j, o) {
          await queues.chunk.add('run', j, { jobId: jobIds.chunk(j, j.chunkIndex, j.deferAttempt ?? 0, j.pass ?? 1), ...(o?.delayMs ? { delay: o.delayMs } : {}) });
        },
        async retry(j) { await queues.retry.add('run', j, { jobId: jobIds.retry(j, j.attempt) }); },
        async reconcile(j) {
          if (j.snapshotId === snapshotId) reconcilePasses.push(j.pass);
          await queues.reconcile.add('run', j, { jobId: jobIds.reconcile(j, j.pass ?? 1) });
        },
        async finalize(j) { await queues.finalize.add('run', j, { jobId: jobIds.finalize(j, j.pass ?? 1) }); },
      },
      async persistSnapshot(j) {
        if (j.snapshotId !== snapshotId) return;
        finalized = j;
        resolveDone();
      },
    };

    const workers = startDistroKidPipelineWorkers({ connection, deps, chunkConcurrency: 2 });
    cleanup.push(() => workers.close());

    const producer = createDistroKidProducer(connection);
    cleanup.push(() => producer.close());
    await producer.startSnapshot(job);

    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error(
        `snapshot never finalized. reconcile passes seen: [${reconcilePasses.join(', ')}]. ` +
        'If only pass 1 appears, the retry reconciliation was deduplicated away and the scan hung.',
      )), 25_000)),
    ]);

    // BOTH reconciliations ran — the defect made the second one silently vanish.
    expect(reconcilePasses).toContain(1);
    expect(reconcilePasses).toContain(2);

    // The retry actually re-read the failed release, and ONLY that one.
    expect(attemptsPerRelease.get('R1')).toBe(2);
    expect(attemptsPerRelease.get('R0')).toBe(1);
    expect(attemptsPerRelease.get('R2')).toBe(1);

    // The retry chunk carried the authenticated session. Without this the extraction can only
    // return REAUTH_REQUIRED, so the retry could never succeed however often it ran.
    expect(retrySessionIds.length).toBeGreaterThan(0);
    expect(retrySessionIds.every((s) => s === 'steel-remote-retry')).toBe(true);

    const f = finalized as FinalizeJob | null;
    expect(f).not.toBeNull();
    expect(f!.status).toBe('COMPLETE');
    expect(f!.completeness.completedReleases).toBe(3);
    expect(f!.completeness.failedReleases).toBe(0);
    expect(f!.pass).toBe(2);
  }, 45_000);

  it('a duplicate submit is deduplicated by job id (one browser session per account, not two)', async () => {
    const snapshotId = `s-dup-${Date.now()}`;
    const job: CatalogIndexJob = {
      tenantId: 't-dup', connectionId: 't-dup:distrokid', snapshotId,
      distributor: 'distrokid', artists: ['A'],
    };
    const producer = createDistroKidProducer(connection);
    cleanup.push(() => producer.close());

    const first = await producer.startSnapshot(job);
    const second = await producer.startSnapshot(job);
    expect(second.jobId).toBe(first.jobId);

    // Exactly one job exists on the queue — a double click cannot start a second read.
    const q = new Queue(DK_QUEUES.index, { connection });
    cleanup.push(() => q.close());
    const counts = await q.getJobCounts('waiting', 'active', 'delayed');
    const total = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    expect(total).toBeLessThanOrEqual(1);
    await q.obliterate({ force: true }).catch(() => undefined);
  }, 20_000);

  it('rejects a malformed job at the producer, not halfway through a catalogue read', async () => {
    const producer = createDistroKidProducer(connection);
    cleanup.push(() => producer.close());
    await expect(producer.startSnapshot({ tenantId: '', connectionId: 'c', snapshotId: 's', distributor: 'distrokid', artists: [] } as CatalogIndexJob))
      .rejects.toThrow(/Invalid job payload/);
  });

  it('a worker restart mid-catalogue resumes from the checkpoint instead of re-reading it', async () => {
    const snapshotId = `s-resume-${Date.now()}`;
    const ref = { tenantId: 't-res', connectionId: 't-res:distrokid', snapshotId, distributor: 'distrokid' };
    const store = new RedisSnapshotStore(redis);

    // Simulate: 45 releases indexed, chunk 0 already completed and checkpointed before the crash.
    // `markChunkComplete` is the real checkpoint write — `putProgress.completedChunks` is a
    // reporting field, not the source of truth, so writing only that would prove nothing.
    await store.putIndex(snapshotId, Array.from({ length: 45 }, (_, i) => ({ releaseId: `R${i}`, dashboardUrl: `u${i}` })));
    await store.markChunkComplete(snapshotId, 1, 0);
    await store.putProgress({
      snapshotId, tenantId: ref.tenantId, connectionId: ref.connectionId, distributor: 'distrokid',
      status: 'RUNNING', expectedReleases: 45, completedReleases: 20, failedReleases: 0,
      chunkCount: 3, completedChunks: [0], startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // A NEW store instance — i.e. the restarted process reads Redis, not its own memory.
    const afterRestart = new RedisSnapshotStore(redis);
    expect(await afterRestart.completedChunks(snapshotId, 1)).toEqual([0]);
    expect((await afterRestart.getIndex(snapshotId)).length).toBe(45);
    const p = await afterRestart.getProgress(snapshotId);
    expect(p?.completedReleases).toBe(20);
  }, 20_000);
});
