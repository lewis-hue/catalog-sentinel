import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import type { DistributorEndpointProfile, FinalizeJob, ReleaseExtractionOutcome, CanonicalDistributorRelease } from '@sentinel/contracts';
import { DistroKidOutcomeRepository } from './outcome-repository';
import { PostgresEndpointRegistryStore } from './endpoint-registry-store';
import { PostgresCandidateStore } from './candidate-store';

/**
 * Durable persistence against a REAL Postgres.
 *
 * Redis is operational checkpoint storage and may be flushed at any time; these tables are the
 * catalog system of record. Before this layer existed, `persistSnapshot` flipped a status flag and
 * logged counts, so after a Redis expiry there was no catalogue anywhere, and nobody would have
 * noticed until a user asked where their tracks went.
 *
 * These tests use real SQL because the bugs worth catching here are SQL bugs: a wrong ON CONFLICT
 * target duplicates a catalogue, a missing tenant filter leaks another tenant's data, and neither
 * is visible to a typechecker or a mock.
 *
 * Requires DATABASE_URL (CI provisions Postgres). `assert-infra-tests-ran.mjs` fails the build if
 * this suite silently skips.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.DATABASE_TEST_URL;

const field = <T>(value: T, status = 'PRESENT'): { value: T; status: 'PRESENT'; source: 'NETWORK_JSON'; capturedAt: string; parserVersion: string } =>
  ({ value, status: status as 'PRESENT', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'distrokid-parser-v1' });

const release = (id: string, over: Partial<CanonicalDistributorRelease> = {}): CanonicalDistributorRelease => ({
  distributorReleaseId: id,
  title: `Release ${id}`,
  primaryArtist: 'Lewis KE',
  upc: field('199751675992'),
  artworkUrl: field('https://cdn.example/a.jpg'),
  releaseDate: field('2025-01-01'),
  tracks: [{ title: `Track ${id}`, isrc: field('QT6ED2521965') }],
  ...over,
});

const completed = (id: string, over: Partial<CanonicalDistributorRelease> = {}): ReleaseExtractionOutcome =>
  ({ kind: 'COMPLETED', release: release(id, over), source: 'NETWORK_JSON', elapsedMs: 5 });

const finalizeJob = (over: Partial<FinalizeJob> = {}): FinalizeJob => ({
  tenantId: 't-pg', connectionId: 't-pg:distrokid', snapshotId: 'snap-1', distributor: 'distrokid',
  status: 'COMPLETE',
  completeness: {
    expectedReleases: 1, attemptedReleases: 1, completedReleases: 1, failedReleases: 0, skippedReleases: 0,
    expectedTracksKnown: true, expectedTracks: 1, extractedTracks: 1,
    releasesWithUpc: 1, releasesWithArtwork: 1, tracksWithIsrc: 1, tracksWithDistributorId: 0,
    releasesUpcAbsentAtSource: 0, tracksIsrcAbsentAtSource: 0,
    releasesUpcNotCaptured: 0, tracksIsrcNotCaptured: 0,
    unresolvedReleaseIds: [], failureReasons: {},
  },
  ...over,
});

describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1');
  });

  afterAll(async () => { await pool.end(); });

  beforeEach(async () => {
    // Cascades clear release/track outcomes.
    await pool.query(`DELETE FROM "DistributorExtractionSnapshot" WHERE "userId" LIKE 't-pg%'`);
    await pool.query(`DELETE FROM "DistributorEndpointProfile" WHERE "userId" LIKE 't-pg%'`);
    await pool.query(`DELETE FROM "DistributorEndpointCandidate" WHERE "userId" LIKE 't-pg%'`);
  });

  describe('outcome repository', () => {
    it('persists a finalized snapshot with releases and tracks', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      expect(repo.durable).toBe(true);
      await repo.persist(finalizeJob(), [completed('R1'), completed('R2')]);

      const snap = await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`);
      expect(snap.rowCount).toBe(1);
      expect(snap.rows[0].status).toBe('COMPLETE');
      expect(snap.rows[0].engine).toBe('NETWORK_FIRST');
      expect(snap.rows[0].expectedTracksKnown).toBe(true);
      expect(snap.rows[0].finalizedAt).not.toBeNull();

      const outcomes = await pool.query(`SELECT * FROM "DistributorReleaseOutcome" ORDER BY "distributorReleaseId"`);
      expect(outcomes.rowCount).toBe(2);
      expect(outcomes.rows[0].upc).toBe('199751675992');
      expect(outcomes.rows[0].upcStatus).toBe('PRESENT');
      expect(outcomes.rows[0].parserVersion).toBe('distrokid-parser-v1');

      const tracks = await pool.query(`SELECT * FROM "DistributorTrackOutcome"`);
      expect(tracks.rowCount).toBe(2);
      expect(tracks.rows[0].isrc).toBe('QT6ED2521965');
    });

    it('persists normalized release featured artists on every flattened track outcome', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      await repo.persist(finalizeJob(), [completed('R-features', {
        featuredArtists: ['Guest One', 'Guest Two'],
        tracks: [
          { title: 'Collaboration One', isrc: field('QT6ED2521965') },
          { title: 'Collaboration Two', isrc: field('QT6ED2521966') },
        ],
      })]);

      const rows = await pool.query<{ title: string; featuredArtists: string[] }>(
        `SELECT "title", "featuredArtists" FROM "DistributorTrackOutcome" ORDER BY "trackIndex"`,
      );
      expect(rows.rows).toEqual([
        { title: 'Collaboration One', featuredArtists: ['Guest One', 'Guest Two'] },
        { title: 'Collaboration Two', featuredArtists: ['Guest One', 'Guest Two'] },
      ]);
    });

    it('durably commits a 1,200-track catalog without omissions', async () => {
      const releaseCount = 300;
      const tracksPerRelease = 4;
      const trackCount = releaseCount * tracksPerRelease;
      const outcomes = Array.from({ length: releaseCount }, (_, releaseIndex) => completed(
        `R-large-${releaseIndex}`,
        {
          title: `Large release ${releaseIndex}`,
          tracks: Array.from({ length: tracksPerRelease }, (_, trackIndex) => ({
            distributorTrackId: `T-${releaseIndex}-${trackIndex}`,
            title: `Track ${releaseIndex}-${trackIndex}`,
            trackNumber: trackIndex + 1,
            isrc: field('QT6ED2521965'),
          })),
        },
      ));
      const job = finalizeJob({
        snapshotId: 'snap-large-1200',
        completeness: {
          expectedReleases: releaseCount,
          attemptedReleases: releaseCount,
          completedReleases: releaseCount,
          failedReleases: 0,
          skippedReleases: 0,
          expectedTracksKnown: true,
          expectedTracks: trackCount,
          extractedTracks: trackCount,
          releasesWithUpc: releaseCount,
          releasesWithArtwork: releaseCount,
          tracksWithIsrc: trackCount,
          tracksWithDistributorId: trackCount,
          releasesUpcAbsentAtSource: 0,
          tracksIsrcAbsentAtSource: 0,
          releasesUpcNotCaptured: 0,
          tracksIsrcNotCaptured: 0,
          unresolvedReleaseIds: [],
          failureReasons: {},
        },
      });

      await new DistroKidOutcomeRepository(pool).persist(job, outcomes);

      const snapshot = await pool.query(
        `SELECT "expectedReleases", "expectedTracksKnown", "expectedTracks", "extractedTracks"
           FROM "DistributorExtractionSnapshot"
          WHERE "userId" = 't-pg' AND "snapshotId" = 'snap-large-1200'`,
      );
      expect(snapshot.rows[0]).toMatchObject({
        expectedReleases: releaseCount,
        expectedTracksKnown: true,
        expectedTracks: trackCount,
        extractedTracks: trackCount,
      });

      const persisted = await pool.query<{ releases: string; tracks: string; blank_titles: string; present_isrcs: string }>(
        `SELECT
           COUNT(DISTINCT release_outcome.id)::text AS releases,
           COUNT(track_outcome.id)::text AS tracks,
           COUNT(track_outcome.id) FILTER (WHERE btrim(track_outcome.title) = '')::text AS blank_titles,
           COUNT(track_outcome.id) FILTER (WHERE track_outcome."isrcStatus" = 'PRESENT')::text AS present_isrcs
         FROM "DistributorExtractionSnapshot" snapshot
         JOIN "DistributorReleaseOutcome" release_outcome ON release_outcome."extractionSnapshotId" = snapshot.id
         JOIN "DistributorTrackOutcome" track_outcome ON track_outcome."releaseOutcomeId" = release_outcome.id
        WHERE snapshot."userId" = 't-pg' AND snapshot."snapshotId" = 'snap-large-1200'`,
      );
      expect(Number(persisted.rows[0]?.releases)).toBe(releaseCount);
      expect(Number(persisted.rows[0]?.tracks)).toBe(trackCount);
      expect(Number(persisted.rows[0]?.blank_titles)).toBe(0);
      expect(Number(persisted.rows[0]?.present_isrcs)).toBe(trackCount);
    }, 60_000);

    it('is IDEMPOTENT, a redelivered finalize converges instead of duplicating the catalogue', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      await repo.persist(finalizeJob(), [completed('R1'), completed('R2')]);
      await repo.persist(finalizeJob(), [completed('R1'), completed('R2')]);
      await repo.persist(finalizeJob(), [completed('R1'), completed('R2')]);

      // BullMQ redelivers. Three finalizes must leave one snapshot and two releases, not three
      // copies of someone's catalogue.
      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`)).rowCount).toBe(1);
      expect((await pool.query(`SELECT * FROM "DistributorReleaseOutcome"`)).rowCount).toBe(2);
      expect((await pool.query(`SELECT * FROM "DistributorTrackOutcome"`)).rowCount).toBe(2);
    });

    it('PERSISTS FAILURES with a reason code, a failed release is a fact, not an omission', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      const failed: ReleaseExtractionOutcome = {
        kind: 'FAILED', distributorReleaseId: 'R-bad', reason: 'TIMEOUT',
        detail: 'distributor metadata request timed out', elapsedMs: 20_000,
      };
      await repo.persist(finalizeJob({ status: 'PARTIAL_RETRYABLE' }), [completed('R1'), failed]);

      const rows = await pool.query(`SELECT * FROM "DistributorReleaseOutcome" WHERE "kind" = 'FAILED'`);
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].reason).toBe('TIMEOUT');
      // The reason CODE is stored; the free-text detail is NOT, it can quote response content.
      expect(JSON.stringify(rows.rows[0])).not.toContain('timed out');
    });

    it('distinguishes ABSENT_AT_SOURCE from NOT_CAPTURED, so a retry can be targeted', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      const noUpcAtSource = completed('R-absent', {
        upc: { status: 'ABSENT_AT_SOURCE', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1' },
      });
      const upcTimedOut = completed('R-timeout', {
        upc: { status: 'TIMEOUT', source: 'NETWORK_JSON', capturedAt: '2026-01-01T00:00:00.000Z', parserVersion: 'v1' },
      });
      await repo.persist(finalizeJob(), [noUpcAtSource, upcTimedOut]);

      const rows = await pool.query(`SELECT "distributorReleaseId", "upc", "upcStatus" FROM "DistributorReleaseOutcome" ORDER BY "distributorReleaseId"`);
      // Both have upc = NULL. Only the STATUS says which is our failure and therefore retryable -
      // this is the whole reason the column exists.
      const absent = rows.rows.find((r) => r.distributorReleaseId === 'R-absent');
      const timeout = rows.rows.find((r) => r.distributorReleaseId === 'R-timeout');
      expect(absent.upc).toBeNull();
      expect(timeout.upc).toBeNull();
      expect(absent.upcStatus).toBe('ABSENT_AT_SOURCE');
      expect(timeout.upcStatus).toBe('TIMEOUT');
    });

    it('is TRANSACTIONAL, a mid-write failure leaves no half-written snapshot', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      const poison = { kind: 'COMPLETED', release: null, source: 'NETWORK_JSON', elapsedMs: 1 } as unknown as ReleaseExtractionOutcome;
      await expect(repo.persist(finalizeJob(), [completed('R1'), poison])).rejects.toThrow();
      // A snapshot claiming COMPLETE over half a catalogue is worse than no snapshot.
      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT * FROM "DistributorReleaseOutcome"`)).rowCount).toBe(0);
    });

    it('DELETES stale tracks when an authoritative re-read returns fewer (10 → 9)', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, isrc: field('QT6ED252196' + (i % 10)) }));

      await repo.persist(finalizeJob(), [completed('R1', { tracks: tracks(10) })]);
      expect((await pool.query(`SELECT * FROM "DistributorTrackOutcome"`)).rowCount).toBe(10);

      // A corrected re-read finds 9. Upserting alone left track index 9 behind forever, a track
      // the distributor no longer reports, sitting in our catalogue looking authoritative.
      await repo.persist(finalizeJob(), [completed('R1', { tracks: tracks(9) })]);
      const rows = await pool.query<{ trackIndex: number }>(`SELECT "trackIndex" FROM "DistributorTrackOutcome" ORDER BY "trackIndex"`);
      expect(rows.rowCount).toBe(9);
      expect(rows.rows.map((r) => r.trackIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('DELETES every track when a completed release later becomes a terminal failure', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      await repo.persist(finalizeJob(), [completed('R1')]);
      expect((await pool.query(`SELECT * FROM "DistributorTrackOutcome"`)).rowCount).toBe(1);

      // Now the release fails. Keeping its old tracks would show a catalogue where a release we
      // are simultaneously reporting as unread still has tracks hanging off it.
      const failed: ReleaseExtractionOutcome = {
        kind: 'FAILED', distributorReleaseId: 'R1', reason: 'TIMEOUT', detail: 'x', elapsedMs: 1,
      };
      await repo.persist(finalizeJob({ status: 'PARTIAL_RETRYABLE' }), [failed]);

      expect((await pool.query(`SELECT * FROM "DistributorTrackOutcome"`)).rowCount).toBe(0);
      const rel = await pool.query(`SELECT "kind", "reason" FROM "DistributorReleaseOutcome"`);
      expect(rel.rows[0].kind).toBe('FAILED');
      expect(rel.rows[0].reason).toBe('TIMEOUT');
    });

    it('persists the endpoint fingerprint, provenance from a release back to its endpoint', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      const withFp: ReleaseExtractionOutcome = { ...completed('R1'), endpointFingerprint: 'a'.repeat(64) } as ReleaseExtractionOutcome;
      await repo.persist(finalizeJob(), [withFp]);
      const row = await pool.query<{ endpointFingerprint: string }>(`SELECT "endpointFingerprint" FROM "DistributorReleaseOutcome"`);
      // The column existed but nothing wrote to it, so a stored release could not be traced back
      // to the endpoint that served it.
      expect(row.rows[0]!.endpointFingerprint).toBe('a'.repeat(32)); // truncated, not the full hash
    });

    it('stores UPC only at release level, the track table has no upc column at all', async () => {
      const repo = new DistroKidOutcomeRepository(pool);
      await repo.persist(finalizeJob(), [completed('R1')]);
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'DistributorTrackOutcome'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toContain('isrc');
      expect(names).not.toContain('upc');
    });

    it('has no raw-payload column anywhere, the schema itself enforces the allowlist', async () => {
      const cols = await pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_name IN ('DistributorRelease','DistributorTrack','DistributorReleaseOutcome','DistributorTrackOutcome')`,
      );
      const raw = cols.rows.filter((r) => /raw|payload|body/i.test(r.column_name));
      expect(raw).toEqual([]);
    });
  });

  describe('endpoint registry store', () => {
    const profile = (over: Partial<DistributorEndpointProfile> = {}): DistributorEndpointProfile => ({
      id: 'p1', tenantId: 't-pg', distributor: 'DISTROKID', role: 'releaseDetails',
      fingerprint: 'fp-abc', method: 'GET', hostPattern: 'distrokid.com',
      pathPattern: '/api/album/{uuid}', queryKeyShape: ['albumuuid'],
      schemaHash: 'sha-1', parserVersion: 'distrokid-parser-v1',
      candidateScore: 20, successfulCaptures: 0, failedCaptures: 0, status: 'CANDIDATE',
      firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
      ...over,
    });

    it('round-trips a profile and survives a NEW store instance (i.e. a restart)', async () => {
      await new PostgresEndpointRegistryStore(pool).put(profile());
      // A different instance = the restarted process. The in-memory store fails this by design.
      const afterRestart = new PostgresEndpointRegistryStore(pool);
      const got = await afterRestart.get({ tenantId: 't-pg', distributor: 'DISTROKID' }, 'fp-abc');
      expect(got).not.toBeNull();
      expect(got!.role).toBe('releaseDetails');
      expect(got!.pathPattern).toBe('/api/album/{uuid}');
      expect(got!.queryKeyShape).toEqual(['albumuuid']);
    });

    it('round-trips EVERY field the model promises, schema keys, drift count, candidate score', async () => {
      // The repository used to insert an empty `schemaKeys` array and a hard-coded drift count of
      // zero, and read the candidate score back out of `validationCount`. The table promised more
      // than the repository preserved: a restart silently dropped the endpoint's schema shape and
      // reset its drift history to "never happened".
      const store = new PostgresEndpointRegistryStore(pool);
      await store.put(profile({
        schemaKeys: ['isrc', 'upc', 'tracks'],
        schemaDriftCount: 4,
        candidateScore: 37,
        successfulCaptures: 9,
        failedCaptures: 2,
      }));

      const got = await new PostgresEndpointRegistryStore(pool).get({ tenantId: 't-pg', distributor: 'DISTROKID' }, 'fp-abc');
      expect(got!.schemaKeys).toEqual(['isrc', 'upc', 'tracks']);
      expect(got!.schemaDriftCount).toBe(4);
      expect(got!.candidateScore).toBe(37);
      expect(got!.successfulCaptures).toBe(9);
      expect(got!.failedCaptures).toBe(2);
      // The score has its own column now, it is not just a re-read of validationCount.
      const raw = await pool.query<{ candidateScore: number; validationCount: number }>(
        `SELECT "candidateScore", "validationCount" FROM "DistributorEndpointProfile" WHERE "userId" = 't-pg'`,
      );
      expect(raw.rows[0]!.candidateScore).toBe(37);
    });

    it('upserts on (tenant, distributor, fingerprint) so concurrent workers converge on one row', async () => {
      const store = new PostgresEndpointRegistryStore(pool);
      await store.put(profile({ status: 'CANDIDATE', successfulCaptures: 0 }));
      await store.put(profile({ status: 'VALIDATING', successfulCaptures: 1 }));
      await store.put(profile({ status: 'ACTIVE', successfulCaptures: 3, approvedAt: '2026-01-02T00:00:00.000Z' }));

      const all = await store.list({ tenantId: 't-pg', distributor: 'DISTROKID' });
      expect(all).toHaveLength(1);
      expect(all[0]!.status).toBe('ACTIVE');
      expect(all[0]!.successfulCaptures).toBe(3);
      expect(all[0]!.approvedAt).toBeTruthy();
    });

    it('ISOLATES TENANTS, one tenant can never read or overwrite another tenant profile', async () => {
      const store = new PostgresEndpointRegistryStore(pool);
      await store.put(profile({ tenantId: 't-pg', status: 'ACTIVE' }));
      await store.put(profile({ tenantId: 't-pg-other', status: 'DEGRADED' }));

      const mine = await store.list({ tenantId: 't-pg', distributor: 'DISTROKID' });
      expect(mine).toHaveLength(1);
      expect(mine[0]!.status).toBe('ACTIVE');
      expect(mine[0]!.tenantId).toBe('t-pg');

      // Same fingerprint, different tenant, must be a separate row with its own status. A shared
      // global registry would let one account's odd payload degrade the endpoint for everyone.
      const theirs = await store.get({ tenantId: 't-pg-other', distributor: 'DISTROKID' }, 'fp-abc');
      expect(theirs!.status).toBe('DEGRADED');
    });

    it('returns null for a fingerprint belonging to another tenant', async () => {
      const store = new PostgresEndpointRegistryStore(pool);
      await store.put(profile({ tenantId: 't-pg-other' }));
      expect(await store.get({ tenantId: 't-pg', distributor: 'DISTROKID' }, 'fp-abc')).toBeNull();
    });
  });

  describe('candidate store', () => {
    const candidate = (over: Record<string, unknown> = {}) => ({
      fingerprint: 'fp-1', descriptor: 'GET distrokid.com/api/album/{uuid}',
      identity: { method: 'GET', host: 'distrokid.com', pathPattern: '/api/album/{uuid}', queryKeys: ['albumuuid'] },
      schemaKeys: ['isrc', 'upc', 'tracks'], schemaHash: 'sha-1', score: 25, bodyBytes: 4096,
      observedAt: '2026-01-01T00:00:00.000Z', ...over,
    });

    it('records and ranks candidates for one scan', async () => {
      const store = new PostgresCandidateStore(pool);
      await store.write(candidate(), { tenantId: 't-pg', scanId: 'scan-1' });
      await store.write(candidate({ fingerprint: 'fp-2', score: 40 }), { tenantId: 't-pg', scanId: 'scan-1' });

      const list = await store.list('t-pg', 'scan-1');
      expect(list).toHaveLength(2);
      expect(list[0]!.fingerprint).toBe('fp-2'); // ranked by score
      expect(list[0]!.schemaKeys).toContain('isrc');
    });

    it('counts repeat observations instead of duplicating rows', async () => {
      const store = new PostgresCandidateStore(pool);
      await store.write(candidate(), { tenantId: 't-pg', scanId: 'scan-1' });
      await store.write(candidate({ score: 30 }), { tenantId: 't-pg', scanId: 'scan-1' });

      const list = await store.list('t-pg', 'scan-1');
      expect(list).toHaveLength(1);
      expect(list[0]!.observations).toBe(2);
      expect(list[0]!.score).toBe(30); // keeps the best score seen
    });

    it('ISOLATES TENANTS AND SCANS, concurrent scans never contaminate each other', async () => {
      const store = new PostgresCandidateStore(pool);
      await store.write(candidate({ fingerprint: 'mine' }), { tenantId: 't-pg', scanId: 'scan-1' });
      await store.write(candidate({ fingerprint: 'theirs' }), { tenantId: 't-pg-other', scanId: 'scan-1' });
      await store.write(candidate({ fingerprint: 'other-scan' }), { tenantId: 't-pg', scanId: 'scan-2' });

      expect((await store.list('t-pg', 'scan-1')).map((c) => c.fingerprint)).toEqual(['mine']);
      expect((await store.list('t-pg-other', 'scan-1')).map((c) => c.fingerprint)).toEqual(['theirs']);
      expect((await store.list('t-pg', 'scan-2')).map((c) => c.fingerprint)).toEqual(['other-scan']);
    });

    it('drops redaction markers rather than persisting them as key names', async () => {
      const store = new PostgresCandidateStore(pool);
      await store.write(candidate({ schemaKeys: ['isrc', '{redacted}', 'upc'] }), { tenantId: 't-pg', scanId: 'scan-1' });
      const list = await store.list('t-pg', 'scan-1');
      expect(list[0]!.schemaKeys).toEqual(['isrc', 'upc']);
    });

    it('clears one scan without touching another', async () => {
      const store = new PostgresCandidateStore(pool);
      await store.write(candidate(), { tenantId: 't-pg', scanId: 'scan-1' });
      await store.write(candidate(), { tenantId: 't-pg', scanId: 'scan-2' });
      await store.clear('t-pg', 'scan-1');
      expect(await store.list('t-pg', 'scan-1')).toHaveLength(0);
      expect(await store.list('t-pg', 'scan-2')).toHaveLength(1);
    });
  });
});
