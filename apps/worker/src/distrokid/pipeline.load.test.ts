import { describe, it, expect } from 'vitest';
import { present, absentAtSource, ParserRegistry, reconcile, retryableReleaseIds, describeCompleteness, type ReleaseExtractionOutcome, type CanonicalDistributorRelease } from '@sentinel/browser-assist';
import { InMemorySnapshotStore, type ReleaseRefRecord } from './snapshot-store';
import { InMemoryConnectionLock } from './locks';
import {
  extractDistroKidCatalogIndex, planDistroKidReleaseChunks, extractDistroKidReleaseChunk,
  retryFailedDistroKidReleases, reconcileDistroKidSnapshot, finalizeDistroKidSnapshot,
  type PipelineDeps, type ReleaseChunkJob, type SnapshotRef, type FinalizeJob,
} from './pipeline';

/**
 * SCALE test, the "definition of done" bar.
 *
 * 1,200 tracks across 300 releases, with a worker restart mid-extraction, a timed-out release,
 * a malformed response, and a parser schema-change fixture. Asserts:
 *  - every release is ATTEMPTED and ends with a terminal result (no silent skips)
 *  - a retry re-reads ONLY the failed releases
 *  - resume after a crash does not redo completed work and creates no duplicates
 *  - memory stays bounded (chunked, not one giant in-memory read)
 *  - a schema change surfaces as an alert/terminal status, never corrupt output
 */

const REF: SnapshotRef = { tenantId: 't1', connectionId: 'c1', snapshotId: 'load-1', distributor: 'distrokid' };
const RELEASES = 300;
const TRACKS_PER_RELEASE = 4; // 300 × 4 = 1,200 tracks

const mkRelease = (id: string): CanonicalDistributorRelease => ({
  distributorReleaseId: id,
  title: `Release ${id}`,
  upc: present(`19975167${id.replace(/\D/g, '').padStart(4, '0')}`, 'NETWORK_JSON', 'v1'),
  artworkUrl: present('https://cdn/x-1000x1000.jpg', 'NETWORK_JSON', 'v1'),
  releaseDate: present('2025-01-01', 'NETWORK_JSON', 'v1'),
  tracks: Array.from({ length: TRACKS_PER_RELEASE }, (_, i) => ({
    distributorTrackId: `${id}-T${i}`,
    title: `Track ${i}`,
    isrc: present(`USKE1231${String(i).padStart(4, '0')}`, 'NETWORK_JSON', 'v1'),
    trackNumber: i + 1,
  })),
});

const index = (n: number): ReleaseRefRecord[] =>
  Array.from({ length: n }, (_, i) => ({ releaseId: `R${i}`, dashboardUrl: `https://distrokid.com/dashboard/album/?albumuuid=R${i}` }));

interface HarnessOpts {
  /** Release ids that fail on the FIRST attempt only (simulated timeout). */
  timeoutOnce?: Set<string>;
  /** Release ids whose payload is malformed → schema change. */
  malformed?: Set<string>;
}

function harness(opts: HarnessOpts = {}) {
  const store = new InMemorySnapshotStore();
  const lock = new InMemoryConnectionLock();
  const parsers = new ParserRegistry();
  const enqueued = { chunk: [] as ReleaseChunkJob[], retry: [] as Array<{ attempt: number }>, reconcile: 0, finalize: [] as FinalizeJob[] };
  const persisted: ReleaseExtractionOutcome[][] = [];
  const attempts = new Map<string, number>();
  let peakChunkSize = 0;

  const deps: PipelineDeps = {
    store,
    async readCatalogIndex() { return index(RELEASES); },
    async extractChunk(job, refs, onCheckpoint) {
      // Memory bound: a chunk must never hold the whole catalogue.
      peakChunkSize = Math.max(peakChunkSize, refs.length);
      const out: ReleaseExtractionOutcome[] = [];
      for (const r of refs) {
        const n = (attempts.get(r.releaseId) ?? 0) + 1;
        attempts.set(r.releaseId, n);

        if (opts.malformed?.has(r.releaseId)) {
          // A malformed payload must go through the parser and surface as SCHEMA_CHANGED -
          // never be silently coerced into a partial release.
          const parsed = parsers.parse({ totally: 'unexpected', shape: [1, 2] }, 'NETWORK_JSON');
          expect(parsed.ok).toBe(false);
          out.push({ kind: 'FAILED', distributorReleaseId: r.releaseId, reason: 'SCHEMA_CHANGED', detail: 'parser drift', elapsedMs: 1 });
          continue;
        }
        if (opts.timeoutOnce?.has(r.releaseId) && n === 1) {
          out.push({ kind: 'FAILED', distributorReleaseId: r.releaseId, reason: 'TIMEOUT', detail: 'metadata response timed out', elapsedMs: 1 });
          continue;
        }
        out.push({ kind: 'COMPLETED', release: mkRelease(r.releaseId), source: 'NETWORK_JSON', elapsedMs: 1 });
        if (out.length % 10 === 0) await onCheckpoint([...out]); // checkpoint every 10
      }
      return out;
    },
    async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
    enqueue: {
      async plan() {},
      async chunk(j) { enqueued.chunk.push(j); },
      async retry(j) { enqueued.retry.push(j); },
      async reconcile() { enqueued.reconcile++; },
      async finalize(j) { enqueued.finalize.push(j); },
    },
    async persistSnapshot(_j, o) { persisted.push(o); },
  };
  return { deps, store, lock, enqueued, persisted, attempts, peak: () => peakChunkSize };
}

