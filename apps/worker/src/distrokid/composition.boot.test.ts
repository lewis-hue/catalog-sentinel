import { describe, it, expect, vi } from 'vitest';
import type { ReleaseExtractionOutcome } from '@sentinel/browser-assist';
import { present } from '@sentinel/browser-assist';
import { EnvelopeEncryptor } from '@sentinel/security';
import { InMemorySnapshotStore, RedisSnapshotStore, type SnapshotRedis } from './snapshot-store';
import {
  extractDistroKidCatalogIndex, planDistroKidReleaseChunks, extractDistroKidReleaseChunk,
  reconcileDistroKidSnapshot, finalizeDistroKidSnapshot, retryFailedDistroKidReleases,
  type PipelineDeps, type CatalogIndexJob, type ReleaseChunkJob, type FinalizeJob, type SnapshotRef,
} from './pipeline';
import { InMemoryConnectionLock } from './locks';
import {
  closeDistroKidCompositionResources,
  buildDistroKidComposition,
  reportDistroKidDurabilityDegradations,
  steelSessionSource,
  waitForBrowserPacing,
} from './composition';

/**
 * BOOT test, the gap this closes: the pipeline was fully unit-tested but nothing in the worker
 * ever consumed its queues, so it could pass every test while never running in production.
 *
 * These tests assert the WIRING contract rather than the extraction internals:
 *  1. a scan started at stage 1 reaches all SIX stages,
 *  2. the Steel session id travels with every job (so any worker can re-attach without a re-login),
 *  3. the composition uses DURABLE checkpoints when Redis is present.
 */

const REF: SnapshotRef = { tenantId: 't1', connectionId: 'c1', snapshotId: 's1', distributor: 'distrokid', steelSessionId: 'steel-remote-123' };

const completed = (id: string): ReleaseExtractionOutcome => ({
  kind: 'COMPLETED',
  release: {
    distributorReleaseId: id, title: `R ${id}`,
    upc: present('199751675992', 'NETWORK_JSON', 'v1'),
    artworkUrl: present('https://cdn/x.jpg', 'NETWORK_JSON', 'v1'),
    releaseDate: present('2025-01-01', 'NETWORK_JSON', 'v1'),
    tracks: [{ title: 'T', isrc: present('QT6ED2521965', 'NETWORK_JSON', 'v1') }],
  },
  source: 'NETWORK_JSON', elapsedMs: 5,
});

