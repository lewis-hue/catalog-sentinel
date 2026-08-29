# Task 4a review package (5989c93..57364e5)

## Commits
57364e5 feat(worker): user-scoped writes and persistence columns

## Stat
 apps/worker/src/deep-scan-presence.test.ts         |  8 ++--
 apps/worker/src/distrokid/finalize-result.test.ts  |  4 +-
 apps/worker/src/distrokid/finalize-result.ts       |  2 +-
 .../worker/src/distrokid/principal-binding.test.ts | 10 ++---
 apps/worker/src/distrokid/principal-binding.ts     |  7 ++--
 .../distrokid/snapshot-store.integration.test.ts   |  2 +-
 apps/worker/src/distrokid/snapshot-store.ts        | 46 +++++++++++-----------
 packages/persistence/src/candidate-store.ts        | 12 +++---
 .../persistence/src/endpoint-registry-store.ts     | 12 +++---
 packages/persistence/src/outcome-repository.ts     | 22 +++++------
 .../src/persistence.integration.test.ts            | 18 ++++-----
 11 files changed, 71 insertions(+), 72 deletions(-)

## Diff (-U8)
diff --git a/apps/worker/src/deep-scan-presence.test.ts b/apps/worker/src/deep-scan-presence.test.ts
index 92a329f..ff62511 100644
--- a/apps/worker/src/deep-scan-presence.test.ts
+++ b/apps/worker/src/deep-scan-presence.test.ts
@@ -29,23 +29,23 @@ function record(): SearchRecord {
         expectedReleases: 2, attemptedReleases: 2, completedReleases: 1, failedReleases: 1, skippedReleases: 0,
         expectedTracksKnown: false, expectedTracks: 2, extractedTracks: 2,
         releasesWithUpc: 0, releasesWithArtwork: 0, tracksWithIsrc: 1, tracksWithDistributorId: 0,
         releasesUpcAbsentAtSource: 0, tracksIsrcAbsentAtSource: 0, releasesUpcNotCaptured: 1, tracksIsrcNotCaptured: 1,
         unresolvedReleaseIds: ['release-2'], failureReasons: { TIMEOUT: 1 },
       },
     },
   };
