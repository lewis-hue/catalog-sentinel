# Task 2 review package (4ee30c5..ab26ea1)

## Commits
ab26ea1 feat(db): scan_records keyed by user_id

## Stat
 .../src/history-pagination.integration.test.ts     |  13 +-
 packages/search-store/src/manual-review.test.ts    |   2 +-
 .../search-store/src/postgres-search-store.test.ts | 180 +++++++++------------
 packages/search-store/src/postgres-search-store.ts | 135 ++++------------
 packages/search-store/src/tiered-search-store.ts   |  59 +++----
 5 files changed, 129 insertions(+), 260 deletions(-)

## Diff (-U10)
diff --git a/packages/search-store/src/history-pagination.integration.test.ts b/packages/search-store/src/history-pagination.integration.test.ts
index 2a9168a..c7b7995 100644
--- a/packages/search-store/src/history-pagination.integration.test.ts
+++ b/packages/search-store/src/history-pagination.integration.test.ts
@@ -1,22 +1,21 @@
 import { randomUUID } from 'node:crypto';
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
 import { asPgPoolLike, createPgPool } from './pg-client';
 import { PostgresSearchStore } from './postgres-search-store';
 import { asRedisLike, createRedis } from './redis-client';
 import { RedisSearchStore, type CatalogResultLike, type SearchPageCursor, type SearchRecord } from './search-store';
 
 const enabled = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
 const describeInfrastructure = enabled ? describe : describe.skip;
 const suffix = randomUUID();