describe('worker composition, the six-stage pipeline actually runs', () => {
  it('a started snapshot flows through ALL SIX stages and finalizes', async () => {
    const store = new InMemorySnapshotStore();
    const lock = new InMemoryConnectionLock();
    const stagesRun: string[] = [];
    const sessionsAttached: Array<string | undefined> = [];
    const finalized: FinalizeJob[] = [];

    // A queue that DISPATCHES to the real handlers, this is what the BullMQ workers do.
    const queue: Array<() => Promise<void>> = [];
    const deps: PipelineDeps = {
      store,
      async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
      async readCatalogIndex(job) {
        stagesRun.push('extract-catalog-index');
        sessionsAttached.push(job.steelSessionId);
        return Array.from({ length: 45 }, (_, i) => ({ releaseId: `R${i}`, dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${i}` }));
      },
      async extractChunk(job, refs) {
        sessionsAttached.push(job.steelSessionId);
        return refs.map((r) => completed(r.releaseId));
      },
      enqueue: {
        async plan(j) { stagesRun.push('plan-release-chunks'); queue.push(() => planDistroKidReleaseChunks(j, deps).then(() => undefined)); },
        async chunk(j) { stagesRun.push('extract-release-chunk'); queue.push(() => extractDistroKidReleaseChunk(j, deps).then(() => undefined)); },
        async retry(j) { stagesRun.push('retry-failed-releases'); queue.push(() => retryFailedDistroKidReleases(j, deps).then(() => undefined)); },
        async reconcile(j) { stagesRun.push('reconcile-snapshot'); queue.push(() => reconcileDistroKidSnapshot(j, deps).then(() => undefined)); },
        async finalize(j) { stagesRun.push('finalize-snapshot'); finalized.push(j); queue.push(() => finalizeDistroKidSnapshot(j, deps)); },
      },
      async persistSnapshot() { stagesRun.push('persisted'); },
    };

    // Stage 1, exactly what the API's startSnapshot triggers.
    await extractDistroKidCatalogIndex({ ...REF, artists: ['Lewis KE'] } as CatalogIndexJob, deps);
    // Drain the queue like the workers would.
    for (let guard = 0; guard < 200 && queue.length; guard++) await queue.shift()!();

    expect(stagesRun).toContain('extract-catalog-index');
    expect(stagesRun).toContain('plan-release-chunks');
    expect(stagesRun).toContain('extract-release-chunk');
    expect(stagesRun).toContain('reconcile-snapshot');
    expect(stagesRun).toContain('finalize-snapshot');
    expect(stagesRun).toContain('persisted');
    expect(finalized[0]!.status).toBe('COMPLETE');
    expect((await store.getOutcomes('s1')).length).toBe(45);
  });

  it('the Steel session id travels with EVERY job (no re-login, no side channel)', async () => {
    const store = new InMemorySnapshotStore();
    const lock = new InMemoryConnectionLock();
    const seen: Array<string | undefined> = [];
    const queue: Array<() => Promise<void>> = [];
    const deps: PipelineDeps = {
      store,
      async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
      async readCatalogIndex() { return [{ releaseId: 'R0', dashboardUrl: 'https://distrokid.com/x' }]; },
      async extractChunk(job, refs) { seen.push(job.steelSessionId); return refs.map((r) => completed(r.releaseId)); },
      enqueue: {
        async plan(j) { seen.push(j.steelSessionId); queue.push(() => planDistroKidReleaseChunks(j, deps).then(() => undefined)); },
        async chunk(j) { seen.push(j.steelSessionId); queue.push(() => extractDistroKidReleaseChunk(j, deps).then(() => undefined)); },
        async retry() {}, async reconcile() {}, async finalize() {},
      },
      async persistSnapshot() {},
    };
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] } as CatalogIndexJob, deps);
    for (let guard = 0; guard < 50 && queue.length; guard++) await queue.shift()!();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'steel-remote-123')).toBe(true);
  });

  it('a chunk with NO authenticated session yields terminal REAUTH outcomes, never silent skips', async () => {
    const store = new InMemorySnapshotStore();
    const lock = new InMemoryConnectionLock();
    await store.putIndex('s1', [{ releaseId: 'R0', dashboardUrl: 'u' }, { releaseId: 'R1', dashboardUrl: 'u' }]);
    const deps: PipelineDeps = {
      store,
      async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
      async readCatalogIndex() { return []; },
      // Mirrors composition.extractChunk's no-session branch.
      async extractChunk(_job, refs) {
        return refs.map((r) => ({ kind: 'FAILED' as const, distributorReleaseId: r.releaseId, reason: 'REAUTH_REQUIRED' as const, detail: 'no authenticated session', elapsedMs: 0 }));
      },
      enqueue: { async plan() {}, async chunk() {}, async retry() {}, async reconcile() {}, async finalize() {} },
      async persistSnapshot() {},
    };
    await extractDistroKidReleaseChunk({ ...REF, chunkIndex: 0, releaseIds: ['R0', 'R1'] } as ReleaseChunkJob, deps);
    const outcomes = await store.getOutcomes('s1');
    expect(outcomes.length).toBe(2); // both accounted for
    expect(outcomes.every((o) => o.kind === 'FAILED' && o.reason === 'REAUTH_REQUIRED')).toBe(true);
  });
});

describe('browser pacing', () => {
  it('waits before navigation and aborts without waiting out the delay', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let finished = false;
      const pacing = waitForBrowserPacing(controller.signal, 750).then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(749);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pacing;
      expect(finished).toBe(true);

      const stopped = new AbortController();
      const aborted = waitForBrowserPacing(stopped.signal, 750);
      stopped.abort(new Error('lock lost'));
      await expect(aborted).rejects.toThrow('lock lost');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('composition uses DURABLE checkpoints', () => {
  it('refuses a Redis-only checkpoint topology in production', () => {
    expect(() => buildDistroKidComposition({
      connection: {} as never,
      redis: {} as never,
      pgPool: null,
      env: { NODE_ENV: 'production' },
      async persistSnapshot() {},
    }, {} as never)).toThrow(/requires both Redis.*PostgreSQL/i);
  });

  it('RedisSnapshotStore persists outcomes idempotently by releaseId', async () => {
    // Minimal in-memory fake of the ioredis surface the store uses.
    const hashes = new Map<string, Map<string, string>>();
    const strings = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    const redis: SnapshotRedis = {
      async get(k) { return strings.get(k) ?? null; },
      async set(k, v, _mode, _duration, flag) {
        if (flag === 'NX' && strings.has(k)) return null;
        strings.set(k, v); return 'OK';
      },
      async hset(k, f, v) { const m = hashes.get(k) ?? new Map(); m.set(f, v); hashes.set(k, m); return 1; },
      async hgetall(k) { return Object.fromEntries(hashes.get(k) ?? new Map()); },
      async sadd(k, m) { const s = sets.get(k) ?? new Set(); s.add(m); sets.set(k, s); return 1; },
      async smembers(k) { return [...(sets.get(k) ?? [])]; },
      async expire() { return 1; },
      async del() { return 1; },
    };
    const store = new RedisSnapshotStore(redis);
    await store.putIndex('s1', [{ releaseId: 'R0', dashboardUrl: 'u' }]);
    await store.putOutcomes('s1', [completed('R0')]);
    await store.putOutcomes('s1', [completed('R0')]); // duplicate delivery / retry
    expect((await store.getOutcomes('s1')).length).toBe(1); // idempotent, not 2
    await store.markChunkComplete('s1', 1, 0);
    await store.markChunkComplete('s1', 1, 0);
    expect(await store.completedChunks('s1', 1)).toEqual([0]);
    expect((await store.getIndex('s1')).length).toBe(1);
    await store.putPassPlan('s1', 1, [['R0']]);
    expect(await store.getPassPlan('s1', 1)).toEqual([['R0']]);
    await store.claimTerminal('s1', { kind: 'CANCELLED', createdAt: '2026-07-22T00:00:00.000Z', reason: 'first' });
    const winner = await store.claimTerminal('s1', { kind: 'CANCELLED', createdAt: '2026-07-22T00:00:01.000Z', reason: 'late' });
    expect(winner).toMatchObject({ kind: 'CANCELLED', reason: 'first' });
  });

  it('warns loudly when falling back to in-memory checkpoints AND in-memory endpoint profiles', () => {
    const logs: string[] = [];
    reportDistroKidDurabilityDegradations({ redis: false, postgres: false }, (m) => logs.push(m));
    // Silence here would be the bug: a degraded store that looks identical to a durable one is
    // how "we have the data" quietly stops being true.
    expect(logs.some((l) => l.includes('hot-cache') && l.includes('distributed locking'))).toBe(true);
    expect(logs.some((l) => l.includes('NOT DURABLE') && l.includes('Redis loss can replay work'))).toBe(true);
  });
});

describe('Steel session ownership', () => {
  it('always disconnects local Steel transports when earlier shutdown phases fail', async () => {
    const order: string[] = [];
    const workers = { close: vi.fn(async () => { order.push('workers'); throw new Error('worker close failed'); }) };
    const queues = { close: vi.fn(async () => { order.push('queues'); throw new Error('queue close failed'); }) };
    const sessions = { close: vi.fn(async () => { order.push('sessions'); }) };

    await expect(closeDistroKidCompositionResources(workers, queues, sessions)).rejects.toThrow(/cleanup failed/i);
    expect(order).toEqual(['workers', 'queues', 'sessions']);
    expect(sessions.close).toHaveBeenCalledOnce();
  });

  it('fails worker composition closed in production when Steel is unavailable', () => {
    expect(() => steelSessionSource(
      { NODE_ENV: 'production', STEEL_CONNECTOR_MODE: 'mock' } as NodeJS.ProcessEnv,
      undefined,
      new EnvelopeEncryptor(Buffer.alloc(32, 7).toString('base64')),
    )).toThrow(/require.*Steel/i);
  });

  it('unwraps an encrypted queue handle only at the Steel attachment edge', async () => {
    const key = Buffer.alloc(32, 4).toString('base64');
    const encrypted = new EnvelopeEncryptor(key).encrypt('steel-remote-123');
    const provider = {
      attachRemoteSession: vi.fn(async () => ({ baseUrl: '', newPage: vi.fn(), close: vi.fn(async () => undefined) })),
      releaseRemoteSession: vi.fn(async () => undefined),
    };
    const sessions = steelSessionSource(
      { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      provider,
      new EnvelopeEncryptor(key),
    );
    await sessions.attach({ ...REF, steelSessionId: encrypted });
    expect(provider.attachRemoteSession).toHaveBeenCalledWith('steel-remote-123', { releaseOnClose: false });
    await expect(sessions.attach(REF)).rejects.toThrow(/plaintext Steel session handle/i);
  });

  it('borrows the same remote session for stages and explicitly releases it once at terminal finalization', async () => {
    const conn = { baseUrl: '', newPage: vi.fn(), close: vi.fn(async () => undefined) };
    const provider = {
      attachRemoteSession: vi.fn(async () => conn),
      releaseRemoteSession: vi.fn(async () => undefined),
      disposeLocalConnections: vi.fn(async () => undefined),
    };
    const sessions = steelSessionSource({} as NodeJS.ProcessEnv, provider, new EnvelopeEncryptor());
    const job = { ...REF, artists: ['Lewis KE'] } as CatalogIndexJob;

    await sessions.attach(job);
    await sessions.attach(job);
    expect(provider.attachRemoteSession).toHaveBeenCalledTimes(2);
    expect(provider.attachRemoteSession).toHaveBeenNthCalledWith(1, 'steel-remote-123', { releaseOnClose: false });
    expect(provider.attachRemoteSession).toHaveBeenNthCalledWith(2, 'steel-remote-123', { releaseOnClose: false });

    const terminal = {
      ...REF,
      status: 'COMPLETE',
      completeness: {
        expectedReleases: 0, attemptedReleases: 0, completedReleases: 0, failedReleases: 0, skippedReleases: 0,
        expectedTracksKnown: false, expectedTracks: 0, extractedTracks: 0, releasesWithUpc: 0, releasesWithArtwork: 0,
        tracksWithIsrc: 0, tracksWithDistributorId: 0, releasesUpcAbsentAtSource: 0,
        tracksIsrcAbsentAtSource: 0, releasesUpcNotCaptured: 0, tracksIsrcNotCaptured: 0,
        unresolvedReleaseIds: [], failureReasons: {},
      },
      pass: 1,
    } as FinalizeJob;
    await sessions.release!(terminal);
    await sessions.release!(terminal);
    expect(provider.releaseRemoteSession).toHaveBeenCalledTimes(1);
    expect(provider.releaseRemoteSession).toHaveBeenCalledWith('steel-remote-123');
    await sessions.close?.();
    expect(provider.disposeLocalConnections).toHaveBeenCalledOnce();
  });
});