/** Drain queued chunks until none remain (simulates the worker loop). */
async function drainChunks(h: ReturnType<typeof harness>): Promise<void> {
  for (let guard = 0; guard < 100 && h.enqueued.chunk.length; guard++) {
    expect(h.enqueued.chunk.length).toBeLessThanOrEqual(1);
    const batch = h.enqueued.chunk.splice(0, h.enqueued.chunk.length);
    for (const job of batch) await extractDistroKidReleaseChunk(job, h.deps);
  }
}

describe('LOAD: 1,200 tracks / 300 releases', () => {
  it('attempts every release, extracts every track, and completes with bounded memory', async () => {
    const h = harness();
    await extractDistroKidCatalogIndex({ ...REF, artists: ['Lewis KE'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    expect(h.enqueued.chunk.length).toBe(1); // one head; completion durably chains the next
    expect((await h.store.getPassPlan(REF.snapshotId, 1))?.length).toBe(Math.ceil(RELEASES / 20));
    await drainChunks(h);

    const outcomes = await h.store.getOutcomes(REF.snapshotId);
    expect(outcomes.length).toBe(RELEASES); // 100% attempted, one terminal result each

    const { completeness, status } = reconcile({
      expectedReleaseIds: index(RELEASES).map((r) => r.releaseId),
      expectedTracks: RELEASES * TRACKS_PER_RELEASE,
      outcomes,
    });
    expect(status).toBe('COMPLETE');
    expect(completeness.completedReleases).toBe(RELEASES);
    expect(completeness.extractedTracks).toBe(RELEASES * TRACKS_PER_RELEASE); // 1,200 tracks
    expect(completeness.expectedTracksKnown).toBe(true);
    expect(completeness.tracksWithIsrc).toBe(1_200);
    expect(completeness.releasesWithUpc).toBe(RELEASES);
    expect(completeness.unresolvedReleaseIds).toEqual([]);
    // Memory: never more than one chunk of releases in flight.
    expect(h.peak()).toBeLessThanOrEqual(20);
  }, 30_000);

  it('WORKER RESTART mid-extraction resumes without redoing work or duplicating records', async () => {
    const h = harness();
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);

    // Process only the first 5 sequentially chained chunks, then "crash".
    for (let i = 0; i < 5; i++) {
      const job = h.enqueued.chunk.shift();
      expect(job).toBeDefined();
      await extractDistroKidReleaseChunk(job!, h.deps);
    }
    const afterCrash = await h.store.getOutcomes(REF.snapshotId);
    expect(afterCrash.length).toBe(100); // 5 chunks × 20

    // Restart: replan against the SAME store, completed chunks are skipped.
    h.enqueued.chunk.length = 0;
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    expect(h.enqueued.chunk.length).toBe(1); // resume at the first unfinished chunk only
    expect(h.enqueued.chunk[0]?.chunkIndex).toBe(5);
    await drainChunks(h);

    const outcomes = await h.store.getOutcomes(REF.snapshotId);
    expect(outcomes.length).toBe(RELEASES); // no duplicates (idempotent by releaseId)
    const ids = outcomes.map((o) => (o.kind === 'COMPLETED' ? o.release.distributorReleaseId : o.distributorReleaseId));
    expect(new Set(ids).size).toBe(RELEASES);
    // Releases in the first five chunks were extracted exactly once.
    expect(h.attempts.get('R0')).toBe(1);
  }, 30_000);

  it('a timed-out release is retried ALONE and the snapshot then completes', async () => {
    const h = harness({ timeoutOnce: new Set(['R7', 'R123']) });
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    await drainChunks(h);

    // First pass: two timeouts → reconcile must NOT report complete.
    let rec = await reconcileDistroKidSnapshot({ ...REF, pass: 1 }, h.deps);
    expect(rec.status).toBe('PARTIAL_RETRYABLE');
    expect(rec.completeness.failedReleases).toBe(2);
    expect(h.enqueued.retry.length).toBe(1);

    // Retry pass re-enqueues ONLY the failures.
    await retryFailedDistroKidReleases({ ...REF, attempt: 2 }, h.deps);
    const retryJobs = [...h.enqueued.chunk];
    expect(retryJobs.flatMap((j) => j.releaseIds).sort()).toEqual(['R123', 'R7']);
    await drainChunks(h);

    // Second attempt succeeds → COMPLETE, and successful releases were never re-read.
    rec = await reconcileDistroKidSnapshot({ ...REF, pass: 2 }, h.deps);
    expect(rec.status).toBe('COMPLETE');
    expect(rec.completeness.completedReleases).toBe(RELEASES);
    expect(h.attempts.get('R7')).toBe(2);
    expect(h.attempts.get('R0')).toBe(1); // untouched by the retry
  }, 30_000);

  it('a malformed response yields SCHEMA_CHANGED, an alert, not corrupt output', async () => {
    const h = harness({ malformed: new Set(['R42']) });
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    await drainChunks(h);

    const outcomes = await h.store.getOutcomes(REF.snapshotId);
    const bad = outcomes.find((o) => o.kind === 'FAILED' && o.distributorReleaseId === 'R42');
    expect(bad).toMatchObject({ kind: 'FAILED', reason: 'SCHEMA_CHANGED' });

    const { status, completeness } = reconcile({ expectedReleaseIds: index(RELEASES).map((r) => r.releaseId), outcomes });
    expect(status).toBe('FAILED_SCHEMA_CHANGED'); // loud, not silent partial data
    expect(completeness.completedReleases).toBe(RELEASES - 1);
    // The other 299 releases still produced clean data, a drift doesn't corrupt the rest.
    expect(completeness.extractedTracks).toBe((RELEASES - 1) * TRACKS_PER_RELEASE);
  }, 30_000);

  it('reports UPC / artwork / ISRC coverage separately at scale', async () => {
    const h = harness({ timeoutOnce: new Set(['R1']) });
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    await drainChunks(h);
    const outcomes = await h.store.getOutcomes(REF.snapshotId);
    const { completeness, status } = reconcile({ expectedReleaseIds: index(RELEASES).map((r) => r.releaseId), outcomes });
    const line = describeCompleteness(completeness, status);
    expect(line).toMatch(/UPC \d+\/\d+/);
    expect(line).toMatch(/artwork \d+\/\d+/);
    expect(line).toMatch(/ISRC \d+\/\d+/);
    expect(line).not.toMatch(/ISRC\/UPC/); // never a combined number
  }, 30_000);

  it('never marks a snapshot complete while a release is unresolved', async () => {
    const h = harness();
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    // Drop one chunk on the floor (simulates a lost job).
    h.enqueued.chunk.pop();
    await drainChunks(h);
    const outcomes = await h.store.getOutcomes(REF.snapshotId);
    const ids = index(RELEASES).map((r) => r.releaseId);
    const { status, completeness } = reconcile({ expectedReleaseIds: ids, outcomes });
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(completeness.unresolvedReleaseIds.length).toBeGreaterThan(0);
    // And those unresolved releases are exactly what a retry would target.
    expect(retryableReleaseIds({ expectedReleaseIds: ids, outcomes }).sort()).toEqual(completeness.unresolvedReleaseIds.sort());
  }, 30_000);

  it('finalizes with a terminal status and persists once', async () => {
    const h = harness();
    await extractDistroKidCatalogIndex({ ...REF, artists: ['a'] }, h.deps);
    await planDistroKidReleaseChunks({ ...REF }, h.deps);
    await drainChunks(h);
    await reconcileDistroKidSnapshot({ ...REF, pass: 1 }, h.deps);
    expect(h.enqueued.finalize.length).toBe(1);
    await finalizeDistroKidSnapshot(h.enqueued.finalize[0]!, h.deps);
    expect(h.persisted.length).toBe(1);
    expect(h.persisted[0]!.length).toBe(RELEASES);
    expect((await h.store.getProgress(REF.snapshotId))?.status).toBe('COMPLETE');
  }, 30_000);
});