-const tenantId = `pagination-${suffix}`;
-const ownerUserId = `owner-${suffix}`;
+const userId = `owner-${suffix}`;
 const prefix = `sentinel:test:pagination:${suffix}`;
 const recordIds = Array.from({ length: 205 }, (_, index) => `search_infra_${suffix}_${String(index).padStart(3, '0')}`);
 
 const result: CatalogResultLike = {
   artist: 'History integration fixture',
   stores: [],
   profiles: [],
   tracks: [],
   summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
   generatedAt: '2026-07-22T00:00:00.000Z',
@@ -26,37 +25,35 @@ const result: CatalogResultLike = {
 
 let pgPool: ReturnType<typeof createPgPool>;
 let redis: ReturnType<typeof createRedis>;
 let postgresStore: PostgresSearchStore;
 let redisStore: RedisSearchStore;
 
 function record(id: string): SearchRecord {
   return {
     id,
     revision: 1,
-    tenantId,
-    ownerUserId,
-    artistWorkspaceId: `aw-${suffix}`,
+    userId,
     createdAt: '2026-07-22T12:00:00.000Z',
     artist: id,
     distributor: 'distrokid',
     platforms: [],
     song: null,
     result,
   };
 }
 
 async function collect(store: PostgresSearchStore | RedisSearchStore): Promise<string[]> {
   const ids: string[] = [];
   let after: SearchPageCursor | undefined;
   do {
-    const page = await store.pageForOwner(tenantId, ownerUserId, { limit: 29, ...(after ? { after } : {}) });
+    const page = await store.pageForUser(userId, { limit: 29, ...(after ? { after } : {}) });
     ids.push(...page.items.map((item) => item.id));
     after = page.nextCursor;
   } while (after);
   return ids;
 }
 
 describeInfrastructure('real Redis/Postgres search history pagination', () => {
   beforeAll(async () => {
     pgPool = createPgPool(process.env.DATABASE_URL!);
     redis = createRedis(process.env.REDIS_URL!);
@@ -65,22 +62,22 @@ describeInfrastructure('real Redis/Postgres search history pagination', () => {
     for (const id of recordIds) {
       const fixture = record(id);
       await postgresStore.put(fixture);
       await redisStore.put(fixture);
     }
   }, 60_000);
 
   afterAll(async () => {
     if (!enabled) return;
     for (const id of recordIds) {
-      await postgresStore.delete(id, tenantId, ownerUserId);
-      await redisStore.delete(id, tenantId, ownerUserId);
+      await postgresStore.delete(id, userId);
+      await redisStore.delete(id, userId);
     }
     redis.disconnect();
     await pgPool.end();
   }, 60_000);
 
   it('returns the same complete deterministic sequence from both backends beyond row 200', async () => {
     const postgresIds = await collect(postgresStore);
     const redisIds = await collect(redisStore);
     expect(postgresIds).toHaveLength(205);
     expect(new Set(postgresIds).size).toBe(205);
diff --git a/packages/search-store/src/manual-review.test.ts b/packages/search-store/src/manual-review.test.ts
index 1219463..dab6e39 100644
--- a/packages/search-store/src/manual-review.test.ts
+++ b/packages/search-store/src/manual-review.test.ts
@@ -7,21 +7,21 @@ function record(): SearchRecord {
     artist: 'Lewis KE', stores: ['Deezer', 'Audiomack', 'Apple Music / iTunes'], profiles: [],
     tracks: [
       { title: 'Icy Love', album: null, isrc: 'QZK6K2090500', artworkUrl: null, perStore: [
         { store: 'Deezer', status: 'live', foundArtist: null, url: 'd', confidence: 1, needsManualReview: false, reviewQuery: null },
         { store: 'Audiomack', status: 'unverifiable', foundArtist: null, url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Icy Love' },
         { store: 'Apple Music / iTunes', status: 'unverifiable', foundArtist: null, url: null, confidence: 0.3, needsManualReview: true, reviewQuery: 'Lewis KE Icy Love' },
       ] },
     ],
     summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 2 }, generatedAt: 'now', warnings: [], note: '',
   };
-  return { id: 'search_1', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
+  return { id: 'search_1', userId: 'user-1', createdAt: 'now', artist: 'Lewis KE', distributor: 'distrokid', platforms: [], song: null, result };
 }
 
 describe('manual-review', () => {
   it('encodes/decodes item ids incl. platform names with slashes', () => {
     const id = encodeItemId(0, 'Apple Music / iTunes');
     expect(decodeItemId(id)).toEqual({ trackIndex: 0, platform: 'Apple Music / iTunes' });
     expect(decodeItemId('not-valid!!')).toBeNull();
   });
 
   it('derives only the cells that need review (open by default)', () => {
diff --git a/packages/search-store/src/postgres-search-store.test.ts b/packages/search-store/src/postgres-search-store.test.ts
index f19485b..2929429 100644
--- a/packages/search-store/src/postgres-search-store.test.ts
+++ b/packages/search-store/src/postgres-search-store.test.ts
@@ -11,104 +11,85 @@ import {
 } from './search-store';
 
 /** Fake pg pool that emulates the scan_records table with a Map (matches JSONB → object). */
 class FakePg implements PgPoolLike {
   rows = new Map<string, SearchRecord>();
   queryTexts: string[] = [];
   schemaProbeCalls = 0;
   schemaRows: Array<Record<string, unknown>> = [
     ...[
       ['id', 'text', true],
-      ['tenant_id', 'text', true],
-      ['owner_user_id', 'text', false],
-      ['artist_workspace_id', 'text', false],
+      ['user_id', 'text', true],
       ['artist', 'text', true],
       ['distributor', 'text', true],
       ['deep_scan_status', 'text', false],
       ['created_at', 'timestamptz', true],
       ['updated_at', 'timestamptz', true],
       ['record', 'jsonb', true],
     ].map(([name, data_type, not_null]) => ({ kind: 'column', name, data_type, not_null, is_primary: false })),
     { kind: 'index', name: 'scan_records_pkey', data_type: null, not_null: false, is_primary: true, index_columns: ['id'], descending: [false] },
     { kind: 'index', name: 'scan_records_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['created_at'], descending: [true] },
-    { kind: 'index', name: 'scan_records_tenant_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['tenant_id', 'created_at'], descending: [false, true] },
-    { kind: 'index', name: 'scan_records_tenant_owner_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['tenant_id', 'owner_user_id', 'created_at'], descending: [false, false, true] },
-    { kind: 'index', name: 'scan_records_tenant_workspace_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['tenant_id', 'artist_workspace_id', 'created_at'], descending: [false, false, true] },
+    { kind: 'index', name: 'scan_records_user_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['user_id', 'created_at'], descending: [false, true] },
   ];
   beforeInsert?: (incoming: SearchRecord) => Promise<void>;
   async query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> {
     this.queryTexts.push(text);
     if (/\b(?:CREATE|ALTER|DROP)\b/i.test(text)) throw new Error('runtime DDL is forbidden');
     if (text.includes('FROM scan_records LIMIT 0')) { this.schemaProbeCalls++; return { rows: [] }; }
     if (text.includes('FROM pg_attribute')) { this.schemaProbeCalls++; return { rows: this.schemaRows }; }
     if (text.includes('INSERT INTO scan_records')) {
       const id = params[0] as string;
       const incoming = JSON.parse(params[6] as string) as SearchRecord;
       await this.beforeInsert?.(incoming);
       const existing = this.rows.get(id);
-      if (existing && (
-        existing.tenantId !== incoming.tenantId
-        || (existing.ownerUserId ?? null) !== (incoming.ownerUserId ?? null)
-        || (existing.artistWorkspaceId ?? null) !== (incoming.artistWorkspaceId ?? null)
-      )) return { rows: [], rowCount: 0 };
+      if (existing && existing.userId !== incoming.userId) return { rows: [], rowCount: 0 };
       if (existing && revisionOf(existing) >= revisionOf(incoming)) return { rows: [], rowCount: 0 };
       this.rows.set(id, incoming);
       return { rows: [{ id }], rowCount: 1 };
     }
     if (text.includes('UPDATE scan_records SET')) {
       const id = params[0] as string;
-      const tenantId = params[1] as string;
+      const userId = params[1] as string;
       const incoming = JSON.parse(params[5] as string) as SearchRecord;
       const expectedRevision = params[6] as number;
       const existing = this.rows.get(id);
-      if (!existing || existing.tenantId !== tenantId || revisionOf(existing) !== expectedRevision) {
+      if (!existing || existing.userId !== userId || revisionOf(existing) !== expectedRevision) {
         return { rows: [], rowCount: 0 };
       }
       this.rows.set(id, incoming);
       return { rows: [{ id }], rowCount: 1 };
     }
     if (text.includes('DELETE FROM scan_records')) {
       const id = params[0] as string;
       const existing = this.rows.get(id);
-      if (!existing
-        || (text.includes('tenant_id = $2') && existing.tenantId !== params[1])
-        || (text.includes('owner_user_id = $3') && existing.ownerUserId !== params[2])) {
+      if (!existing || (text.includes('user_id = $2') && existing.userId !== params[1])) {
         return { rows: [], rowCount: 0 };
       }
       this.rows.delete(id);
       return { rows: [{ id }], rowCount: 1 };
     }
-    if (text.includes('SELECT tenant_id, owner_user_id')) {
+    if (text.includes('SELECT user_id, record')) {
       const rec = this.rows.get(params[0] as string);
-      return { rows: rec ? [{
-        tenant_id: rec.tenantId ?? 'default',
-        owner_user_id: rec.ownerUserId ?? null,
-        artist_workspace_id: rec.artistWorkspaceId ?? null,
-        record: rec,
-      }] : [] };
+      return { rows: rec ? [{ user_id: rec.userId, record: rec }] : [] };
     }
-    if (text.includes('WHERE id =')) {
+    if (text.includes('SELECT record FROM scan_records WHERE id')) {
       const rec = this.rows.get(params[0] as string);
-      if (rec && text.includes('tenant_id = $2') && rec.tenantId !== params[1]) return { rows: [] };
       return { rows: rec ? [{ record: rec }] : [] };
     }
     if (text.includes('ORDER BY created_at')) {
       const records = [...this.rows.values()];
-      let filtered = text.includes('owner_user_id = $2')
-        ? records.filter((record) => record.tenantId === params[0] && record.ownerUserId === params[1])
-        : text.includes('WHERE tenant_id = $1')
-          ? records.filter((record) => record.tenantId === params[0])
-          : records;
+      let filtered = text.includes('WHERE user_id = $1')
+        ? records.filter((record) => record.userId === params[0])
+        : records;
       if (text.includes('(created_at, id) <')) {
-        const ownerScoped = text.includes('owner_user_id = $2');
-        const afterCreatedAt = params[ownerScoped ? 2 : 1] as string;
-        const afterId = params[ownerScoped ? 3 : 2] as string;
+        const afterCreatedAt = params[1] as string;
+        const afterId = params[2] as string;
         filtered = filtered.filter((record) =>
           record.createdAt < afterCreatedAt || (record.createdAt === afterCreatedAt && record.id < afterId));
       }
       filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
       const boundLimit = /LIMIT \$\d+/.test(text) ? Number(params[params.length - 1]) : 200;
       return { rows: filtered.slice(0, boundLimit).map((r) => ({ record: r })) };
     }
     return { rows: [] };
   }
 }
@@ -163,236 +144,223 @@ const result = (): CatalogResultLike => ({
   tracks: [{ title: 'Icy Love', album: null, isrc: 'QZK6K2090500', artworkUrl: null, perStore: [{ store: 'Deezer', status: 'live', foundArtist: null, url: null, confidence: 1, needsManualReview: false, reviewQuery: null }] }],
   summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: 'now', warnings: [], note: '',
 });
 
 describe('PostgresSearchStore', () => {
   it('validates the migrated schema once, never runs DDL, and round-trips a record', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
     expect(pg.queryTexts).toHaveLength(0); // construction has no database side effects
     const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
-    expect(saved.tenantId).toBe('default');
+    expect(saved.userId).toBe('');
     const got = await store.get(saved.id);
     expect(got?.artist).toBe('Lewis KE');
     expect((await store.list())[0]?.id).toBe(saved.id);
     expect(pg.schemaProbeCalls).toBe(2);
     expect(pg.queryTexts.every((text) => !/\b(?:CREATE|ALTER|DROP)\b/i.test(text))).toBe(true);
   });
 
   it('fails before DML when a required migrated column or index is absent', async () => {
     const missingIndex = new FakePg();
-    missingIndex.schemaRows = missingIndex.schemaRows.filter((row) => row.name !== 'scan_records_tenant_created_idx');
+    missingIndex.schemaRows = missingIndex.schemaRows.filter((row) => row.name !== 'scan_records_user_created_idx');
     const store = new PostgresSearchStore(missingIndex);
 
     await expect(store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result()))
-      .rejects.toThrow(/schema is incomplete.*scan_records_tenant_created_idx/i);
+      .rejects.toThrow(/schema is incomplete.*scan_records_user_created_idx/i);
     expect(missingIndex.queryTexts.some((text) => text.includes('INSERT INTO'))).toBe(false);
   });
 
   it('update reads-modifies-writes the durable row', async () => {
     const store = new PostgresSearchStore(new FakePg());
     const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
     await store.update(saved.id, (r) => ({ ...r, deepScan: { status: 'done', platformsDone: ['Spotify'], platformsPending: [] } }));
     expect((await store.get(saved.id))?.deepScan?.status).toBe('done');
   });
 
-  it('deletes a record durably and removes it from tenant history', async () => {
+  it('deletes a record durably and removes it from user history', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
     expect(await store.delete(saved.id)).toBe(true);
     expect(await store.delete(saved.id)).toBe(false);
     expect(await store.get(saved.id)).toBeNull();
-    expect(await store.listForTenant('tenant-a')).toEqual([]);
+    expect(await store.listForUser('user-a')).toEqual([]);
   });
 
-  it('persists each record under its actual tenant in an application-wide store', async () => {
+  it('persists each record under its actual user in an application-wide store', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Private Artist', distributor: 'distrokid' }, result());
-    expect(saved.tenantId).toBe('tenant-a');
-    expect(pg.rows.get(saved.id)?.tenantId).toBe('tenant-a');
-    expect((await store.get(saved.id))?.tenantId).toBe('tenant-a');
+    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
+    expect(saved.userId).toBe('user-a');
+    expect(pg.rows.get(saved.id)?.userId).toBe('user-a');
+    expect((await store.get(saved.id))?.userId).toBe('user-a');
   });
 
-  it('lists at the SQL tenant boundary instead of filtering a global capped page', async () => {
+  it('lists at the SQL user boundary instead of filtering a global capped page, and excludes unowned legacy rows', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    await store.save({ tenantId: 'tenant-a', artist: 'A', distributor: 'distrokid' }, result());
-    await store.save({ tenantId: 'tenant-b', artist: 'B', distributor: 'distrokid' }, result());
-    expect((await store.listForTenant('tenant-a')).map((item) => item.artist)).toEqual(['A']);
-    expect((await store.listForTenant('tenant-b')).map((item) => item.artist)).toEqual(['B']);
-  });
-
-  it('lists at the SQL tenant-and-owner boundary and excludes ownerless legacy rows', async () => {
-    const pg = new FakePg();
-    const store = new PostgresSearchStore(pg);
-    await store.save({ tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-a', artist: 'Alice', distributor: 'distrokid' }, result());
-    await store.save({ tenantId: 'tenant-a', ownerUserId: 'bob', artistWorkspaceId: 'aw-b', artist: 'Bob', distributor: 'distrokid' }, result());
-    await store.save({ tenantId: 'tenant-a', artist: 'Legacy', distributor: 'distrokid' }, result());
+    await store.save({ artist: 'Alice', distributor: 'distrokid' }, result(), undefined, { userId: 'alice' });
+    await store.save({ artist: 'Bob', distributor: 'distrokid' }, result(), undefined, { userId: 'bob' });
+    await store.save({ artist: 'Legacy', distributor: 'distrokid' }, result()); // no owner: userId ''
 
-    expect((await store.listForOwner('tenant-a', 'alice')).map((item) => item.artist)).toEqual(['Alice']);
-    expect(pg.queryTexts.some((text) => text.includes('owner_user_id = $2'))).toBe(true);
+    expect((await store.listForUser('alice')).map((item) => item.artist)).toEqual(['Alice']);
+    expect((await store.listForUser('bob')).map((item) => item.artist)).toEqual(['Bob']);
+    expect(pg.queryTexts.some((text) => text.includes('user_id = $1'))).toBe(true);
   });
 
-  it('seek-paginates more than 200 owner rows with deterministic id ordering for equal timestamps', async () => {
+  it('seek-paginates more than 200 user rows with deterministic id ordering for equal timestamps', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
     const seed = await store.save({
-      tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-a',
       artist: 'Seed', distributor: 'distrokid',
-    }, result());
-    await store.delete(seed.id, 'tenant-a', 'alice');
+    }, result(), undefined, { userId: 'alice' });
+    await store.delete(seed.id, 'alice');
     const createdAt = '2026-07-22T12:00:00.000Z';
     for (let index = 0; index < 225; index++) {
       await store.put({ ...seed, id: `search_${String(index).padStart(3, '0')}`, createdAt, artist: `Artist ${index}` });
     }
 
     const ids: string[] = [];
     let after: { createdAt: string; id: string } | undefined;
     do {
-      const page = await store.pageForOwner('tenant-a', 'alice', { limit: 37, ...(after ? { after } : {}) });
+      const page = await store.pageForUser('alice', { limit: 37, ...(after ? { after } : {}) });
       ids.push(...page.items.map((item) => item.id));
       after = page.nextCursor;
     } while (after);
 
     expect(ids).toHaveLength(225);
     expect(new Set(ids).size).toBe(225);
     expect(ids[0]).toBe('search_224');
     expect(ids.at(-1)).toBe('search_000');
     expect(pg.queryTexts.some((text) => text.includes('ORDER BY created_at DESC, id DESC'))).toBe(true);
   });
 
-  it('rejects a record id collision across tenants without overwriting the owner', async () => {
+  it('rejects a record id collision across users without overwriting the owner', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    const original = await store.save({ tenantId: 'tenant-a', artist: 'Private Artist', distributor: 'distrokid' }, result());
+    const original = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
-    await expect(store.put({ ...original, tenantId: 'tenant-b', artist: 'Attacker Rewrite' })).rejects.toThrow(
-      'already owned by another tenant',
+    await expect(store.put({ ...original, userId: 'user-b', artist: 'Attacker Rewrite' })).rejects.toThrow(
+      'scan record is owned by another user',
     );
-    expect(pg.rows.get(original.id)?.tenantId).toBe('tenant-a');
+    expect(pg.rows.get(original.id)?.userId).toBe('user-a');
     expect(pg.rows.get(original.id)?.artist).toBe('Private Artist');
   });
 
-  it('rejects full-record ownership or workspace rewrites at the durable boundary', async () => {
+  it('rejects a full-record ownership rewrite at the durable boundary', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
     const original = await store.save({
-      tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-alice',
       artist: 'Private Artist', distributor: 'distrokid',
-    }, result());
+    }, result(), undefined, { userId: 'alice' });
 
-    await expect(store.put({ ...original, revision: 2, ownerUserId: 'bob' })).rejects.toThrow('another user');
-    await expect(store.put({ ...original, revision: 2, artistWorkspaceId: 'aw-other' })).rejects.toThrow('another artist workspace');
-    expect(pg.rows.get(original.id)).toMatchObject({ ownerUserId: 'alice', artistWorkspaceId: 'aw-alice' });
+    await expect(store.put({ ...original, revision: 2, userId: 'bob' })).rejects.toThrow('scan record is owned by another user');
+    expect(pg.rows.get(original.id)).toMatchObject({ userId: 'alice' });
   });
 
   it('accepts an idempotent same-revision projection independent of JSON object key order', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Private Artist', distributor: 'distrokid' }, result());
+    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'alice' });
     const reordered: SearchRecord = {
       result: saved.result,
       song: saved.song,
       platforms: saved.platforms,
       distributor: saved.distributor,
       artist: saved.artist,
       createdAt: saved.createdAt,
-      tenantId: saved.tenantId,
+      userId: saved.userId,
       revision: saved.revision,
       id: saved.id,
     };
     await expect(store.upsert(reordered)).resolves.toBeUndefined();
     expect(pg.rows.get(saved.id)?.artist).toBe('Private Artist');
   });
 
   it('never promotes stale full-record puts over newer durable state', async () => {
     const pg = new FakePg();
     const store = new PostgresSearchStore(pg);
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Private Artist', distributor: 'distrokid' }, result());
+    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result());
     const newer: SearchRecord = { ...saved, revision: 3, result: { ...saved.result, note: 'newer' } };
     await store.put(newer);
     await store.put({ ...saved, revision: 2, result: { ...saved.result, note: 'stale' } });
 
     expect((await store.get(saved.id))?.revision).toBe(3);
     expect((await store.get(saved.id))?.result.note).toBe('newer');
     await expect(store.put({ ...newer, result: { ...newer.result, note: 'equal-version-conflict' } }))
       .rejects.toThrow('conflicting search record revision');
   });
 });
 
 describe('revision-aware hot store', () => {
-  it('ignores stale cache refreshes and rejects equal-revision conflicts across tenants or data', async () => {
+  it('ignores stale cache refreshes and rejects equal-revision conflicts across users or data', async () => {
     const store = new RedisSearchStore(new FakeRedis());
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
     const updated = await store.update(saved.id, (record) => ({
       ...record,
       result: { ...record.result, note: 'new authoritative state' },
     }));
     expect(updated?.revision).toBe(2);
 
     await store.put(saved); // delayed revision 1 cache refresh
     expect((await store.get(saved.id))?.result.note).toBe('new authoritative state');
     await expect(store.put({ ...updated!, artist: 'same revision, different data' })).rejects.toThrow('conflicting');
-    await expect(store.put({ ...updated!, revision: 3, tenantId: 'tenant-b' })).rejects.toThrow('another tenant');
+    await expect(store.put({ ...updated!, revision: 3, userId: 'user-b' })).rejects.toThrow('another user');
   });
 
-  it('atomically removes Redis values plus global and tenant index entries', async () => {
+  it('atomically removes Redis values plus global and user index entries', async () => {
     const redis = new FakeRedis();
     const store = new RedisSearchStore(redis);
-    const saved = await store.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
     expect(await store.delete(saved.id)).toBe(true);
     expect(await store.get(saved.id)).toBeNull();
     expect(await store.list()).toEqual([]);
-    expect(await store.listForTenant('tenant-a')).toEqual([]);
+    expect(await store.listForUser('user-a')).toEqual([]);
     expect(redis.lists.get('search:index')).not.toContain(saved.id);
-    expect(redis.lists.get('search:tenant:tenant-a:index')).not.toContain(saved.id);
+    expect(redis.lists.get('search:user:user-a:index')).not.toContain(saved.id);
 
-    const partiallyRemoved = await store.save({ tenantId: 'tenant-a', artist: 'Second', distributor: 'distrokid' }, result());
+    const partiallyRemoved = await store.save({ artist: 'Second', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
     redis.values.delete(`search:${partiallyRemoved.id}`);
-    expect(await store.delete(partiallyRemoved.id, 'tenant-a')).toBe(false);
+    expect(await store.delete(partiallyRemoved.id, 'user-a')).toBe(false);
     expect(redis.lists.get('search:index')).not.toContain(partiallyRemoved.id);
-    expect(redis.lists.get('search:tenant:tenant-a:index')).not.toContain(partiallyRemoved.id);
+    expect(redis.lists.get('search:user:user-a:index')).not.toContain(partiallyRemoved.id);
   });
 
-  it('uses a dedicated owner index so 205 peer records cannot starve another owner', async () => {
+  it('uses a dedicated user index so 205 peer records cannot starve another owner', async () => {
     const redis = new FakeRedis();
     const store = new RedisSearchStore(redis);
     const bob = await store.save({
-      tenantId: 'tenant-a', ownerUserId: 'bob', artistWorkspaceId: 'aw-bob',
       artist: 'Bob', distributor: 'distrokid',
-    }, result());
+    }, result(), undefined, { userId: 'bob' });
     for (let i = 0; i < 205; i++) {
       await store.save({
-        tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-alice',
         artist: `Alice ${i}`, distributor: 'distrokid',
-      }, result());
+      }, result(), undefined, { userId: 'alice' });
     }
 
-    expect((await store.listForOwner('tenant-a', 'bob')).map((item) => item.id)).toEqual([bob.id]);
-    expect(await store.listForOwner('tenant-a', 'alice')).toHaveLength(200);
-    const aliceIndex = redis.lists.get('search:tenant:tenant-a:owner:alice:index')!;
+    expect((await store.listForUser('bob')).map((item) => item.id)).toEqual([bob.id]);
+    expect(await store.listForUser('alice')).toHaveLength(200);
+    const aliceIndex = redis.lists.get('search:user:alice:index')!;
     aliceIndex.unshift(aliceIndex[0]!); // tolerate a stale duplicate left by a retried index write
     const pagedIds: string[] = [];
     let after: { createdAt: string; id: string } | undefined;
     do {
-      const page = await store.pageForOwner('tenant-a', 'alice', { limit: 41, ...(after ? { after } : {}) });
+      const page = await store.pageForUser('alice', { limit: 41, ...(after ? { after } : {}) });
       pagedIds.push(...page.items.map((item) => item.id));
       after = page.nextCursor;
     } while (after);
     expect(pagedIds).toHaveLength(205);
     expect(new Set(pagedIds).size).toBe(205);
-    await store.delete(bob.id, 'tenant-a', 'bob');
-    expect(redis.lists.get('search:tenant:tenant-a:owner:bob:index')).not.toContain(bob.id);
+    await store.delete(bob.id, 'bob');
+    expect(redis.lists.get('search:user:bob:index')).not.toContain(bob.id);
   });
 });
 
 describe('TieredSearchStore', () => {
   it('mirrors saves to the durable tier and recovers on a Redis flush', async () => {
     const hot = new InMemorySearchStore();
     const pg = new FakePg();
     const durable = new PostgresSearchStore(pg);
     const tiered = new TieredSearchStore(hot, durable);
 
@@ -405,26 +373,26 @@ describe('TieredSearchStore', () => {
     const got = await recovered.get(saved.id);
     expect(got?.id).toBe(saved.id); // recovered from Postgres
     expect(await flushed.get(saved.id)).not.toBeNull(); // and re-warmed into hot
   });
 
   it('deletes from both durable and hot tiers so history cannot resurrect', async () => {
     const hot = new InMemorySearchStore();
     const pg = new FakePg();
     const durable = new PostgresSearchStore(pg);
     const tiered = new TieredSearchStore(hot, durable);
-    const saved = await tiered.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
     expect(await tiered.delete(saved.id)).toBe(true);
     expect(await hot.get(saved.id)).toBeNull();
     expect(await durable.get(saved.id)).toBeNull();
-    expect(await tiered.listForTenant('tenant-a')).toEqual([]);
+    expect(await tiered.listForUser('user-a')).toEqual([]);
   });
 
   it('durably projects every mutation, including metadata-only changes', async () => {
     const hot = new InMemorySearchStore();
     const pg = new FakePg();
     const tiered = new TieredSearchStore(hot, new PostgresSearchStore(pg));
     const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
     let writes = 0;
     const realQuery = pg.query.bind(pg);
     pg.query = async (t, p) => { if (t.includes('UPDATE scan_records SET')) writes++; return realQuery(t, p); };
@@ -452,72 +420,72 @@ describe('TieredSearchStore', () => {
       reviewDecision: 'DISMISSED',
       reviewedBy: 'reviewer-1',
       reviewNotes: 'verified against the artist dashboard',
     });
   });
 
   it('does not let a stale cache projection roll Postgres backward', async () => {
     const hot = new InMemorySearchStore();
     const pg = new FakePg();
     const tiered = new TieredSearchStore(hot, new PostgresSearchStore(pg));
-    const saved = await tiered.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
     const staleProjection = {
       ...saved,
       result: { ...saved.result, note: 'stale-cache-value' },
     };
     const newer = await tiered.update(saved.id, (record) => ({
       ...record,
       deepScan: { status: 'running', platformsDone: [], platformsPending: ['Spotify'] },
     }));
     await tiered.put(staleProjection);
 
     const durable = pg.rows.get(saved.id);
     expect(durable?.revision).toBe(2);
     expect(durable?.result.note).toBe('');
     expect(durable?.deepScan?.status).toBe('running');
-    expect(durable?.tenantId).toBe('tenant-a');
+    expect(durable?.userId).toBe('user-a');
     expect((await hot.get(saved.id))?.revision).toBe(newer?.revision);
   });
 
   it('serializes concurrent production mutations against Postgres and replays losers', async () => {
     const hot = new InMemorySearchStore();
     const pg = new FakePg();
     const durable = new PostgresSearchStore(pg);
     const tiered = new TieredSearchStore(hot, durable);
-    const saved = await tiered.save({ tenantId: 'tenant-a', artist: 'Lewis KE', distributor: 'distrokid' }, result());
+    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
 
     await Promise.all([
       tiered.update(saved.id, (record) => ({ ...record, result: { ...record.result, note: 'human-reviewed' } })),
       tiered.update(saved.id, (record) => ({
         ...record,
         deepScan: { status: 'running', platformsDone: [], platformsPending: ['Spotify'] },
       })),
     ]);
 
     const authoritative = await durable.get(saved.id);
     expect(authoritative?.revision).toBe(3);
     expect(authoritative?.result.note).toBe('human-reviewed');
     expect(authoritative?.deepScan?.status).toBe('running');
     expect((await hot.get(saved.id))?.revision).toBe(3);
   });
 
   it('fails closed in production instead of serving a stale hot record when Postgres is down', async () => {
     const hot = new InMemorySearchStore();
-    const cached = await hot.save({ tenantId: 'tenant-a', artist: 'Cached Artist', distributor: 'distrokid' }, result());
+    const cached = await hot.save({ artist: 'Cached Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
     const brokenPg: PgPoolLike = {
       query: async () => { throw new Error('pg down'); },
     };
     const tiered = new TieredSearchStore(hot, new PostgresSearchStore(brokenPg));
 
     await expect(tiered.get(cached.id)).rejects.toThrow('pg down');
-    await expect(tiered.listForTenant('tenant-a')).rejects.toThrow('durable search store unavailable');
+    await expect(tiered.listForUser('user-a')).rejects.toThrow('durable search store unavailable');
   });
 
   it('never acknowledges a write when the durable tier throws', async () => {
     const hot = new InMemorySearchStore();
     const brokenPg: PgPoolLike = { query: async () => { throw new Error('pg down'); } };
     const tiered = new TieredSearchStore(hot, new PostgresSearchStore(brokenPg));
     await expect(
       tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result()),
     ).rejects.toThrow('pg down');
     expect(await hot.list()).toEqual([]);
diff --git a/packages/search-store/src/postgres-search-store.ts b/packages/search-store/src/postgres-search-store.ts
index 02bdcc1..d4c5af5 100644
--- a/packages/search-store/src/postgres-search-store.ts
+++ b/packages/search-store/src/postgres-search-store.ts
@@ -2,66 +2,62 @@ import { id } from '@sentinel/core';
 import type {
   CatalogResultLike,
   ReleasedTrackLike,
   SearchInput,
   SearchPage,
   SearchPageOptions,
   SearchRecord,
   SearchStore,
   SearchSummary,
 } from './search-store';
-import { applySearchMutation, DEFAULT_TENANT, ownerOf, revisionOf, searchRecordsEqual, toSummary, validateSearchPageOptions } from './search-store';
+import { applySearchMutation, revisionOf, searchRecordsEqual, toSummary, validateSearchPageOptions } from './search-store';
 
 /**
  * Durable Postgres store for scan records, the SOURCE OF TRUTH for final results.
  * Uses the canonical DATABASE_URL via node-postgres. Schema creation belongs exclusively to
  * the committed Prisma migration chain; the application runtime performs reads and DML only.
  * The record is stored as JSONB; a few columns are denormalized for listing/filtering.
  *
  * Writes are COARSE (per platform checkpoint / terminal state), never per search query -
  * the deep-scan job calls `update` ~once per platform, so Postgres sees ~N-platform writes
  * per scan, not thousands.
  */
 export interface PgPoolLike {
   query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
   end?(): Promise<void>;
 }
 
 const REQUIRED_COLUMNS = new Map<string, { type: string; notNull: boolean }>([
   ['id', { type: 'text', notNull: true }],
-  ['tenant_id', { type: 'text', notNull: true }],
-  ['owner_user_id', { type: 'text', notNull: false }],
-  ['artist_workspace_id', { type: 'text', notNull: false }],
+  ['user_id', { type: 'text', notNull: true }],
   ['artist', { type: 'text', notNull: true }],
   ['distributor', { type: 'text', notNull: true }],
   ['deep_scan_status', { type: 'text', notNull: false }],
   ['created_at', { type: 'timestamptz', notNull: true }],
   ['updated_at', { type: 'timestamptz', notNull: true }],
   ['record', { type: 'jsonb', notNull: true }],
 ]);
 
 const REQUIRED_INDEXES = new Map<string, { primary: boolean; columns: string[]; descending: boolean[] }>([
   ['scan_records_pkey', { primary: true, columns: ['id'], descending: [false] }],
   ['scan_records_created_idx', { primary: false, columns: ['created_at'], descending: [true] }],
-  ['scan_records_tenant_created_idx', { primary: false, columns: ['tenant_id', 'created_at'], descending: [false, true] }],
-  ['scan_records_tenant_owner_created_idx', { primary: false, columns: ['tenant_id', 'owner_user_id', 'created_at'], descending: [false, false, true] }],
-  ['scan_records_tenant_workspace_created_idx', { primary: false, columns: ['tenant_id', 'artist_workspace_id', 'created_at'], descending: [false, false, true] }],
+  ['scan_records_user_created_idx', { primary: false, columns: ['user_id', 'created_at'], descending: [false, true] }],
 ]);
 
 /**
  * Validate the exact migrated table contract without mutating schema. The zero-row SELECT also
  * proves the runtime role can read every column used by the store; pg_catalog verifies types,
  * nullability, the conflict-target primary key, and required listing indexes.
  */
 export async function assertScanRecordsSchema(pool: PgPoolLike): Promise<void> {
   await pool.query(
-    `SELECT id, tenant_id, owner_user_id, artist_workspace_id, artist, distributor,
+    `SELECT id, user_id, artist, distributor,
             deep_scan_status, created_at, updated_at, record
      FROM scan_records LIMIT 0`,
   );
   const { rows } = await pool.query(
     `SELECT 'column' AS kind, attribute.attname AS name, type.typname AS data_type,
             attribute.attnotnull AS not_null, false AS is_primary,
             NULL::text[] AS index_columns, NULL::boolean[] AS descending
        FROM pg_attribute attribute
        JOIN pg_type type ON type.oid = attribute.atttypid
       WHERE attribute.attrelid = to_regclass('scan_records')
@@ -94,232 +90,159 @@ export async function assertScanRecordsSchema(pool: PgPoolLike): Promise<void> {
       JSON.stringify(actual.descending) !== JSON.stringify(expected.descending)
     ) {
       missing.push(`${expected.primary ? 'primary key' : 'index'} ${name}`);
     }
   }
   if (missing.length) throw new Error(`scan_records schema is incomplete: missing or incompatible ${missing.join(', ')}`);
 }
 
 export class PostgresSearchStore implements SearchStore {
   private schemaReady: Promise<void> | null = null;
-  constructor(
-    private readonly pool: PgPoolLike,
-    /** Optional compatibility scope. Application-wide stores leave this undefined and persist
-     * each record's owner; deliberately scoped stores remain available for isolated callers. */
-    private readonly tenantId?: string,
-  ) {}
+  constructor(private readonly pool: PgPoolLike) {}
 
   /** Assert that the migration-owned table contract is present (cached per store instance). */
   async init(): Promise<void> {
     this.schemaReady ??= assertScanRecordsSchema(this.pool);
     await this.schemaReady;
   }
 
-  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
-    const tenantId = this.tenantId ?? input.tenantId ?? DEFAULT_TENANT;
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
     const rec: SearchRecord = {
       id: id('search'),
       revision: 1,
-      tenantId,
-      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
-      ...(input.artistWorkspaceId ? { artistWorkspaceId: input.artistWorkspaceId } : {}),
+      userId: owner?.userId ?? '',
       ...(input.name ? { name: input.name } : {}),
       ...(input.sourceSearchId ? { sourceSearchId: input.sourceSearchId } : {}),
       createdAt: new Date().toISOString(),
       artist: input.artist,
       distributor: input.distributor,
       platforms: input.platforms ?? [],
       song: input.song ?? null,
       result,
       ...(released ? { released } : {}),
     };
     await this.upsert(rec);
     return rec;
   }
 
   /** Persist a full record (used by the tiered store to mirror hot state durably). */
   async upsert(rec: SearchRecord): Promise<void> {
     await this.init();
-    if (this.tenantId && ownerOf(rec) !== this.tenantId) {
-      throw new Error('scan record cannot be written outside the scoped tenant');
-    }
-    const tenantId = this.tenantId ?? ownerOf(rec);
-    const owned = { ...rec, tenantId, revision: Math.max(1, revisionOf(rec)) };
+    const owned = { ...rec, revision: Math.max(1, revisionOf(rec)) };
     const { rows, rowCount } = await this.pool.query(
       `INSERT INTO scan_records (
-         id, tenant_id, artist, distributor, deep_scan_status, created_at, updated_at, record,
-         owner_user_id, artist_workspace_id
+         id, user_id, artist, distributor, deep_scan_status, created_at, updated_at, record
        )
-       VALUES ($1,$2,$3,$4,$5,$6, now(), $7,$8,$9)
+       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
        ON CONFLICT (id) DO UPDATE SET
          artist = EXCLUDED.artist, distributor = EXCLUDED.distributor,
          deep_scan_status = EXCLUDED.deep_scan_status, updated_at = now(), record = EXCLUDED.record
-       WHERE scan_records.tenant_id = EXCLUDED.tenant_id
-         AND scan_records.owner_user_id IS NOT DISTINCT FROM EXCLUDED.owner_user_id
-         AND scan_records.artist_workspace_id IS NOT DISTINCT FROM EXCLUDED.artist_workspace_id
-         AND COALESCE((scan_records.record->>'revision')::bigint, 0) < $10
+       WHERE scan_records.user_id = EXCLUDED.user_id
+         AND COALESCE((scan_records.record->>'revision')::bigint, 0) < $8
        RETURNING id`,
       [
         owned.id,
-        tenantId,
+        owned.userId,
         owned.artist,
         owned.distributor,
         owned.deepScan?.status ?? null,
         owned.createdAt,
         JSON.stringify(owned),
-        owned.ownerUserId ?? null,
-        owned.artistWorkspaceId ?? null,
         owned.revision,
       ],
     );
     if (rowCount !== 0 && !(rowCount == null && rows.length === 0)) return;
 
-    // A zero-row conflict is either stale/idempotent replication or a cross-tenant overwrite.
+    // A zero-row conflict is either stale/idempotent replication or a cross-user overwrite.
     const existingResult = await this.pool.query(
-      `SELECT tenant_id, owner_user_id, artist_workspace_id, record FROM scan_records WHERE id = $1`,
+      `SELECT user_id, record FROM scan_records WHERE id = $1`,
       [owned.id],
     );
     const existing = existingResult.rows[0];
     if (!existing) throw new Error('scan record durable upsert did not converge');
-    if (existing.tenant_id !== tenantId) throw new Error('scan record id is already owned by another tenant');
-    if ((existing.owner_user_id ?? null) !== (owned.ownerUserId ?? null)) {
-      throw new Error('scan record id is already owned by another user');
-    }
-    if ((existing.artist_workspace_id ?? null) !== (owned.artistWorkspaceId ?? null)) {
-      throw new Error('scan record id is already scoped to another artist workspace');
-    }
+    if (existing.user_id !== owned.userId) throw new Error('scan record is owned by another user');
     const persisted = existing.record as SearchRecord;
     if (revisionOf(persisted) > owned.revision) return;
     if (revisionOf(persisted) === owned.revision && searchRecordsEqual(persisted, owned)) return;
     throw new Error('conflicting search record revision');
   }
 
   async get(recordId: string): Promise<SearchRecord | null> {
     await this.init();
-    const { rows } = this.tenantId
-      ? await this.pool.query(`SELECT record FROM scan_records WHERE id = $1 AND tenant_id = $2`, [recordId, this.tenantId])
-      : await this.pool.query(`SELECT record FROM scan_records WHERE id = $1`, [recordId]);
+    const { rows } = await this.pool.query(`SELECT record FROM scan_records WHERE id = $1`, [recordId]);
     return rows[0] ? (rows[0].record as SearchRecord) : null;
   }
 
   async list(): Promise<SearchSummary[]> {
     await this.init();
-    const { rows } = this.tenantId
-      ? await this.pool.query(`SELECT record FROM scan_records WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [this.tenantId])
-      : await this.pool.query(`SELECT record FROM scan_records ORDER BY created_at DESC, id DESC LIMIT 200`);
+    const { rows } = await this.pool.query(`SELECT record FROM scan_records ORDER BY created_at DESC, id DESC LIMIT 200`);
     return rows.map((r) => toSummary(r.record as SearchRecord));
   }
 
-  async listForTenant(tenantId: string): Promise<SearchSummary[]> {
+  async listForUser(userId: string): Promise<SearchSummary[]> {
     await this.init();
-    // A deliberately scoped instance cannot be used to enumerate a different tenant.
-    if (this.tenantId && this.tenantId !== tenantId) return [];
     const { rows } = await this.pool.query(
-      `SELECT record FROM scan_records WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
-      [tenantId],
+      `SELECT record FROM scan_records WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
+      [userId],
     );
     return rows.map((r) => toSummary(r.record as SearchRecord));
   }
 
-  async listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]> {
-    await this.init();
-    if (this.tenantId && this.tenantId !== tenantId) return [];
-    const { rows } = await this.pool.query(
-      `SELECT record FROM scan_records
-        WHERE tenant_id = $1 AND owner_user_id = $2
-        ORDER BY created_at DESC, id DESC LIMIT 200`,
-      [tenantId, ownerUserId],
-    );
-    return rows.map((r) => toSummary(r.record as SearchRecord));
-  }
-
-  async pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage> {
+  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
     validateSearchPageOptions(options);
     await this.init();
-    if (this.tenantId && this.tenantId !== tenantId) return { items: [] };
-    const params: unknown[] = [tenantId];
+    const params: unknown[] = [userId];
     const after = options.after
       ? ` AND (created_at, id) < ($2::timestamptz, $3::text)`
       : '';
     if (options.after) params.push(options.after.createdAt, options.after.id);
     params.push(options.limit + 1);
     const limitParameter = `$${params.length}`;
     const { rows } = await this.pool.query(
       `SELECT record FROM scan_records
-        WHERE tenant_id = $1${after}
-        ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}`,
-      params,
-    );
-    return searchPageFromRows(rows, options.limit);
-  }
-
-  async pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage> {
-    validateSearchPageOptions(options);
-    await this.init();
-    if (this.tenantId && this.tenantId !== tenantId) return { items: [] };
-    const params: unknown[] = [tenantId, ownerUserId];
-    const after = options.after
-      ? ` AND (created_at, id) < ($3::timestamptz, $4::text)`
-      : '';
-    if (options.after) params.push(options.after.createdAt, options.after.id);
-    params.push(options.limit + 1);
-    const limitParameter = `$${params.length}`;
-    const { rows } = await this.pool.query(
-      `SELECT record FROM scan_records
-        WHERE tenant_id = $1 AND owner_user_id = $2${after}
+        WHERE user_id = $1${after}
         ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}`,
       params,
     );
     return searchPageFromRows(rows, options.limit);
   }
 
   async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     await this.init();
     for (let attempt = 0; attempt < 8; attempt++) {
       const cur = await this.get(recordId);
       if (!cur) return null;
       const next = applySearchMutation(cur, mutate);
-      const tenantId = this.tenantId ?? ownerOf(cur);
       const { rows, rowCount } = await this.pool.query(
         `UPDATE scan_records SET
            artist = $3, distributor = $4, deep_scan_status = $5,
            updated_at = now(), record = $6
-         WHERE id = $1 AND tenant_id = $2
+         WHERE id = $1 AND user_id = $2
            AND COALESCE((record->>'revision')::bigint, 0) = $7
          RETURNING id`,
-        [recordId, tenantId, next.artist, next.distributor, next.deepScan?.status ?? null, JSON.stringify(next), revisionOf(cur)],
+        [recordId, cur.userId, next.artist, next.distributor, next.deepScan?.status ?? null, JSON.stringify(next), revisionOf(cur)],
       );
       if (rowCount !== 0 && !(rowCount == null && rows.length === 0)) return next;
     }
     throw new Error('search record changed repeatedly during durable update');
   }
 
   async put(rec: SearchRecord): Promise<void> {
     // Full-record replication must preserve the caller's concurrency token. Re-reading and then
     // routing through `update` would incorrectly stamp stale content with a newer revision.
     await this.upsert(rec);
   }
 
-  async delete(recordId: string, tenantId?: string, ownerUserId?: string): Promise<boolean> {
+  async delete(recordId: string, userId?: string): Promise<boolean> {
     await this.init();
-    if (this.tenantId && tenantId && this.tenantId !== tenantId) return false;
-    const ownerScope = this.tenantId ?? tenantId;
-    const result = ownerScope && ownerUserId
-      ? await this.pool.query(
-          `DELETE FROM scan_records WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3 RETURNING id`,
-          [recordId, ownerScope, ownerUserId],
-        )
-      : ownerScope
-      ? await this.pool.query(
-          `DELETE FROM scan_records WHERE id = $1 AND tenant_id = $2 RETURNING id`,
-          [recordId, ownerScope],
-        )
+    const result = userId
+      ? await this.pool.query(`DELETE FROM scan_records WHERE id = $1 AND user_id = $2 RETURNING id`, [recordId, userId])
       : await this.pool.query(`DELETE FROM scan_records WHERE id = $1 RETURNING id`, [recordId]);
     return (result.rowCount ?? result.rows.length) > 0;
   }
 }
 
 function searchPageFromRows(rows: Array<Record<string, unknown>>, limit: number): SearchPage {
   const items = rows.slice(0, limit).map((row) => toSummary(row.record as SearchRecord));
   return {
     items,
     ...(rows.length > limit && items.length
diff --git a/packages/search-store/src/tiered-search-store.ts b/packages/search-store/src/tiered-search-store.ts
index 58d0f19..34d2549 100644
--- a/packages/search-store/src/tiered-search-store.ts
+++ b/packages/search-store/src/tiered-search-store.ts
@@ -1,38 +1,37 @@
-import {
-  ownerOf,
-  type CatalogResultLike,
-  type ReleasedTrackLike,
-  type SearchInput,
-  type SearchPage,
-  type SearchPageOptions,
-  type SearchRecord,
-  type SearchStore,
-  type SearchSummary,
+import type {
+  CatalogResultLike,
+  ReleasedTrackLike,
+  SearchInput,
+  SearchPage,
+  SearchPageOptions,
+  SearchRecord,
+  SearchStore,
+  SearchSummary,
 } from './search-store';
 import type { PostgresSearchStore } from './postgres-search-store';
 
 /**
  * Two-tier store: Redis is the HOT tier (fast reads, frequent progress writes for the
  * live UI); Postgres is the DURABLE source of truth. Every acknowledged save and
  * mutation commits to Postgres first. Redis is refreshed as a version-aware cache
  * and can never become authoritative after a database failure or cache flush.
  */
 export class TieredSearchStore implements SearchStore {
   constructor(
     private readonly hot: SearchStore,
     private readonly durable: PostgresSearchStore,
     private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
   ) {}
 
-  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
-    const rec = await this.durable.save(input, result, released);
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
+    const rec = await this.durable.save(input, result, released, owner);
     await this.warm(rec);
     return rec;
   }
 
   async get(recordId: string): Promise<SearchRecord | null> {
     const authoritative = await this.durable.get(recordId);
     if (authoritative) await this.warm(authoritative);
     return authoritative;
   }
 
@@ -43,68 +42,50 @@ export class TieredSearchStore implements SearchStore {
   }
 
   async list(): Promise<SearchSummary[]> {
     try {
       return await this.durable.list();
     } catch {
       throw new Error('durable search store unavailable');
     }
   }
 
-  async listForTenant(tenantId: string): Promise<SearchSummary[]> {
+  async listForUser(userId: string): Promise<SearchSummary[]> {
     try {
-      return await this.durable.listForTenant(tenantId);
+      return await this.durable.listForUser(userId);
     } catch {
       throw new Error('durable search store unavailable');
     }
   }
 
-  async listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]> {
+  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
     try {
-      return await this.durable.listForOwner(tenantId, ownerUserId);
-    } catch {
-      throw new Error('durable search store unavailable');
-    }
-  }
-
-  async pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage> {
-    try {
-      return await this.durable.pageForTenant(tenantId, options);
-    } catch {
-      throw new Error('durable search store unavailable');
-    }
-  }
-
-  async pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage> {
-    try {
-      return await this.durable.pageForOwner(tenantId, ownerUserId, options);
+      return await this.durable.pageForUser(userId, options);
     } catch {
       throw new Error('durable search store unavailable');
     }
   }
 
   async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     const next = await this.durable.update(recordId, mutate);
     if (next) await this.warm(next);
     return next;
   }
 
-  async delete(recordId: string, tenantId?: string, ownerUserId?: string): Promise<boolean> {
+  async delete(recordId: string, userId?: string): Promise<boolean> {
     // Delete from the durable source first. If that fails, keep the cache intact so a record can
     // never appear deleted and then re-emerge from Postgres after a Redis flush/restart.
     const durableRecord = await this.durable.get(recordId);
-    if (durableRecord && tenantId && ownerOf(durableRecord) !== tenantId) return false;
-    if (durableRecord && ownerUserId && durableRecord.ownerUserId !== ownerUserId) return false;
-    const owner = tenantId ?? (durableRecord ? ownerOf(durableRecord) : undefined);
-    const userOwner = ownerUserId ?? durableRecord?.ownerUserId;
-    const durableDeleted = await this.durable.delete(recordId, owner, userOwner);
-    const hotDeleted = await this.hot.delete(recordId, owner, userOwner).catch((err) => {
+    if (durableRecord && userId && durableRecord.userId !== userId) return false;
+    const owner = userId ?? durableRecord?.userId;
+    const durableDeleted = await this.durable.delete(recordId, owner);
+    const hotDeleted = await this.hot.delete(recordId, owner).catch((err) => {
       this.log('hot search-store cache delete failed', { err: String(err) });
       return false;
     });
     return durableDeleted || hotDeleted;
   }
 
   private async warm(record: SearchRecord): Promise<void> {
     try {
       await this.hot.put(record);
     } catch (err) {