-  return { id: 'search_1', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
+  return { id: 'search_1', userId: 'tenant-a', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
 }
 
 describe('mergePlatform', () => {
   it('rejects a queue job whose tenant does not own the search record', async () => {
     const store = new InMemorySearchStore();
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, record().result, []);
+    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, record().result, [], { userId: 'tenant-a' });
     await expect(runStorePresenceDeepScan(saved.id, { store, env: {} }, 'tenant-b')).rejects.toThrow(/tenant/i);
   });
 
   it('adds a platform column index-aligned and recomputes the summary', () => {
     const merged = mergePlatform(record(), 'Spotify', [
       { status: 'live', url: 'https://open.spotify.com/track/x', confidence: 0.75, needsManualReview: false },
       { status: 'unverifiable', url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Skit' },
     ]);
@@ -108,17 +108,17 @@ describe('mergePlatform', () => {
           return {
             store: 'Scale DSP', method: 'api', artist: { id: 'scale', name: 'Scale Artist', url: 'https://example.test/artist' },
             tracks: catalogTracks, pagination: { total: count, fetched: count, complete: true }, warnings: [],
           };
         },
       },
     };
     const store = new InMemorySearchStore();
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Scale Artist', distributor: 'distrokid' }, result, released);
+    const saved = await store.save({ artist: 'Scale Artist', distributor: 'distrokid' }, result, released, { userId: 'tenant-a' });
 
     await runStorePresenceDeepScan(saved.id, { store, env: {}, targets: [target], maxTracks: 2_000, chunkSize: 25 }, 'tenant-a');
 
     const after = await store.get(saved.id);
     expect(catalogCalls).toBe(1);
     expect(after?.deepScan).toMatchObject({ status: 'done', tracksScanned: count, platformTracksVerified: { 'Scale DSP': count } });
     expect(after?.result.tracks).toHaveLength(count);
     expect(after?.result.tracks.every((track) => track.perStore.find((cell) => cell.store === 'Scale DSP')?.status === 'live')).toBe(true);
@@ -139,17 +139,17 @@ describe('mergePlatform', () => {
         store: 'Scale DSP', method: 'api', needsCredential: false,
         async listArtistCatalog(): Promise<StoreArtistCatalog> {
           catalogCalls++;
           throw new Error('must not be called');
         },
       },
     };
     const store = new InMemorySearchStore();
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Scale Artist', distributor: 'distrokid' }, result, released);
+    const saved = await store.save({ artist: 'Scale Artist', distributor: 'distrokid' }, result, released, { userId: 'tenant-a' });
 
     await expect(runStorePresenceDeepScan(saved.id, { store, env: {}, targets: [target], maxTracks: 1_000 }, 'tenant-a'))
       .rejects.toThrow(/no track was silently truncated/i);
 
     const after = await store.get(saved.id);
     expect(catalogCalls).toBe(0);
     expect(after?.deepScan).toMatchObject({ status: 'error', tracksScanned: 0 });
     expect(after?.result.tracks.every((track) => track.perStore.length === 0)).toBe(true);
diff --git a/apps/worker/src/distrokid/finalize-result.test.ts b/apps/worker/src/distrokid/finalize-result.test.ts
index d3bb2e5..83084ee 100644
--- a/apps/worker/src/distrokid/finalize-result.test.ts
+++ b/apps/worker/src/distrokid/finalize-result.test.ts
@@ -22,17 +22,17 @@ const completeness: FinalizeJob['completeness'] = {
   tracksIsrcAbsentAtSource: 0, releasesUpcNotCaptured: 0, tracksIsrcNotCaptured: 1,
   unresolvedReleaseIds: ['R2'], failureReasons: { TIMEOUT: 1 },
 };
 const job: FinalizeJob = {
   tenantId: 'tenant-a', connectionId: 'c1', snapshotId: 'search-1', distributor: 'distrokid',
   status: 'PARTIAL_RETRYABLE', completeness, pass: 3,
 };
 const record: SearchRecord = {
-  id: 'search-1', tenantId: 'tenant-a', createdAt: '2026-01-01T00:00:00.000Z', artist: 'Artist',
+  id: 'search-1', userId: 'tenant-a', createdAt: '2026-01-01T00:00:00.000Z', artist: 'Artist',
   distributor: 'distrokid', platforms: [], song: null,
   result: { artist: 'Artist', stores: [], profiles: [], tracks: [], summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: 'old', warnings: ['__reading_in_progress__'], note: 'reading' },
 };
 const outcomes: ReleaseExtractionOutcome[] = [
   {
     kind: 'COMPLETED', source: 'NETWORK_JSON', elapsedMs: 5,
     release: {
       distributorReleaseId: 'R1', title: 'Album', primaryArtist: 'Artist', featuredArtists: ['Guest One', 'Guest Two'], upc: field('123456789012'),
@@ -103,17 +103,17 @@ describe('projectFinalizedSnapshot', () => {
     ];
     const auto = projectFinalizedSnapshot(record, job, noReleases, '2026-02-01T00:00:00.000Z', true);
     const manual = projectFinalizedSnapshot(record, job, noReleases, '2026-02-01T00:00:00.000Z', false);
     expect(auto.deepScan?.status).toBe('done');
     expect(manual.deepScan?.status).toBe('done');
   });
 
   it('rejects a cross-tenant finalization', () => {
-    expect(() => projectFinalizedSnapshot({ ...record, tenantId: 'tenant-b' }, job, outcomes)).toThrow(/tenant/i);
+    expect(() => projectFinalizedSnapshot({ ...record, userId: 'tenant-b' }, job, outcomes)).toThrow(/tenant/i);
   });
 
   it('owns each featured-artist array and falls back to the correlated release title', () => {
     const withBlankTrack = structuredClone(outcomes);
     const completed = withBlankTrack[0];
     if (!completed || completed.kind !== 'COMPLETED') throw new Error('fixture must be completed');
     completed.release.tracks[0]!.title = '';
 
diff --git a/apps/worker/src/distrokid/finalize-result.ts b/apps/worker/src/distrokid/finalize-result.ts
index de27629..b5d3878 100644
--- a/apps/worker/src/distrokid/finalize-result.ts
+++ b/apps/worker/src/distrokid/finalize-result.ts
@@ -108,17 +108,17 @@ export function projectFinalizedSnapshot(
   const willDeepScan = hasReleased && autoPresence;
   const note = !hasReleased
     ? 'The distributor snapshot reached a terminal state, but no tracks were verified. Retry the attended connection or use a distributor export.'
     : willDeepScan
       ? `Verified ${job.completeness.completedReleases}/${job.completeness.expectedReleases} distributor release(s). Store-presence verification is queued; no missing-store claim is made until that evidence arrives.`
       : `Verified ${job.completeness.completedReleases}/${job.completeness.expectedReleases} distributor release(s). Run a store-presence check to verify each track's availability across stores; no missing-store claim is made until then.`;
   return {
     ...record,
-    tenantId: job.tenantId,
+    userId: job.tenantId,
     platforms: [],
     released,
     result: {
       artist: record.artist,
       stores: [],
       profiles: [],
       tracks,
       summary: { tracks: tracks.length, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
diff --git a/apps/worker/src/distrokid/principal-binding.test.ts b/apps/worker/src/distrokid/principal-binding.test.ts
index 7e0909e..d8a0a3a 100644
--- a/apps/worker/src/distrokid/principal-binding.test.ts
+++ b/apps/worker/src/distrokid/principal-binding.test.ts
@@ -1,38 +1,38 @@
 import { describe, expect, it } from 'vitest';
 import {
   CONSENT_DISCLOSURE_VERSION,
   CONSENT_PURPOSE,
   CONSENT_RETENTION_DAYS,
   InMemoryDistributorLinkRepository,
 } from '@sentinel/db';
-import { InMemorySearchStore } from '@sentinel/search-store';
+import { InMemorySearchStore, type SearchRecord } from '@sentinel/search-store';
 import { assertSnapshotPrincipalBinding, snapshotPrincipalBindingValid } from './principal-binding';
 
 const NOW = Date.parse('2026-07-22T12:00:00.000Z');
 
 async function fixture() {
   const store = new InMemorySearchStore();
   const repository = new InMemoryDistributorLinkRepository();
   const record = await store.save(
     {
-      tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'workspace-a',
       artist: 'Alice Artist', distributor: 'distrokid', platforms: [],
     },
     {
       artist: 'Alice Artist', stores: [], profiles: [], tracks: [],
       summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
       generatedAt: '2026-07-22T11:00:00.000Z', warnings: ['__reading_in_progress__'], note: 'reading',
     },
     [],
+    { userId: 'tenant-a' },
   );
   await repository.consents.put({ tenantId: 'tenant-a' }, {
     id: 'consent-a', tenantId: 'tenant-a', artistWorkspaceId: 'workspace-a',
-    grantedByUserId: 'alice', grantedAt: '2026-07-22T11:00:00.000Z',
+    grantedByUserId: 'tenant-a', grantedAt: '2026-07-22T11:00:00.000Z',
     purpose: CONSENT_PURPOSE, disclosureVersion: CONSENT_DISCLOSURE_VERSION,
     retentionDays: CONSENT_RETENTION_DAYS, distributor: 'distrokid',
     scope: 'distributor:read-catalog', provider: 'steel',
     expiresAt: '2026-07-22T18:00:00.000Z', revokedAt: null,
   });
   return {
     store,
     repository,
@@ -65,18 +65,18 @@ describe('DistroKid snapshot principal binding', () => {
     await expect(assertSnapshotPrincipalBinding(
       store, repository, { ...job, tenantId: 'tenant-b' }, NOW,
     )).rejects.toMatchObject({ name: 'SnapshotPrincipalBindingError' });
   });
 
   it('fails closed for legacy ownerless records and revoked grants', async () => {
     const { store, repository, job } = await fixture();
     const current = await store.get(job.snapshotId);
-    const { ownerUserId: _legacyOwner, ...legacy } = current!;
-    await store.put({ ...legacy, id: 'legacy-ownerless', revision: 1 });
+    const { userId: _legacyOwner, ...legacy } = current!;
+    await store.put({ ...legacy, id: 'legacy-ownerless', revision: 1 } as SearchRecord);
     await expect(snapshotPrincipalBindingValid(
       store, repository, { ...job, snapshotId: 'legacy-ownerless' }, NOW,
     )).resolves.toBe(false);
 
     const fresh = await fixture();
     await fresh.repository.consents.update(
       { tenantId: 'tenant-a' }, 'consent-a', { revokedAt: '2026-07-22T11:30:00.000Z' },
     );
diff --git a/apps/worker/src/distrokid/principal-binding.ts b/apps/worker/src/distrokid/principal-binding.ts
index 2caafe1..6bb5486 100644
--- a/apps/worker/src/distrokid/principal-binding.ts
+++ b/apps/worker/src/distrokid/principal-binding.ts
@@ -25,23 +25,22 @@ export async function snapshotPrincipalBindingValid(
   job: SnapshotPrincipalBinding,
   nowMs = Date.now(),
 ): Promise<boolean> {
   if (!job.consentId || !job.artistWorkspaceId) return false;
   const [record, consent] = await Promise.all([
     store.get(job.snapshotId),
     repository.consents.get({ tenantId: job.tenantId }, job.consentId),
   ]);
-  if (!record || !consent || !record.ownerUserId || !record.artistWorkspaceId) return false;
+  if (!record || !consent || !record.userId) return false;
   return Boolean(
     ownerOf(record) === job.tenantId
-    && record.artistWorkspaceId === job.artistWorkspaceId
     && consent.tenantId === job.tenantId
-    && consent.artistWorkspaceId === record.artistWorkspaceId
-    && consent.grantedByUserId === record.ownerUserId
+    && consent.artistWorkspaceId === job.artistWorkspaceId
+    && consent.grantedByUserId === record.userId
     && consent.distributor?.toLowerCase() === job.distributor.toLowerCase()
     && consent.provider === 'steel'
     && consent.scope === 'distributor:read-catalog'
     && Boolean(consent.grantedAt)
     && consent.purpose === CONSENT_PURPOSE
     && consent.disclosureVersion === CONSENT_DISCLOSURE_VERSION
     && consent.retentionDays === CONSENT_RETENTION_DAYS
     && !consent.revokedAt
diff --git a/apps/worker/src/distrokid/snapshot-store.integration.test.ts b/apps/worker/src/distrokid/snapshot-store.integration.test.ts
index d8d41f3..c3dbb16 100644
--- a/apps/worker/src/distrokid/snapshot-store.integration.test.ts
+++ b/apps/worker/src/distrokid/snapshot-store.integration.test.ts
@@ -131,17 +131,17 @@ describe.skipIf(!DATABASE_URL || !REDIS_URL)('tiered DistroKid checkpoints - rea
     // Duplicate delivery after a worker crash is an upsert, not a second row.
     await resumed.putOutcomes(scope.snapshotId, [outcome('R0000'), outcome('R1099')]);
 
     const all = await resumed.getOutcomes(scope.snapshotId);
     const releaseIds = all.map((entry) => entry.kind === 'COMPLETED' ? entry.release.distributorReleaseId : entry.distributorReleaseId);
     expect(all).toHaveLength(1_100);
     expect(new Set(releaseIds).size).toBe(1_100);
     const durableCount = await pool.query(
-      'SELECT count(*)::int AS count FROM "DistroKidCheckpointOutcome" WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3',
+      'SELECT count(*)::int AS count FROM "DistroKidCheckpointOutcome" WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3',
       [scope.tenantId, scope.connectionId, scope.snapshotId],
     );
     expect(durableCount.rows[0]?.count).toBe(1_100);
 
     // 1,100 rows at a configured batch size of 37 must create multiple bounded statements.
     // The index insert has nine parameters per row, including expectedTrackCount.
     expect(parameterCounts.filter((count) => count > 100).length).toBeGreaterThan(2);
     expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(37 * 9);
diff --git a/apps/worker/src/distrokid/snapshot-store.ts b/apps/worker/src/distrokid/snapshot-store.ts
index 025df2a..6187228 100644
--- a/apps/worker/src/distrokid/snapshot-store.ts
+++ b/apps/worker/src/distrokid/snapshot-store.ts
@@ -613,22 +613,22 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
     if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('checkpoint batch size must be between 1 and 500');
   }
 
   async bindSnapshot(binding: SnapshotCheckpointBinding): Promise<void> {
     validateBinding(binding);
     const cached = this.bindings.get(binding.snapshotId);
     if (cached && !sameBinding(cached, binding)) throw new SnapshotPrincipalMismatchError();
     await this.pool.query(
-      `INSERT INTO "DistroKidSnapshotCheckpoint" ("tenantId", "connectionId", "snapshotId", "distributor")
+      `INSERT INTO "DistroKidSnapshotCheckpoint" ("userId", "connectionId", "snapshotId", "distributor")
        VALUES ($1,$2,$3,$4) ON CONFLICT ("snapshotId") DO NOTHING`,
       [binding.tenantId, binding.connectionId, binding.snapshotId, binding.distributor],
     );
     const result = await this.pool.query(
-      `SELECT "tenantId", "connectionId", "snapshotId", "distributor",
+      `SELECT "userId" AS "tenantId", "connectionId", "snapshotId", "distributor",
               "indexVersion", "outcomesVersion", "progressVersion", "chunksVersion", "plansVersion", "terminalVersion"
          FROM "DistroKidSnapshotCheckpoint" WHERE "snapshotId" = $1`,
       [binding.snapshotId],
     );
     const row = result.rows[0] as (SnapshotCheckpointBinding & Record<`${CheckpointPart}Version`, string | bigint>) | undefined;
     if (!row || !sameBinding(row, binding)) throw new SnapshotPrincipalMismatchError();
     this.bindings.set(binding.snapshotId, { ...binding });
     this.versions.set(binding.snapshotId, {
@@ -638,17 +638,17 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
     });
   }
 
   async refreshVersion(snapshotId: string, part: CheckpointPart): Promise<bigint> {
     const binding = this.binding(snapshotId);
     const column = VERSION_COLUMNS[part];
     const result = await this.pool.query(
       `SELECT "${column}" AS "version" FROM "DistroKidSnapshotCheckpoint"
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
       this.params(binding),
     );
     if (!result.rows[0]) throw new SnapshotPrincipalMismatchError();
     const version = BigInt(result.rows[0]['version'] as string | bigint);
     const versions = this.versions.get(snapshotId);
     if (!versions) throw new SnapshotBindingRequiredError(snapshotId);
     versions[part] = version;
     return version;
@@ -684,28 +684,28 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
     } finally {
       client.release();
     }
   }
 
   private async lock(client: PoolClient, binding: SnapshotCheckpointBinding): Promise<void> {
     const locked = await client.query(
       `SELECT 1 FROM "DistroKidSnapshotCheckpoint"
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 FOR UPDATE`,
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 FOR UPDATE`,
       this.params(binding),
     );
     if (locked.rowCount !== 1) throw new SnapshotPrincipalMismatchError();
   }
 
   private async bumpVersion(client: PoolClient, binding: SnapshotCheckpointBinding, part: CheckpointPart): Promise<bigint> {
     const column = VERSION_COLUMNS[part];
     const result = await client.query(
       `UPDATE "DistroKidSnapshotCheckpoint"
           SET "${column}"="${column}"+1, "updatedAt"=clock_timestamp()
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3
         RETURNING "${column}" AS "version"`,
       this.params(binding),
     );
     if (!result.rows[0]) throw new SnapshotPrincipalMismatchError();
     const version = BigInt(result.rows[0]['version'] as string | bigint);
     const versions = this.versions.get(binding.snapshotId);
     if (!versions) throw new SnapshotBindingRequiredError(binding.snapshotId);
     versions[part] = version;
@@ -715,46 +715,46 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
   async putIndex(snapshotId: string, releases: ReleaseRefRecord[]): Promise<void> {
     const binding = this.binding(snapshotId);
     if (!Array.isArray(releases) || releases.length > MAX_RELEASES) throw new Error('snapshot index exceeds its bounded release limit');
     const sanitized = releases.map(sanitizeReleaseRef);
     if (new Set(sanitized.map((release) => release.releaseId)).size !== sanitized.length) throw new Error('snapshot index contains duplicate release ids');
     await this.transaction(async (client) => {
       await this.lock(client, binding);
       await client.query(
-        `DELETE FROM "DistroKidCheckpointIndex" WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
+        `DELETE FROM "DistroKidCheckpointIndex" WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
         this.params(binding),
       );
       for (let offset = 0; offset < sanitized.length; offset += this.batchSize) {
         const batch = sanitized.slice(offset, offset + this.batchSize);
         const values = batch.flatMap((release, index) => [
           binding.tenantId, binding.connectionId, binding.snapshotId, release.releaseId,
           offset + index, release.dashboardUrl, release.title ?? null, release.artist ?? null,
           release.expectedTrackCount ?? null,
         ]);
         await client.query(
           `INSERT INTO "DistroKidCheckpointIndex"
-             ("tenantId","connectionId","snapshotId","releaseId","ordinal","dashboardUrl","title","artist","expectedTrackCount")
+             ("userId","connectionId","snapshotId","releaseId","ordinal","dashboardUrl","title","artist","expectedTrackCount")
            VALUES ${placeholders(batch.length, 9)}`,
           values,
         );
       }
       await this.bumpVersion(client, binding, 'index');
     });
   }
 
   async getIndex(snapshotId: string): Promise<ReleaseRefRecord[]> {
     const binding = this.binding(snapshotId);
     const result: ReleaseRefRecord[] = [];
     let after = -1;
     while (true) {
       const query = await this.pool.query(
         `SELECT "releaseId", "dashboardUrl", "title", "artist", "expectedTrackCount", "ordinal"
            FROM "DistroKidCheckpointIndex"
-          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "ordinal">$4
+          WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "ordinal">$4
           ORDER BY "ordinal" LIMIT $5`,
         [...this.params(binding), after, CHECKPOINT_PAGE_SIZE],
       );
       for (const raw of query.rows as Array<ReleaseRefRecord & { ordinal: number }>) {
         result.push(sanitizeReleaseRef(raw));
         after = raw.ordinal;
       }
       if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
@@ -770,35 +770,35 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
       await this.lock(client, binding);
       for (let offset = 0; offset < sanitized.length; offset += this.batchSize) {
         const batch = sanitized.slice(offset, offset + this.batchSize);
         const values = batch.flatMap((outcome) => [
           binding.tenantId, binding.connectionId, binding.snapshotId, outcomeId(outcome), JSON.stringify(outcome),
         ]);
         await client.query(
           `INSERT INTO "DistroKidCheckpointOutcome"
-             ("tenantId","connectionId","snapshotId","releaseId","outcome")
+             ("userId","connectionId","snapshotId","releaseId","outcome")
            VALUES ${placeholders(batch.length, 5)}
-           ON CONFLICT ("tenantId","connectionId","snapshotId","releaseId") DO UPDATE
+           ON CONFLICT ("userId","connectionId","snapshotId","releaseId") DO UPDATE
              SET "outcome"=EXCLUDED."outcome", "updatedAt"=clock_timestamp()`,
           values,
         );
       }
       if (sanitized.length > 0) await this.bumpVersion(client, binding, 'outcomes');
     });
   }
 
   async getOutcomes(snapshotId: string): Promise<ReleaseExtractionOutcome[]> {
     const binding = this.binding(snapshotId);
     const outcomes: ReleaseExtractionOutcome[] = [];
     let after = '';
     while (true) {
       const query = await this.pool.query(
         `SELECT "releaseId", "outcome" FROM "DistroKidCheckpointOutcome"
-          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "releaseId">$4
+          WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "releaseId">$4
           ORDER BY "releaseId" LIMIT $5`,
         [...this.params(binding), after, CHECKPOINT_PAGE_SIZE],
       );
       for (const raw of query.rows as Array<{ releaseId: string; outcome: unknown }>) {
         outcomes.push(sanitizeOutcome(parseJson<ReleaseExtractionOutcome>(raw.outcome)));
         after = raw.releaseId;
       }
       if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
@@ -808,19 +808,19 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
 
   async putProgress(progress: SnapshotProgress): Promise<void> {
     const binding = this.binding(progress.snapshotId);
     const value = sanitizeProgress(progress, binding);
     await this.transaction(async (client) => {
       await this.lock(client, binding);
       await client.query(
         `INSERT INTO "DistroKidCheckpointProgress"
-         ("tenantId","connectionId","snapshotId","distributor","status","expectedReleases","completedReleases","failedReleases","chunkCount","completedChunks","startedAt","updatedAt")
+         ("userId","connectionId","snapshotId","distributor","status","expectedReleases","completedReleases","failedReleases","chunkCount","completedChunks","startedAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
-       ON CONFLICT ("tenantId","connectionId","snapshotId") DO UPDATE SET
+       ON CONFLICT ("userId","connectionId","snapshotId") DO UPDATE SET
          "distributor"=EXCLUDED."distributor", "status"=EXCLUDED."status",
          "expectedReleases"=EXCLUDED."expectedReleases", "completedReleases"=EXCLUDED."completedReleases",
          "failedReleases"=EXCLUDED."failedReleases", "chunkCount"=EXCLUDED."chunkCount",
          "completedChunks"=EXCLUDED."completedChunks", "startedAt"=EXCLUDED."startedAt", "updatedAt"=EXCLUDED."updatedAt"`,
         [
           value.tenantId, value.connectionId, value.snapshotId, value.distributor, value.status,
           value.expectedReleases, value.completedReleases, value.failedReleases, value.chunkCount,
           value.completedChunks, value.startedAt, value.updatedAt,
@@ -828,21 +828,21 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
       );
       await this.bumpVersion(client, binding, 'progress');
     });
   }
 
   async getProgress(snapshotId: string): Promise<SnapshotProgress | null> {
     const binding = this.binding(snapshotId);
     const query = await this.pool.query(
-      `SELECT "snapshotId", "tenantId", "connectionId", "distributor", "status",
+      `SELECT "snapshotId", "userId" AS "tenantId", "connectionId", "distributor", "status",
               "expectedReleases", "completedReleases", "failedReleases", "chunkCount",
               "completedChunks", "startedAt", "updatedAt"
          FROM "DistroKidCheckpointProgress"
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
       this.params(binding),
     );
     const raw = query.rows[0] as (Omit<SnapshotProgress, 'startedAt' | 'updatedAt'> & { startedAt: Date | string; updatedAt: Date | string }) | undefined;
     if (!raw) return null;
     return sanitizeProgress({
       ...raw,
       startedAt: raw.startedAt instanceof Date ? raw.startedAt.toISOString() : raw.startedAt,
       updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt.toISOString() : raw.updatedAt,
@@ -852,34 +852,34 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
   async markChunkComplete(snapshotId: string, pass: number, chunkIndex: number): Promise<void> {
     const binding = this.binding(snapshotId);
     const safePass = nonNegativeInteger(pass, 'chunk pass');
     if (safePass < 1) throw new Error('checkpoint pass must be positive');
     const safeChunk = nonNegativeInteger(chunkIndex, 'chunk index');
     await this.transaction(async (client) => {
       await this.lock(client, binding);
       const inserted = await client.query(
-        `INSERT INTO "DistroKidCheckpointChunk" ("tenantId","connectionId","snapshotId","pass","chunkIndex")
+        `INSERT INTO "DistroKidCheckpointChunk" ("userId","connectionId","snapshotId","pass","chunkIndex")
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
         [...this.params(binding), safePass, safeChunk],
       );
       if (inserted.rowCount === 1) await this.bumpVersion(client, binding, 'chunks');
     });
   }
 
   async completedChunks(snapshotId: string, pass: number): Promise<number[]> {
     const binding = this.binding(snapshotId);
     const safePass = nonNegativeInteger(pass, 'chunk pass');
     if (safePass < 1) throw new Error('checkpoint pass must be positive');
     const chunks: number[] = [];
     let after = -1;
     while (true) {
       const query = await this.pool.query(
         `SELECT "chunkIndex" FROM "DistroKidCheckpointChunk"
-          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
+          WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
           ORDER BY "chunkIndex" LIMIT $6`,
         [...this.params(binding), safePass, after, CHECKPOINT_PAGE_SIZE],
       );
       for (const row of query.rows as Array<{ chunkIndex: number }>) {
         chunks.push(nonNegativeInteger(row.chunkIndex, 'stored chunk index'));
         after = row.chunkIndex;
       }
       if (query.rows.length < CHECKPOINT_PAGE_SIZE) break;
@@ -888,17 +888,17 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
   }
 
   async completedChunkCount(snapshotId: string, pass: number): Promise<bigint> {
     const binding = this.binding(snapshotId);
     const safePass = nonNegativeInteger(pass, 'chunk pass');
     if (safePass < 1) throw new Error('checkpoint pass must be positive');
     const query = await this.pool.query(
       `SELECT count(*)::bigint AS "count" FROM "DistroKidCheckpointChunk"
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
       [...this.params(binding), safePass],
     );
     return BigInt(query.rows[0]?.['count'] as string | bigint);
   }
 
   async putPassPlan(snapshotId: string, pass: number, releaseIdChunks: string[][]): Promise<void> {
     const binding = this.binding(snapshotId);
     const safePass = nonNegativeInteger(pass, 'plan pass');
@@ -906,27 +906,27 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
     const plan = releaseIdChunks.map((chunk, chunkIndex) => {
       if (!Array.isArray(chunk) || chunk.length > 1_000) throw new Error(`pass plan chunk ${chunkIndex} exceeds its bounded size`);
       return chunk.map((id) => textValue(id, `pass plan ${chunkIndex} releaseId`, 512));
     });
     await this.transaction(async (client) => {
       await this.lock(client, binding);
       await client.query(
         `DELETE FROM "DistroKidCheckpointPassPlanChunk"
-          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
+          WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4`,
         [...this.params(binding), safePass],
       );
       for (let offset = 0; offset < plan.length; offset += this.batchSize) {
         const batch = plan.slice(offset, offset + this.batchSize);
         const values = batch.flatMap((releaseIds, index) => [
           binding.tenantId, binding.connectionId, binding.snapshotId, safePass, offset + index, releaseIds,
         ]);
         await client.query(
           `INSERT INTO "DistroKidCheckpointPassPlanChunk"
-             ("tenantId","connectionId","snapshotId","pass","chunkIndex","releaseIds")
+             ("userId","connectionId","snapshotId","pass","chunkIndex","releaseIds")
            VALUES ${placeholders(batch.length, 6)}`,
           values,
         );
       }
       await this.bumpVersion(client, binding, 'plans');
     });
   }
 
@@ -934,17 +934,17 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
     const binding = this.binding(snapshotId);
     const safePass = nonNegativeInteger(pass, 'plan pass');
     if (safePass < 1) throw new Error('checkpoint plan pass must be positive');
     const plan: string[][] = [];
     let after = -1;
     while (true) {
       const query = await this.pool.query(
         `SELECT "chunkIndex", "releaseIds" FROM "DistroKidCheckpointPassPlanChunk"
-          WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
+          WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3 AND "pass"=$4 AND "chunkIndex">$5
           ORDER BY "chunkIndex" LIMIT $6`,
         [...this.params(binding), safePass, after, CHECKPOINT_PAGE_SIZE],
       );
       for (const row of query.rows as Array<{ chunkIndex: number; releaseIds: string[] }>) {
         if (row.chunkIndex !== plan.length) throw new Error('durable pass plan contains a non-contiguous chunk index');
         plan.push(row.releaseIds.map((id) => textValue(id, 'stored pass plan releaseId', 512)));
         after = row.chunkIndex;
       }
@@ -954,34 +954,34 @@ export class PostgresSnapshotCheckpointStore implements SnapshotCheckpointStore
   }
 
   async claimTerminal(snapshotId: string, tombstone: SnapshotTerminalTombstone): Promise<SnapshotTerminalTombstone> {
     const binding = this.binding(snapshotId);
     const proposed = sanitizeTombstone(tombstone, binding);
     const inserted = await this.transaction(async (client) => {
       await this.lock(client, binding);
       const result = await client.query(
-        `INSERT INTO "DistroKidCheckpointTerminal" ("tenantId","connectionId","snapshotId","tombstone")
+        `INSERT INTO "DistroKidCheckpointTerminal" ("userId","connectionId","snapshotId","tombstone")
          VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING "tombstone"`,
         [...this.params(binding), JSON.stringify(proposed)],
       );
       if (result.rows[0]) await this.bumpVersion(client, binding, 'terminal');
       return result;
     });
     if (inserted.rows[0]) return sanitizeTombstone(parseJson<SnapshotTerminalTombstone>(inserted.rows[0]['tombstone']), binding);
     const existing = await this.getTerminal(snapshotId);
     if (!existing) throw new Error('durable terminal tombstone ownership could not be confirmed');
     return existing;
   }
 
   async getTerminal(snapshotId: string): Promise<SnapshotTerminalTombstone | null> {
     const binding = this.binding(snapshotId);
     const query = await this.pool.query(
       `SELECT "tombstone" FROM "DistroKidCheckpointTerminal"
-        WHERE "tenantId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
+        WHERE "userId"=$1 AND "connectionId"=$2 AND "snapshotId"=$3`,
       this.params(binding),
     );
     if (!query.rows[0]) return null;
     return sanitizeTombstone(parseJson<SnapshotTerminalTombstone>(query.rows[0]['tombstone']), binding);
   }
 }
 
 export interface TieredSnapshotStoreOptions {
diff --git a/packages/persistence/src/candidate-store.ts b/packages/persistence/src/candidate-store.ts
index 8efb0f6..7816bda 100644
--- a/packages/persistence/src/candidate-store.ts
+++ b/packages/persistence/src/candidate-store.ts
@@ -28,38 +28,38 @@ export class PostgresCandidateStore implements CandidateStore {
   /**
    * `write` matches the `CandidateSink` shape used by the extractor. It is intentionally
    * best-effort at the call site: recording a candidate must never fail a user's catalogue read.
    */
   async write(c: CandidateLike, scope: CandidateScope): Promise<void> {
     // Enforce the cap for NEW fingerprints only, an existing row must still be updatable, or a
     // busy scan would stop counting observations for endpoints it already knows about.
     const countRes = await this.pool.query<{ n: string }>(
-      `SELECT COUNT(*)::text AS n FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2`,
+      `SELECT COUNT(*)::text AS n FROM "DistributorEndpointCandidate" WHERE "userId" = $1 AND "scanId" = $2`,
       [scope.tenantId, scope.scanId],
     );
     const existingCount = Number(countRes.rows[0]?.n ?? '0');
     if (existingCount >= this.maxPerScan) {
       const known = await this.pool.query(
-        `SELECT 1 FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2 AND "fingerprint" = $3`,
+        `SELECT 1 FROM "DistributorEndpointCandidate" WHERE "userId" = $1 AND "scanId" = $2 AND "fingerprint" = $3`,
         [scope.tenantId, scope.scanId, c.fingerprint],
       );
       if (known.rowCount === 0) return;
     }
 
     await this.pool.query(
       `INSERT INTO "DistributorEndpointCandidate" (
-         "id", "tenantId", "scanId", "distributor", "fingerprint",
+         "id", "userId", "scanId", "distributor", "fingerprint",
          "method", "host", "maskedPath", "queryKeys", "operationName",
          "schemaKeys", "schemaHash", "score", "observations", "distinctPayloads",
          "variesPerRelease", "sizeBytes", "firstSeenAt", "lastSeenAt"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, 1, false, $13, $14, $14
        )
-       ON CONFLICT ("tenantId", "scanId", "fingerprint") DO UPDATE SET
+       ON CONFLICT ("userId", "scanId", "fingerprint") DO UPDATE SET
          "score" = GREATEST("DistributorEndpointCandidate"."score", EXCLUDED."score"),
          "observations" = "DistributorEndpointCandidate"."observations" + 1,
          "schemaKeys" = EXCLUDED."schemaKeys",
          "schemaHash" = EXCLUDED."schemaHash",
          "sizeBytes" = EXCLUDED."sizeBytes",
          "lastSeenAt" = EXCLUDED."lastSeenAt"`,
       [
         scope.tenantId, scope.scanId, this.distributor, c.fingerprint,
@@ -70,26 +70,26 @@ export class PostgresCandidateStore implements CandidateStore {
         c.schemaHash, c.score, c.bodyBytes, c.observedAt,
       ],
     );
   }
 
   async list(tenantId: string, scanId: string): Promise<StoredCandidate[]> {
     const res = await this.pool.query<CandidateRow>(
       `SELECT * FROM "DistributorEndpointCandidate"
-       WHERE "tenantId" = $1 AND "scanId" = $2
+       WHERE "userId" = $1 AND "scanId" = $2
        ORDER BY "score" DESC, "observations" DESC`,
       [tenantId, scanId],
     );
     return res.rows.map(toStored);
   }
 
   async clear(tenantId: string, scanId: string): Promise<void> {
     await this.pool.query(
-      `DELETE FROM "DistributorEndpointCandidate" WHERE "tenantId" = $1 AND "scanId" = $2`,
+      `DELETE FROM "DistributorEndpointCandidate" WHERE "userId" = $1 AND "scanId" = $2`,
       [tenantId, scanId],
     );
   }
 }
 
 /** The subset of the extractor's `NetworkCandidate` this store persists. */
 export interface CandidateLike {
   fingerprint: string;
diff --git a/packages/persistence/src/endpoint-registry-store.ts b/packages/persistence/src/endpoint-registry-store.ts
index 914fac0..7653375 100644
--- a/packages/persistence/src/endpoint-registry-store.ts
+++ b/packages/persistence/src/endpoint-registry-store.ts
@@ -26,48 +26,48 @@ import type {
  * a response body.
  */
 export class PostgresEndpointRegistryStore implements EndpointRegistryStore {
   constructor(private readonly pool: Pool) {}
 
   async get(scope: RegistryScope, fingerprint: string): Promise<DistributorEndpointProfile | null> {
     const res = await this.pool.query<ProfileRow>(
       `SELECT * FROM "DistributorEndpointProfile"
-       WHERE "tenantId" = $1 AND "distributor" = $2 AND "fingerprint" = $3`,
+       WHERE "userId" = $1 AND "distributor" = $2 AND "fingerprint" = $3`,
       [scope.tenantId, scope.distributor, fingerprint],
     );
     const row = res.rows[0];
     return row ? toProfile(row) : null;
   }
 
   async list(scope: RegistryScope): Promise<DistributorEndpointProfile[]> {
     const res = await this.pool.query<ProfileRow>(
       `SELECT * FROM "DistributorEndpointProfile"
-       WHERE "tenantId" = $1 AND "distributor" = $2
+       WHERE "userId" = $1 AND "distributor" = $2
        ORDER BY "lastSeenAt" DESC`,
       [scope.tenantId, scope.distributor],
     );
     return res.rows.map(toProfile);
   }
 
   async put(profile: DistributorEndpointProfile): Promise<void> {
     // Upsert on the natural key. Concurrent workers observing the same endpoint must converge on
     // one row; an insert-or-fail here would turn a normal race into a job failure.
     await this.pool.query(
       `INSERT INTO "DistributorEndpointProfile" (
-         "id", "tenantId", "distributor", "fingerprint", "role", "status",
+         "id", "userId", "distributor", "fingerprint", "role", "status",
          "method", "host", "maskedPath", "queryKeys", "operationName",
          "schemaHash", "schemaKeys", "parserVersion",
          "successCount", "failureCount", "candidateScore", "validationCount", "schemaDriftCount",
          "firstSeenAt", "lastSeenAt", "promotedAt", "degradedAt"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        )
-       ON CONFLICT ("tenantId", "distributor", "fingerprint") DO UPDATE SET
+       ON CONFLICT ("userId", "distributor", "fingerprint") DO UPDATE SET
          "role" = EXCLUDED."role",
          "status" = EXCLUDED."status",
          "method" = EXCLUDED."method",
          "host" = EXCLUDED."host",
          "maskedPath" = EXCLUDED."maskedPath",
          "queryKeys" = EXCLUDED."queryKeys",
          "operationName" = EXCLUDED."operationName",
          "schemaHash" = EXCLUDED."schemaHash",
@@ -99,17 +99,17 @@ export class PostgresEndpointRegistryStore implements EndpointRegistryStore {
         profile.status === 'DEGRADED' ? profile.lastSeenAt : null,
       ],
     );
   }
 }
 
 interface ProfileRow {
   id: string;
-  tenantId: string;
+  userId: string;
   distributor: string;
   fingerprint: string;
   role: string;
   status: string;
   method: string;
   host: string;
   maskedPath: string;
   queryKeys: string[] | null;
@@ -126,17 +126,17 @@ interface ProfileRow {
   lastSeenAt: Date;
   promotedAt: Date | null;
   retiredAt?: Date | null;
 }
 
 function toProfile(row: ProfileRow): DistributorEndpointProfile {
   return {
     id: row.id,
-    tenantId: row.tenantId,
+    tenantId: row.userId,
     distributor: row.distributor,
     role: row.role as EndpointRole,
     fingerprint: row.fingerprint,
     method: row.method,
     hostPattern: row.host,
     pathPattern: row.maskedPath,
     queryKeyShape: row.queryKeys ?? [],
     ...(row.operationName ? { graphqlOperationName: row.operationName } : {}),
diff --git a/packages/persistence/src/outcome-repository.ts b/packages/persistence/src/outcome-repository.ts
index 96c48a8..00e610f 100644
--- a/packages/persistence/src/outcome-repository.ts
+++ b/packages/persistence/src/outcome-repository.ts
@@ -151,17 +151,17 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
     const snap = await this.pool.query<{
       id: string; status: string; finalizedAt: Date | null;
       storeLyricsStatus: string; storeLyricsChecked: number; storeLyricsTotal: number;
       storeLyricsError: string | null; storeLyricsCheckedAt: Date | null;
     }>(
       `SELECT "id", "status", "finalizedAt", "storeLyricsStatus", "storeLyricsChecked",
               "storeLyricsTotal", "storeLyricsError", "storeLyricsCheckedAt"
        FROM "DistributorExtractionSnapshot"
-       WHERE "tenantId" = $1 AND "snapshotId" = $2 LIMIT 1`,
+       WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
       [tenantId, snapshotId],
     );
     const snapshotRow = snap.rows[0];
     if (!snapshotRow) return null;
 
     const rel = await this.pool.query<{
       id: string; distributorReleaseId: string; title: string | null; primaryArtist: string | null;
       label: string | null; releaseDate: string | null; uploadDate: string | null;
@@ -259,17 +259,17 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
    * Targets for the dedicated DistroKid lyric scan: each COMPLETED release's row id + raw
    * `distributorReleaseId` (a navigable dashboard URL or bare album UUID) + every track's stable
    * `(trackIndex, trackNumber)`. `trackIndex` is the DB unique key; `trackNumber` matches the id
    * on the album page's per-track lyric control. Independent of `readCatalogue` because that view
    * deliberately drops the row id + trackIndex.
    */
   async readLyricScanTargets(tenantId: string, snapshotId: string, opts: { unreadDistroKidLyricsOnly?: boolean } = {}): Promise<LyricScanTarget[]> {
     const snap = await this.pool.query<{ id: string }>(
-      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "tenantId" = $1 AND "snapshotId" = $2 LIMIT 1`,
+      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
       [tenantId, snapshotId],
     );
     const snapshotUuid = snap.rows[0]?.id;
     if (!snapshotUuid) return [];
     // Resumability for the DistroKid lyric scan: with `unreadDistroKidLyricsOnly`, only releases that
     // still have at least one track whose DistroKid lyric state was never read (`plainLyricsStatus =
     // 'unknown'`) are returned, so a scan that ran out of session time resumes on the remaining
     // releases instead of re-reading the ones already done. The store-lyrics check omits this flag
@@ -326,24 +326,24 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
        SET "plainLyricsStatus" = prior."plain", "syncedLyricsStatus" = prior."synced"
        FROM "DistributorReleaseOutcome" r
        JOIN "DistributorExtractionSnapshot" s ON r."extractionSnapshotId" = s."id"
        JOIN LATERAL (
          SELECT t2."plainLyricsStatus" AS "plain", t2."syncedLyricsStatus" AS "synced"
          FROM "DistributorTrackOutcome" t2
          JOIN "DistributorReleaseOutcome" r2 ON t2."releaseOutcomeId" = r2."id"
          JOIN "DistributorExtractionSnapshot" s2 ON r2."extractionSnapshotId" = s2."id"
-         WHERE s2."tenantId" = $1 AND s2."snapshotId" <> $2
+         WHERE s2."userId" = $1 AND s2."snapshotId" <> $2
            AND r2."distributorReleaseId" = r."distributorReleaseId"
            AND t2."trackIndex" = t."trackIndex"
            AND t2."plainLyricsStatus" <> 'unknown'
          ORDER BY s2."startedAt" DESC
          LIMIT 1
        ) prior ON TRUE
-       WHERE t."releaseOutcomeId" = r."id" AND s."tenantId" = $1 AND s."snapshotId" = $2
+       WHERE t."releaseOutcomeId" = r."id" AND s."userId" = $1 AND s."snapshotId" = $2
          AND t."plainLyricsStatus" = 'unknown'`,
       [tenantId, snapshotId],
     );
     return res.rowCount ?? 0;
   }
 
   /** Update ONLY the store-side lyric columns for a release's tracks, keyed by `(releaseOutcomeId,
    *  trackIndex)`. Independent of `updateTrackLyrics` (DistroKid side) so the two lyric passes never
@@ -374,29 +374,29 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
   ): Promise<void> {
     await this.pool.query(
       `UPDATE "DistributorExtractionSnapshot"
        SET "storeLyricsStatus" = $3,
            "storeLyricsChecked" = COALESCE($4, "storeLyricsChecked"),
            "storeLyricsTotal" = COALESCE($5, "storeLyricsTotal"),
            "storeLyricsError" = $6,
            "storeLyricsCheckedAt" = CASE WHEN $3 = 'done' THEN NOW() ELSE "storeLyricsCheckedAt" END
-       WHERE "tenantId" = $1 AND "snapshotId" = $2`,
+       WHERE "userId" = $1 AND "snapshotId" = $2`,
       [tenantId, snapshotId, p.status, p.checked ?? null, p.total ?? null, p.error ?? null],
     );
   }
 
   /** Lightweight read of just the store-lyrics-check progress (for the polling status endpoint). */
   async readStoreLyricsProgress(tenantId: string, snapshotId: string): Promise<StoreLyricsProgress | null> {
     const res = await this.pool.query<{
       storeLyricsStatus: string; storeLyricsChecked: number; storeLyricsTotal: number;
       storeLyricsError: string | null; storeLyricsCheckedAt: Date | null;
     }>(
       `SELECT "storeLyricsStatus", "storeLyricsChecked", "storeLyricsTotal", "storeLyricsError", "storeLyricsCheckedAt"
-       FROM "DistributorExtractionSnapshot" WHERE "tenantId" = $1 AND "snapshotId" = $2 LIMIT 1`,
+       FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
       [tenantId, snapshotId],
     );
     const row = res.rows[0];
     if (!row) return null;
     return {
       status: row.storeLyricsStatus ?? 'idle',
       checked: row.storeLyricsChecked ?? 0,
       total: row.storeLyricsTotal ?? 0,
@@ -409,17 +409,17 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
    *  album UUID exposed by `readCatalogue`) + `trackIndex`; the releaseId is resolved to the internal
    *  release row within this snapshot. `mark: null` clears it. Returns the number of rows updated. */
   async updateTrackMarks(
     tenantId: string,
     snapshotId: string,
     marks: Array<{ releaseId: string; trackIndex: number; mark: string | null; note?: string | null }>,
   ): Promise<number> {
     const snap = await this.pool.query<{ id: string }>(
-      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "tenantId" = $1 AND "snapshotId" = $2 LIMIT 1`,
+      `SELECT "id" FROM "DistributorExtractionSnapshot" WHERE "userId" = $1 AND "snapshotId" = $2 LIMIT 1`,
       [tenantId, snapshotId],
     );
     const snapshotUuid = snap.rows[0]?.id;
     if (!snapshotUuid) return 0;
     const rels = await this.pool.query<{ id: string; distributorReleaseId: string }>(
       `SELECT "id", "distributorReleaseId" FROM "DistributorReleaseOutcome" WHERE "extractionSnapshotId" = $1`,
       [snapshotUuid],
     );
@@ -471,27 +471,27 @@ export class DistroKidOutcomeRepository implements OutcomeRepository {
     }
   }
 }
 
 async function upsertSnapshot(client: PoolClient, job: FinalizeJob): Promise<string> {
   const c = job.completeness;
   const res = await client.query<{ id: string }>(
     `INSERT INTO "DistributorExtractionSnapshot" (
-       "id", "tenantId", "connectionId", "snapshotId", "distributor", "status", "engine",
+       "id", "userId", "connectionId", "snapshotId", "distributor", "status", "engine",
        "expectedReleases", "completedReleases", "failedReleases", "expectedTracksKnown", "expectedTracks", "extractedTracks",
        "releasesWithUpc", "releasesWithArtwork", "tracksWithIsrc",
        "releasesUpcAbsentAtSource", "tracksIsrcAbsentAtSource",
        "releasesUpcNotCaptured", "tracksIsrcNotCaptured",
        "unresolvedReleaseIds", "failureReasons", "finalizedAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4, $5, 'NETWORK_FIRST',
        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW()
      )
-     ON CONFLICT ("tenantId", "snapshotId") DO UPDATE SET
+     ON CONFLICT ("userId", "snapshotId") DO UPDATE SET
        "status" = EXCLUDED."status",
        "expectedReleases" = EXCLUDED."expectedReleases",
        "completedReleases" = EXCLUDED."completedReleases",
        "failedReleases" = EXCLUDED."failedReleases",
        "expectedTracksKnown" = EXCLUDED."expectedTracksKnown",
        "expectedTracks" = EXCLUDED."expectedTracks",
        "extractedTracks" = EXCLUDED."extractedTracks",
        "releasesWithUpc" = EXCLUDED."releasesWithUpc",
@@ -526,17 +526,17 @@ async function upsertOutcome(
 ): Promise<void> {
   const releaseId = outcome.kind === 'COMPLETED' ? outcome.release.distributorReleaseId : outcome.distributorReleaseId;
   const r: CanonicalDistributorRelease | null = outcome.kind === 'COMPLETED' ? outcome.release : null;
   // Reason CODE only. `detail` is deliberately never persisted: it can quote response content.
   const reason = outcome.kind === 'COMPLETED' ? null : outcome.reason;
 
   const res = await client.query<{ id: string }>(
     `INSERT INTO "DistributorReleaseOutcome" (
-       "id", "tenantId", "extractionSnapshotId", "distributorReleaseId", "kind", "reason",
+       "id", "userId", "extractionSnapshotId", "distributorReleaseId", "kind", "reason",
        "title", "primaryArtist", "label", "releaseDate", "uploadDate", "artworkUrl", "upc",
        "upcStatus", "artworkStatus", "source", "parserVersion", "endpointFingerprint",
        "capturedAt", "submittedStores", "updatedAt"
      ) VALUES (
        gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, NOW()
      )
      ON CONFLICT ("extractionSnapshotId", "distributorReleaseId") DO UPDATE SET
        "kind" = EXCLUDED."kind", "reason" = EXCLUDED."reason",
@@ -587,17 +587,17 @@ async function upsertOutcome(
       [outcomeRowId, keepIndexes],
     );
   }
   if (!r) return;
 
   for (const [i, t] of r.tracks.entries()) {
     await client.query(
       `INSERT INTO "DistributorTrackOutcome" (
-         "id", "tenantId", "releaseOutcomeId", "distributorTrackId", "trackIndex",
+         "id", "userId", "releaseOutcomeId", "distributorTrackId", "trackIndex",
          "title", "primaryArtist", "featuredArtists", "trackNumber", "durationMs",
          "isrc", "isrcStatus", "source", "parserVersion", "capturedAt",
          "plainLyricsStatus", "syncedLyricsStatus"
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT ("releaseOutcomeId", "trackIndex") DO UPDATE SET
          "distributorTrackId" = EXCLUDED."distributorTrackId",
diff --git a/packages/persistence/src/persistence.integration.test.ts b/packages/persistence/src/persistence.integration.test.ts
index 757bf38..09b45ce 100644
--- a/packages/persistence/src/persistence.integration.test.ts
+++ b/packages/persistence/src/persistence.integration.test.ts
@@ -61,28 +61,28 @@ describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
     pool = new Pool({ connectionString: DATABASE_URL });
     await pool.query('SELECT 1');
   });
 
   afterAll(async () => { await pool.end(); });
 
   beforeEach(async () => {
     // Cascades clear release/track outcomes.
-    await pool.query(`DELETE FROM "DistributorExtractionSnapshot" WHERE "tenantId" LIKE 't-pg%'`);
-    await pool.query(`DELETE FROM "DistributorEndpointProfile" WHERE "tenantId" LIKE 't-pg%'`);
-    await pool.query(`DELETE FROM "DistributorEndpointCandidate" WHERE "tenantId" LIKE 't-pg%'`);
+    await pool.query(`DELETE FROM "DistributorExtractionSnapshot" WHERE "userId" LIKE 't-pg%'`);
+    await pool.query(`DELETE FROM "DistributorEndpointProfile" WHERE "userId" LIKE 't-pg%'`);
+    await pool.query(`DELETE FROM "DistributorEndpointCandidate" WHERE "userId" LIKE 't-pg%'`);
   });
 
   describe('outcome repository', () => {
     it('persists a finalized snapshot with releases and tracks', async () => {
       const repo = new DistroKidOutcomeRepository(pool);
       expect(repo.durable).toBe(true);
       await repo.persist(finalizeJob(), [completed('R1'), completed('R2')]);
 
-      const snap = await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "tenantId" = 't-pg'`);
+      const snap = await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`);
       expect(snap.rowCount).toBe(1);
       expect(snap.rows[0].status).toBe('COMPLETE');
       expect(snap.rows[0].engine).toBe('NETWORK_FIRST');
       expect(snap.rows[0].expectedTracksKnown).toBe(true);
       expect(snap.rows[0].finalizedAt).not.toBeNull();
 
       const outcomes = await pool.query(`SELECT * FROM "DistributorReleaseOutcome" ORDER BY "distributorReleaseId"`);
       expect(outcomes.rowCount).toBe(2);
@@ -154,17 +154,17 @@ describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
         },
       });
 
       await new DistroKidOutcomeRepository(pool).persist(job, outcomes);
 
       const snapshot = await pool.query(
         `SELECT "expectedReleases", "expectedTracksKnown", "expectedTracks", "extractedTracks"
            FROM "DistributorExtractionSnapshot"
-          WHERE "tenantId" = 't-pg' AND "snapshotId" = 'snap-large-1200'`,
+          WHERE "userId" = 't-pg' AND "snapshotId" = 'snap-large-1200'`,
       );
       expect(snapshot.rows[0]).toMatchObject({
         expectedReleases: releaseCount,
         expectedTracksKnown: true,
         expectedTracks: trackCount,
         extractedTracks: trackCount,
       });
 
@@ -172,33 +172,33 @@ describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
         `SELECT
            COUNT(DISTINCT release_outcome.id)::text AS releases,
            COUNT(track_outcome.id)::text AS tracks,
            COUNT(track_outcome.id) FILTER (WHERE btrim(track_outcome.title) = '')::text AS blank_titles,
            COUNT(track_outcome.id) FILTER (WHERE track_outcome."isrcStatus" = 'PRESENT')::text AS present_isrcs
          FROM "DistributorExtractionSnapshot" snapshot
          JOIN "DistributorReleaseOutcome" release_outcome ON release_outcome."extractionSnapshotId" = snapshot.id
          JOIN "DistributorTrackOutcome" track_outcome ON track_outcome."releaseOutcomeId" = release_outcome.id
-        WHERE snapshot."tenantId" = 't-pg' AND snapshot."snapshotId" = 'snap-large-1200'`,
+        WHERE snapshot."userId" = 't-pg' AND snapshot."snapshotId" = 'snap-large-1200'`,
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
-      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "tenantId" = 't-pg'`)).rowCount).toBe(1);
+      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`)).rowCount).toBe(1);
       expect((await pool.query(`SELECT * FROM "DistributorReleaseOutcome"`)).rowCount).toBe(2);
       expect((await pool.query(`SELECT * FROM "DistributorTrackOutcome"`)).rowCount).toBe(2);
     });
 
     it('PERSISTS FAILURES with a reason code, a failed release is a fact, not an omission', async () => {
       const repo = new DistroKidOutcomeRepository(pool);
       const failed: ReleaseExtractionOutcome = {
         kind: 'FAILED', distributorReleaseId: 'R-bad', reason: 'TIMEOUT',
@@ -234,17 +234,17 @@ describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
       expect(timeout.upcStatus).toBe('TIMEOUT');
     });
 
     it('is TRANSACTIONAL, a mid-write failure leaves no half-written snapshot', async () => {
       const repo = new DistroKidOutcomeRepository(pool);
       const poison = { kind: 'COMPLETED', release: null, source: 'NETWORK_JSON', elapsedMs: 1 } as unknown as ReleaseExtractionOutcome;
       await expect(repo.persist(finalizeJob(), [completed('R1'), poison])).rejects.toThrow();
       // A snapshot claiming COMPLETE over half a catalogue is worse than no snapshot.
-      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "tenantId" = 't-pg'`)).rowCount).toBe(0);
+      expect((await pool.query(`SELECT * FROM "DistributorExtractionSnapshot" WHERE "userId" = 't-pg'`)).rowCount).toBe(0);
       expect((await pool.query(`SELECT * FROM "DistributorReleaseOutcome"`)).rowCount).toBe(0);
     });
 
     it('DELETES stale tracks when an authoritative re-read returns fewer (10 → 9)', async () => {
       const repo = new DistroKidOutcomeRepository(pool);
       const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, isrc: field('QT6ED252196' + (i % 10)) }));
 
       await repo.persist(finalizeJob(), [completed('R1', { tracks: tracks(10) })]);
@@ -346,17 +346,17 @@ describe.skipIf(!DATABASE_URL)('durable persistence, real Postgres', () => {
       const got = await new PostgresEndpointRegistryStore(pool).get({ tenantId: 't-pg', distributor: 'DISTROKID' }, 'fp-abc');
       expect(got!.schemaKeys).toEqual(['isrc', 'upc', 'tracks']);
       expect(got!.schemaDriftCount).toBe(4);
       expect(got!.candidateScore).toBe(37);
       expect(got!.successfulCaptures).toBe(9);
       expect(got!.failedCaptures).toBe(2);
       // The score has its own column now, it is not just a re-read of validationCount.
       const raw = await pool.query<{ candidateScore: number; validationCount: number }>(
-        `SELECT "candidateScore", "validationCount" FROM "DistributorEndpointProfile" WHERE "tenantId" = 't-pg'`,
+        `SELECT "candidateScore", "validationCount" FROM "DistributorEndpointProfile" WHERE "userId" = 't-pg'`,
       );
       expect(raw.rows[0]!.candidateScore).toBe(37);
     });
 
     it('upserts on (tenant, distributor, fingerprint) so concurrent workers converge on one row', async () => {
       const store = new PostgresEndpointRegistryStore(pool);
       await store.put(profile({ status: 'CANDIDATE', successfulCaptures: 0 }));
       await store.put(profile({ status: 'VALIDATING', successfulCaptures: 1 }));
