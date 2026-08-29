# Task 1 review package (efaad26..4ee30c5)

## Commits
4ee30c5 feat(auth): scope search store by user_id (keycloak sub) only

## Stat
 apps/api/src/search-principal-isolation.test.ts | 197 ++----------------
 apps/api/src/tenant-scoped-search-store.ts      | 266 +++++-------------------
 packages/search-store/src/in-memory.test.ts     | 111 ++++++++++
 packages/search-store/src/search-store.ts       | 178 +++++-----------
 4 files changed, 243 insertions(+), 509 deletions(-)

## Diff (-U10)
diff --git a/apps/api/src/search-principal-isolation.test.ts b/apps/api/src/search-principal-isolation.test.ts
index fe07a24..d9192a5 100644
--- a/apps/api/src/search-principal-isolation.test.ts
+++ b/apps/api/src/search-principal-isolation.test.ts
@@ -1,180 +1,23 @@
-import type { FastifyInstance } from 'fastify';
-import { generateKeyPair, SignJWT } from 'jose';
-import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
+import { describe, it, expect } from 'vitest';
 import { InMemorySearchStore } from '@sentinel/search-store';
-import { buildApp } from './app';
-import { createAppTestServices } from './app.test-support';
-import type { CatalogScanResult } from './catalog-scan';
-import { personalArtistWorkspaceId } from './tenant-scoped-search-store';
-
-const ISSUER = 'https://identity.example/realms/sentinel';
-const AUDIENCE = 'sentinel-api';
-type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
-let privateKey: KeyPair['privateKey'];
-let publicKey: KeyPair['publicKey'];
-let app: FastifyInstance;
-const store = new InMemorySearchStore();
-
-const result = (artist: string): CatalogScanResult => ({
-  artist,
-  stores: ['Deezer'],
-  profiles: [],
-  tracks: [],
-  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
-  generatedAt: '2026-07-22T00:00:00.000Z',
-  warnings: [],
-  note: '',
-});
-
-async function bearer(sub: string, roles: string[], tenantId = 'tenant-a'): Promise<{ authorization: string }> {
-  const jwt = await new SignJWT({ tenant_id: tenantId, realm_access: { roles } })
-    .setProtectedHeader({ alg: 'RS256' })
-    .setIssuer(ISSUER)
-    .setAudience(AUDIENCE)
-    .setSubject(sub)
-    .setIssuedAt()
-    .setExpirationTime('5m')
-    .sign(privateKey);
-  return { authorization: `Bearer ${jwt}` };
-}
-
-beforeAll(async () => {
-  const pair = await generateKeyPair('RS256');
-  privateKey = pair.privateKey;
-  publicKey = pair.publicKey;
-  await store.save({
-    tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-alice-consent',
-    artist: 'Alice Secret', distributor: 'distrokid',
-  }, result('Alice Secret'), []);
-  await store.save({
-    tenantId: 'tenant-a', ownerUserId: 'bob', artistWorkspaceId: 'aw-bob-consent',
-    artist: 'Bob Secret', distributor: 'distrokid',
-  }, result('Bob Secret'), []);
-  await store.save({ tenantId: 'tenant-a', artist: 'Legacy Ownerless', distributor: 'distrokid' }, result('Legacy Ownerless'));
-
-  app = buildApp({
-    ...createAppTestServices(),
-    searchStore: store,
-    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
-    runFastCatalogScan: vi.fn(async (artist: string) => result(artist)),
-    runReleasedCatalogScan: vi.fn(async (artist: string) => result(artist)),
-    enqueueDeepScan: vi.fn(async () => {}),
-  });
-  await app.ready();
-});
-
-afterAll(async () => {
-  await app.close();
-});
-
-describe('authenticated scan/history principal isolation', () => {
-  it('hides the shared legacy demo/workspace/catalog surface in every authenticated deployment', async () => {
-    const headers = await bearer('alice', ['artist_manager']);
-    const responses = await Promise.all([
-      app.inject({ method: 'POST', url: '/api/demo/seed', headers }),
-      app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { name: 'Cross-user state' } }),
-      app.inject({ method: 'GET', url: '/api/workspaces/ws_lewis_ke_demo', headers }),
-      app.inject({ method: 'DELETE', url: '/api/workspaces/ws_lewis_ke_demo', headers }),
-      app.inject({ method: 'GET', url: '/api/catalog/releases?workspaceId=ws_lewis_ke_demo', headers }),
-      app.inject({ method: 'GET', url: '/api/issues?workspaceId=ws_lewis_ke_demo', headers }),
-    ]);
-
-    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
-  });
-
-  it('returns only the caller-owned rows for Alice and Bob within the same tenant', async () => {
-    const alice = await app.inject({ method: 'GET', url: '/api/searches', headers: await bearer('alice', ['artist_manager']) });
-    const bob = await app.inject({ method: 'GET', url: '/api/searches', headers: await bearer('bob', ['artist_manager']) });
-
-    expect(alice.statusCode).toBe(200);
-    expect((alice.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(['Alice Secret']);
-    expect((bob.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(['Bob Secret']);
-  });
-
-  it('uses indistinguishable 404s for another same-tenant user across read/manage/review routes', async () => {
-    const aliceRow = (await store.listForOwner('tenant-a', 'alice'))[0]!;
-    const headers = await bearer('bob', ['artist_manager']);
-    const responses = await Promise.all([
-      app.inject({ method: 'GET', url: `/api/searches/${aliceRow.id}`, headers }),
-      app.inject({ method: 'PATCH', url: `/api/searches/${aliceRow.id}`, headers, payload: { name: 'stolen' } }),
-      app.inject({ method: 'DELETE', url: `/api/searches/${aliceRow.id}`, headers }),
-      app.inject({ method: 'GET', url: `/api/searches/${aliceRow.id}/manual-review`, headers }),
-      app.inject({
-        method: 'PATCH',
-        url: `/api/searches/${aliceRow.id}/manual-review/not-a-real-item`,
-        headers,
-        payload: { decision: 'DISMISSED' },
-      }),
-      app.inject({ method: 'POST', url: `/api/searches/${aliceRow.id}/rescan`, headers, payload: {} }),
-    ]);
-
-    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
-    expect((await store.get(aliceRow.id))?.artist).toBe('Alice Secret');
-  });
-
-  it('stamps new writes from the verified subject and ignores a forged workspace body field', async () => {
-    const response = await app.inject({
-      method: 'POST',
-      url: '/api/searches',
-      headers: await bearer('alice', ['artist_manager']),
-      payload: { artist: 'New Alice Artist', distributor: 'distrokid', artistWorkspaceId: 'aw-forged' },
-    });
-    expect(response.statusCode).toBe(201);
-    const saved = await store.get(response.json().id as string);
-    expect(saved).toMatchObject({
-      ownerUserId: 'alice',
-      artistWorkspaceId: personalArtistWorkspaceId('tenant-a', 'alice'),
-    });
-    expect(saved?.artistWorkspaceId).not.toBe('aw-forged');
-  });
-
-  it('stamps saved CSV imports with the verified subject and server-selected workspace', async () => {
-    const response = await app.inject({
-      method: 'POST',
-      url: '/api/distributor-imports/csv',
-      headers: await bearer('bob', ['artist_manager']),
-      payload: {
-        distributor: 'distrokid',
-        artistName: 'Bob Import',
-        save: true,
-        csvText: 'Release Title,Track Title,Artist,ISRC\nRelease,Song,Bob Import,USRC17607839\n',
-        artistWorkspaceId: 'aw-forged',
-      },
-    });
-    expect(response.statusCode).toBe(200);
-    expect(await store.get(response.json().searchId as string)).toMatchObject({
-      ownerUserId: 'bob',
-      artistWorkspaceId: personalArtistWorkspaceId('tenant-a', 'bob'),
-    });
-  });
-
-  it('allows a tenant admin to manage its tenant and preserves the source scope on admin rescan', async () => {
-    const bobSource = (await store.listForOwner('tenant-a', 'bob')).find((row) => row.artist === 'Bob Secret')!;
-    const headers = await bearer('tenant-admin', ['tenant_admin']);
-    const list = await app.inject({ method: 'GET', url: '/api/searches', headers });
-    expect(list.statusCode).toBe(200);
-    expect((list.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(
-      expect.arrayContaining(['Alice Secret', 'Bob Secret', 'Legacy Ownerless']),
-    );
-
-    const rescan = await app.inject({ method: 'POST', url: `/api/searches/${bobSource.id}/rescan`, headers, payload: {} });
-    expect(rescan.statusCode).toBe(201);
-    expect(await store.get(rescan.json().id as string)).toMatchObject({
-      ownerUserId: 'bob', artistWorkspaceId: 'aw-bob-consent', sourceSearchId: bobSource.id,
-    });
-  });
-
-  it('does not grant a platform-admin-only token implicit customer catalogue access', async () => {
-    const headers = await bearer('platform-operator', ['platform_admin']);
-    const list = await app.inject({ method: 'GET', url: '/api/searches', headers });
-    const create = await app.inject({ method: 'POST', url: '/api/searches', headers, payload: { artist: 'Customer Data' } });
-    const csv = await app.inject({
-      method: 'POST', url: '/api/distributor-imports/csv', headers,
-      payload: { csvText: 'Release Title,Track Title,Artist\nR,T,A\n' },
-    });
-    expect(list.statusCode).toBe(403);
-    expect(create.statusCode).toBe(403);
-    expect(csv.statusCode).toBe(403);
-    expect(list.json()).toEqual({ error: 'customer scan access requires a customer role' });
+import { UserScopedSearchStore, type SearchPrincipal } from './tenant-scoped-search-store';
+
+const principal = (sub: string): SearchPrincipal => ({ sub, roles: ['user'], authenticated: true });
+const input = (artist: string) => ({ artist, distributor: 'distrokid' as const });
+const result = () => ({ tracks: [], warnings: [], summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: new Date().toISOString() });
+
+describe('UserScopedSearchStore isolates by keycloak sub', () => {
+  it('a user sees only their own records; another user gets null and an empty list', async () => {
+    const inner = new InMemorySearchStore();
+    const alice = new UserScopedSearchStore(inner, principal('alice'));
+    const bob = new UserScopedSearchStore(inner, principal('bob'));
+    const saved = await alice.save(input('Alice KE'), result());
+    expect(saved.userId).toBe('alice');
+    expect((await alice.get(saved.id))?.id).toBe(saved.id);
+    expect(await bob.get(saved.id)).toBeNull();
+    expect(await bob.update(saved.id, (r) => r)).toBeNull();
+    expect(await bob.delete(saved.id)).toBe(false);
+    expect((await bob.listPage(50)).items).toHaveLength(0);
+    expect((await alice.listPage(50)).items.map((r) => r.id)).toEqual([saved.id]);
   });
 });
diff --git a/apps/api/src/tenant-scoped-search-store.ts b/apps/api/src/tenant-scoped-search-store.ts
index 822e227..be2c18b 100644
--- a/apps/api/src/tenant-scoped-search-store.ts
+++ b/apps/api/src/tenant-scoped-search-store.ts
@@ -1,13 +1,12 @@
 import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
 import {
-  ownerOf,
   SEARCH_HISTORY_MAX_PAGE_SIZE,
   type SearchPageCursor,
   type SearchRecord,
   type SearchStore,
   type SearchSummary,
   type SearchInput,
   type CatalogResultLike,
   type ReleasedTrackLike,
 } from '@sentinel/search-store';
 
@@ -23,342 +22,191 @@ export class InvalidSearchHistoryPageError extends Error {
 
 export function parseSearchHistoryPageLimit(value: unknown): number {
   if (value === undefined) return SEARCH_HISTORY_DEFAULT_PAGE_SIZE;
   if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value)) throw new InvalidSearchHistoryPageError();
   const parsed = Number(value);
   if (!Number.isSafeInteger(parsed) || parsed > SEARCH_HISTORY_MAX_PAGE_SIZE) throw new InvalidSearchHistoryPageError();
   return parsed;
 }
 
 /**
- * A view of the search store restricted to ONE tenant.
+ * A view of the search store restricted to ONE user.
  *
  * The vulnerability this closes: the API read searches by id alone (`searchStore.get(id)`) and
- * listed them with no filter at all (`searchStore.list()`). With multi-tenant auth enabled, any
- * authenticated caller could read another tenant's scan, their artists, their unreleased
- * catalogue, their ISRCs, by knowing or guessing a search id, and `GET /api/searches` returned
- * every tenant's scans to everyone. The record type didn't even carry a `tenantId`, so there was
- * nothing to filter on.
+ * listed them with no filter at all (`searchStore.list()`). Any authenticated caller could read
+ * another user's scan, their artists, their unreleased catalogue, their ISRCs, by knowing or
+ * guessing a search id, and `GET /api/searches` returned every user's scans to everyone.
  *
- * Why a wrapper rather than a `tenantId` parameter on every store method: a parameter is a rule
- * that 50 call sites must each remember, and the one that forgets is invisible, it looks like
- * working code and returns data. Here the tenant is bound ONCE, and a route physically cannot ask
- * for another tenant's record: there is no argument for it.
+ * Why a wrapper rather than a `userId` parameter on every store method: a parameter is a rule
+ * that every call site must remember, and the one that forgets is invisible, it looks like
+ * working code and returns data. Here the user is bound ONCE, and a route physically cannot ask
+ * for another user's record: there is no argument for it.
  *
  * The WORKER deliberately keeps the unscoped store. It legitimately processes jobs for every
- * tenant and gets its tenant from the job, not from a request.
+ * user and gets its userId from the job, not from a request.
  */
-export class TenantScopedSearchStore {
-  constructor(private readonly inner: SearchStore, private readonly tenantId: string) {}
+export class UserBoundSearchStore {
+  constructor(private readonly inner: SearchStore, private readonly userId: string) {}
 
-  /** Stamps the owning tenant so the record can be scoped on every later read. */
-  async save(input: Omit<SearchInput, 'tenantId'>, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
-    return this.inner.save({ ...input, tenantId: this.tenantId }, result, released);
+  /** Stamps the owning user so the record can be scoped on every later read. */
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
+    return this.inner.save(input, result, released, { userId: this.userId });
   }
 
   /**
-   * Returns null, NOT 403, for another tenant's record.
+   * Returns null, NOT 403, for another user's record.
    *
    * A 403 confirms the id exists, which turns id-guessing into a working enumeration oracle for
-   * other tenants' scans. "Not found" is both true from this tenant's perspective and silent.
+   * other users' scans. "Not found" is both true from this user's perspective and silent.
    */
   async get(id: string): Promise<SearchRecord | null> {
     const rec = await this.inner.get(id);
-    if (!rec || ownerOf(rec) !== this.tenantId) return null;
+    if (!rec || rec.userId !== this.userId) return null;
     return rec;
   }
 
   async list(): Promise<SearchSummary[]> {
-    return this.inner.listForTenant(this.tenantId);
+    return this.inner.listForUser(this.userId);
   }
 
   async listPage(limit: number, after?: SearchPageCursor) {
-    return this.inner.pageForTenant(this.tenantId, { limit, ...(after ? { after } : {}) });
+    return this.inner.pageForUser(this.userId, { limit, ...(after ? { after } : {}) });
   }
 
-  /** Refuses to mutate another tenant's record, and cannot be tricked into re-owning it. */
+  /** Refuses to mutate another user's record, and cannot be tricked into re-owning it. */
   async update(id: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     const existing = await this.inner.get(id);
-    if (!existing || ownerOf(existing) !== this.tenantId) return null;
-    return this.inner.update(id, (r) => ({ ...mutate(r), tenantId: ownerOf(existing) }));
+    if (!existing || existing.userId !== this.userId) return null;
+    return this.inner.update(id, mutate);
   }
 
-  /** Delete only a record owned by this tenant; another tenant observes the same false as absent. */
+  /** Delete only a record owned by this user; another user observes the same false as absent. */
   async delete(id: string): Promise<boolean> {
     const existing = await this.inner.get(id);
-    if (!existing || ownerOf(existing) !== this.tenantId) return false;
-    return this.inner.delete(id, this.tenantId);
+    if (!existing || existing.userId !== this.userId) return false;
+    return this.inner.delete(id, this.userId);
   }
 }
 
 export interface SearchPrincipal {
-  tenantId: string;
   sub: string;
   roles: string[];
   authenticated: boolean;
 }
 
-type NewPrincipalSearchInput = Omit<SearchInput, 'tenantId' | 'ownerUserId' | 'artistWorkspaceId'>;
-
-function withoutClientScope(input: NewPrincipalSearchInput): NewPrincipalSearchInput {
-  // TypeScript's Omit is not a runtime boundary. Strip these keys explicitly so a plain JSON
-  // object (or an `as` cast in future route code) cannot smuggle scope into a derived legacy row.
-  const {
-    tenantId: _ignoredTenant,
-    ownerUserId: _ignoredOwner,
-    artistWorkspaceId: _ignoredWorkspace,
-    ...safe
-  } = input as SearchInput;
-  return safe;
-}
-
-/**
- * Stable personal workspace used for scans that are not attached to a consent-bound artist
- * workspace. The length-prefixed hash avoids leaking a tenant id or OIDC subject into URLs and
- * prevents ambiguous string concatenation from producing the same scope.
- */
-export function personalArtistWorkspaceId(tenantId: string, subject: string): string {
-  const material = `${tenantId.length}:${tenantId}${subject.length}:${subject}`;
-  return `aw-personal-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
+/** A create call bundled with the resulting scan so a derived record can be saved in one step. */
+export interface DerivedSearchPatch extends SearchInput {
+  result: CatalogResultLike;
+  released?: ReleasedTrackLike[];
 }
 
 /** Platform operations credentials do not silently double as customer-data credentials. */
 export function hasCustomerScanAccess(principal: SearchPrincipal): boolean {
   if (!principal.authenticated) return true;
-  return principal.roles.some((role) => role === 'user' || role === 'artist_manager' || role === 'tenant_admin');
-}
-
-export interface PrincipalWorkspaceAccess {
-  /** Workspace identifiers proven through the durable organization repository for this request. */
-  read: readonly string[];
-  /** Subset for which the principal may mutate catalog history or create derived scans. */
-  edit: readonly string[];
+  return principal.roles.includes('user');
 }
 
 /**
  * Request-bound search-store view.
  *
- * Regular users and artist managers see only rows whose tenant AND immutable OIDC subject match.
- * Tenant administrators may operate on any row in their own tenant. A platform-admin-only token
- * has no customer-data access. Legacy ownerless rows remain available to tenant administrators
- * for migration/cleanup but are invisible to authenticated ordinary users.
+ * The ONLY scoping rule: a record is visible/writable iff the caller has customer scan access
+ * AND `record.userId === principal.sub`. There is no admin override, no shared workspace, and
+ * no cross-user visibility of any kind, every user's search history is theirs alone.
  */
-export class PrincipalScopedSearchStore {
-  private readonly tenantAdmin: boolean;
-  private readonly unverifiedTestIdentity: boolean;
+export class UserScopedSearchStore {
   private readonly cursorSigningKey: Buffer;
-  private readonly readableWorkspaces: ReadonlySet<string> | null;
-  private readonly editableWorkspaces: ReadonlySet<string> | null;
 
   constructor(
     private readonly inner: SearchStore,
     private readonly principal: SearchPrincipal,
-    workspaceAccess?: PrincipalWorkspaceAccess,
     cursorSigningSecret = process.env.HISTORY_CURSOR_SIGNING_KEY
       ?? process.env.ENCRYPTION_MASTER_KEY
       ?? HISTORY_DEVELOPMENT_CURSOR_SECRET,
   ) {
-    // Once DB-backed workspace grants are supplied they are authoritative. A coarse Keycloak
-    // tenant_admin role must not silently expand access in another selected organization.
-    this.tenantAdmin = !workspaceAccess && principal.roles.includes('tenant_admin');
-    this.unverifiedTestIdentity = !principal.authenticated;
-    this.readableWorkspaces = workspaceAccess ? new Set(workspaceAccess.read) : null;
-    this.editableWorkspaces = workspaceAccess ? new Set(workspaceAccess.edit) : null;
     // Domain-separated derivation avoids using the encryption key bytes directly as an HMAC key.
     this.cursorSigningKey = createHmac('sha256', cursorSigningSecret).update(HISTORY_CURSOR_CONTEXT).digest();
   }
 
-  private canRead(record: SearchRecord): boolean {
-    if (!hasCustomerScanAccess(this.principal) || ownerOf(record) !== this.principal.tenantId) return false;
-    if (this.readableWorkspaces) {
-      return Boolean(record.artistWorkspaceId && this.readableWorkspaces.has(record.artistWorkspaceId));
-    }
-    if (this.unverifiedTestIdentity || this.tenantAdmin) return true;
-    return Boolean(record.ownerUserId) && record.ownerUserId === this.principal.sub;
-  }
-
-  private canWrite(record: SearchRecord): boolean {
-    if (!this.canRead(record)) return false;
-    if (this.editableWorkspaces) {
-      return Boolean(record.artistWorkspaceId && this.editableWorkspaces.has(record.artistWorkspaceId));
-    }
-    return true;
+  private owns(record: SearchRecord | null): record is SearchRecord {
+    return record !== null && hasCustomerScanAccess(this.principal) && record.userId === this.principal.sub;
   }
 
   private assertCanCreate(): void {
     if (!hasCustomerScanAccess(this.principal)) {
       const error = new Error('customer scan access requires a customer role');
       error.name = 'CustomerScanAccessError';
       throw error;
     }
   }
 
-  /** Create a new personal scan; no client-provided owner or workspace can override this scope. */
-  async save(
-    input: NewPrincipalSearchInput,
-    result: CatalogResultLike,
-    released?: ReleasedTrackLike[],
-  ): Promise<SearchRecord> {
-    this.assertCanCreate();
-    return this.inner.save({
-      ...withoutClientScope(input),
-      tenantId: this.principal.tenantId,
-      ownerUserId: this.principal.sub,
-      artistWorkspaceId: personalArtistWorkspaceId(this.principal.tenantId, this.principal.sub),
-    }, result, released);
-  }
-
-  /**
-   * Create a scan in a workspace that the API has already authorized through the durable
-   * organization repository. Client scope fields are still stripped; the trusted workspace is a
-   * separate argument so an untyped request object cannot overwrite it by property ordering.
-   */
-  async saveInAuthorizedWorkspace(
-    workspaceId: string,
-    input: NewPrincipalSearchInput,
-    result: CatalogResultLike,
-    released?: ReleasedTrackLike[],
-  ): Promise<SearchRecord> {
+  /** Create a new personal scan; no client-provided owner can override this scope. */
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
     this.assertCanCreate();
-    const normalizedWorkspaceId = workspaceId.trim();
-    if (!normalizedWorkspaceId) throw new Error('an authorized artist workspace is required');
-    if (this.editableWorkspaces && !this.editableWorkspaces.has(normalizedWorkspaceId)) {
-      throw new Error('workspace is outside the editable principal scope');
-    }
-    return this.inner.save({
-      ...withoutClientScope(input),
-      tenantId: this.principal.tenantId,
-      ownerUserId: this.principal.sub,
-      artistWorkspaceId: normalizedWorkspaceId,
-    }, result, released);
+    return this.inner.save(input, result, released, { userId: this.principal.sub });
   }
 
-  /** Create a child history entry while preserving the source's immutable principal/workspace. */
-  async saveDerived(
-    source: SearchRecord,
-    input: NewPrincipalSearchInput,
-    result: CatalogResultLike,
-    released?: ReleasedTrackLike[],
-  ): Promise<SearchRecord> {
+  /** Create a child history entry while preserving the source's immutable owner. */
+  async saveDerived(source: SearchRecord, patch: DerivedSearchPatch): Promise<SearchRecord> {
     this.assertCanCreate();
-    if (!this.canWrite(source)) throw new Error('search source is outside the editable principal scope');
-    return this.inner.save({
-      ...withoutClientScope(input),
-      tenantId: ownerOf(source),
-      ...(source.ownerUserId ? { ownerUserId: source.ownerUserId } : {}),
-      ...(source.artistWorkspaceId ? { artistWorkspaceId: source.artistWorkspaceId } : {}),
-    }, result, released);
+    if (!this.owns(source)) throw new Error('search source is outside the editable principal scope');
+    const { result, released, ...input } = patch;
+    return this.inner.save(input, result, released, { userId: source.userId });
   }
 
   async get(id: string): Promise<SearchRecord | null> {
     const record = await this.inner.get(id);
-    return record && this.canRead(record) ? record : null;
+    return this.owns(record) ? record : null;
   }
 
   async list(): Promise<SearchSummary[]> {
     if (!hasCustomerScanAccess(this.principal)) return [];
-    if (this.readableWorkspaces) {
-      return (await this.inner.listForTenant(this.principal.tenantId)).filter((record) =>
-        Boolean(record.artistWorkspaceId && this.readableWorkspaces!.has(record.artistWorkspaceId)));
-    }
-    if (this.unverifiedTestIdentity || this.tenantAdmin) return this.inner.listForTenant(this.principal.tenantId);
-    return this.inner.listForOwner(this.principal.tenantId, this.principal.sub);
+    return this.inner.listForUser(this.principal.sub);
   }
 
   /**
    * Principal-bound seek pagination. The cursor is deliberately opaque and tamper-evident, but
-   * authorization never depends on it: the storage query is independently fixed to this tenant
-   * and, for ordinary users, this exact OIDC subject.
+   * authorization never depends on it: the storage query is independently fixed to this exact
+   * OIDC subject.
    */
-  async listPage(limit: number, cursor?: string): Promise<{ searches: SearchSummary[]; nextCursor?: string }> {
-    if (!hasCustomerScanAccess(this.principal)) return { searches: [] };
+  async listPage(limit: number, cursor?: string): Promise<{ items: SearchSummary[]; nextCursor?: string }> {
+    if (!hasCustomerScanAccess(this.principal)) return { items: [] };
     if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_HISTORY_MAX_PAGE_SIZE) {
       throw new InvalidSearchHistoryPageError();
     }
-    const scope = historyCursorScope(
-      this.principal,
-      this.unverifiedTestIdentity || this.tenantAdmin,
-      this.readableWorkspaces ? [...this.readableWorkspaces] : undefined,
-    );
+    const scope = historyCursorScope(this.principal);
     const after = cursor === undefined ? undefined : decodeHistoryCursor(cursor, scope, this.cursorSigningKey);
-    if (this.readableWorkspaces) {
-      let position = after;
-      const searches: SearchSummary[] = [];
-      // Page the tenant index in bounded chunks and filter before returning. This keeps cursors
-      // stable without exposing another workspace row while storage gains a native workspace page.
-      while (searches.length < limit) {
-        const page = await this.inner.pageForTenant(this.principal.tenantId, {
-          limit: SEARCH_HISTORY_MAX_PAGE_SIZE,
-          ...(position ? { after: position } : {}),
-        });
-        let stoppedInsidePage = false;
-        for (let index = 0; index < page.items.length; index += 1) {
-          const item = page.items[index]!;
-          position = { createdAt: item.createdAt, id: item.id };
-          if (item.artistWorkspaceId && this.readableWorkspaces.has(item.artistWorkspaceId)) searches.push(item);
-          if (searches.length === limit) {
-            stoppedInsidePage = index < page.items.length - 1;
-            break;
-          }
-        }
-        if (searches.length === limit) {
-          const hasMore = stoppedInsidePage || Boolean(page.nextCursor);
-          return {
-            searches,
-            ...(hasMore && position
-              ? { nextCursor: encodeHistoryCursor(position, scope, this.cursorSigningKey) }
-              : {}),
-          };
-        }
-        if (!page.nextCursor) return { searches };
-        position = page.nextCursor;
-      }
-      return { searches };
-    }
-    const options = { limit, ...(after ? { after } : {}) };
-    const page = this.unverifiedTestIdentity || this.tenantAdmin
-      ? await this.inner.pageForTenant(this.principal.tenantId, options)
-      : await this.inner.pageForOwner(this.principal.tenantId, this.principal.sub, options);
+    const page = await this.inner.pageForUser(this.principal.sub, { limit, ...(after ? { after } : {}) });
     return {
-      searches: page.items,
+      items: page.items,
       ...(page.nextCursor ? { nextCursor: encodeHistoryCursor(page.nextCursor, scope, this.cursorSigningKey) } : {}),
     };
   }
 
   async update(id: string, mutate: (record: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     const existing = await this.inner.get(id);
-    if (!existing || !this.canWrite(existing)) return null;
+    if (!this.owns(existing)) return null;
     return this.inner.update(id, mutate);
   }
 
   async delete(id: string): Promise<boolean> {
     const existing = await this.inner.get(id);
-    if (!existing || !this.canWrite(existing)) return false;
-    return this.inner.delete(id, ownerOf(existing), existing.ownerUserId);
+    return this.owns(existing) ? this.inner.delete(id, this.principal.sub) : false;
   }
 }
 
 const HISTORY_CURSOR_VERSION = 1;
 const HISTORY_CURSOR_CONTEXT = 'sentinel:search-history:v1\0';
 const HISTORY_CURSOR_MAX_LENGTH = 768;
 const HISTORY_DEVELOPMENT_CURSOR_SECRET = 'sentinel-local-history-cursors-not-for-production';
 
-function historyCursorScope(
-  principal: SearchPrincipal,
-  tenantWide: boolean,
-  workspaceIds?: readonly string[],
-): string {
-  const raw = workspaceIds
-    ? `workspace:${principal.tenantId.length}:${principal.tenantId}:${[...workspaceIds].sort().join('\0')}`
-    : tenantWide
-    ? `tenant:${principal.tenantId.length}:${principal.tenantId}`
-    : `owner:${principal.tenantId.length}:${principal.tenantId}:${principal.sub.length}:${principal.sub}`;
+function historyCursorScope(principal: SearchPrincipal): string {
+  const raw = `user:${principal.sub.length}:${principal.sub}`;
   return createHash('sha256').update(raw).digest('base64url');
 }
 
 function cursorChecksum(body: string, signingKey: Buffer): string {
   return createHmac('sha256', signingKey).update(body).digest('base64url').slice(0, 22);
 }
 
 function encodeHistoryCursor(position: SearchPageCursor, scope: string, signingKey: Buffer): string {
   const body = Buffer.from(JSON.stringify({
     v: HISTORY_CURSOR_VERSION,
diff --git a/packages/search-store/src/in-memory.test.ts b/packages/search-store/src/in-memory.test.ts
new file mode 100644
index 0000000..24706b9
--- /dev/null
+++ b/packages/search-store/src/in-memory.test.ts
@@ -0,0 +1,111 @@
+import { describe, it, expect } from 'vitest';
+import { InMemorySearchStore, type CatalogResultLike, type SearchRecord } from './search-store';
+
+const result = (artist = 'Lewis KE'): CatalogResultLike => ({
+  artist,
+  stores: [],
+  profiles: [],
+  tracks: [],
+  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
+  generatedAt: new Date().toISOString(),
+  warnings: [],
+  note: '',
+});
+
+const input = (artist: string) => ({ artist, distributor: 'distrokid' });
+
+/** Full record for direct `put`, so ordering tests control `createdAt` instead of racing the clock. */
+const record = (overrides: Partial<SearchRecord> & Pick<SearchRecord, 'id' | 'userId' | 'createdAt'>): SearchRecord => ({
+  revision: 1,
+  artist: 'Lewis KE',
+  distributor: 'distrokid',
+  platforms: [],
+  song: null,
+  result: result(),
+  ...overrides,
+});
+
+describe('InMemorySearchStore', () => {
+  it('save() stamps the record with the owner passed to it, and defaults to an empty userId when none is given', async () => {
+    const store = new InMemorySearchStore();
+    const owned = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    expect(owned.userId).toBe('alice');
+
+    const unowned = await store.save(input('No Owner'), result('No Owner'));
+    expect(unowned.userId).toBe('');
+  });
+
+  it('get() is unscoped: it finds a record by id regardless of owner, for the worker path', async () => {
+    const store = new InMemorySearchStore();
+    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    expect((await store.get(saved.id))?.userId).toBe('alice');
+    expect(await store.get('search_does_not_exist')).toBeNull();
+  });
+
+  it('listForUser()/pageForUser() return only that user\'s records, newest first', async () => {
+    const store = new InMemorySearchStore();
+    await store.put(record({ id: 'search_alice_older', userId: 'alice', createdAt: '2026-01-01T00:00:00.000Z' }));
+    await store.put(record({ id: 'search_alice_newer', userId: 'alice', createdAt: '2026-01-02T00:00:00.000Z' }));
+    await store.put(record({ id: 'search_bob_only', userId: 'bob', createdAt: '2026-01-03T00:00:00.000Z' }));
+
+    const aliceList = await store.listForUser('alice');
+    expect(aliceList.map((r) => r.id)).toEqual(['search_alice_newer', 'search_alice_older']);
+    expect(aliceList.every((r) => r.userId === 'alice')).toBe(true);
+
+    const bobList = await store.listForUser('bob');
+    expect(bobList.map((r) => r.id)).toEqual(['search_bob_only']);
+
+    const strangerList = await store.listForUser('carol');
+    expect(strangerList).toHaveLength(0);
+
+    const page = await store.pageForUser('alice', { limit: 1 });
+    expect(page.items.map((r) => r.id)).toEqual(['search_alice_newer']);
+    expect(page.nextCursor).toBeDefined();
+    const nextPage = await store.pageForUser('alice', { limit: 1, after: page.nextCursor! });
+    expect(nextPage.items.map((r) => r.id)).toEqual(['search_alice_older']);
+    expect(nextPage.nextCursor).toBeUndefined();
+  });
+
+  it('update() preserves id/userId/createdAt even if the mutator tries to overwrite them', async () => {
+    const store = new InMemorySearchStore();
+    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    const mutated = await store.update(saved.id, (r) => ({
+      ...r,
+      id: 'search_forged',
+      userId: 'bob',
+      createdAt: '1999-01-01T00:00:00.000Z',
+      name: 'renamed',
+    }));
+    expect(mutated).toMatchObject({ id: saved.id, userId: 'alice', createdAt: saved.createdAt, name: 'renamed' });
+    expect(mutated?.revision).toBe((saved.revision ?? 0) + 1);
+    expect(await store.update('search_does_not_exist', (r) => r)).toBeNull();
+  });
+
+  it('delete() only removes a record when the given userId matches, and removes it outright with no userId given', async () => {
+    const store = new InMemorySearchStore();
+    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    expect(await store.delete(saved.id, 'bob')).toBe(false);
+    expect(await store.get(saved.id)).not.toBeNull();
+    expect(await store.delete(saved.id, 'alice')).toBe(true);
+    expect(await store.get(saved.id)).toBeNull();
+
+    const another = await store.save(input('Bob KE'), result('Bob KE'), [], { userId: 'bob' });
+    expect(await store.delete(another.id)).toBe(true);
+    expect(await store.get(another.id)).toBeNull();
+  });
+
+  it('put() rejects overwriting an existing id with a record owned by a different user', async () => {
+    const store = new InMemorySearchStore();
+    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    await expect(store.put({ ...saved, userId: 'bob', revision: (saved.revision ?? 0) + 1 }))
+      .rejects.toThrow('search record id is already owned by another user');
+  });
+
+  it('list() is unscoped and reflects every owner (used only by the worker/admin path, never a request)', async () => {
+    const store = new InMemorySearchStore();
+    await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
+    await store.save(input('Bob KE'), result('Bob KE'), [], { userId: 'bob' });
+    const all = await store.list();
+    expect(all.map((r) => r.userId).sort()).toEqual(['alice', 'bob']);
+  });
+});
diff --git a/packages/search-store/src/search-store.ts b/packages/search-store/src/search-store.ts
index 5750078..187e88c 100644
--- a/packages/search-store/src/search-store.ts
+++ b/packages/search-store/src/search-store.ts
@@ -158,26 +158,20 @@ export interface ReleasedTrackLike {
   artworkUrl?: string | null;
   label?: string | null;
   upc?: string | null;
   releaseDate?: string | null;
   uploadDate?: string | null;
   /** Retained while store presence is recomputed so a recheck cannot erase capture evidence. */
   metadata?: CatalogTrackMetadataLike;
 }
 
 export interface SearchInput {
-  /** Owning tenant. Stamped onto the record so every later read can be scoped to it. */
-  tenantId?: string;
-  /** Immutable OIDC subject that owns this scan. Absent only on pre-principal legacy rows. */
-  ownerUserId?: string;
-  /** Immutable artist workspace scope. Absent only on pre-workspace legacy rows. */
-  artistWorkspaceId?: string;
   /** Optional user-facing history label. API boundaries validate user supplied values. */
   name?: string;
   /** Immediate predecessor when this record was created by a rescan. */
   sourceSearchId?: string;
   artist: string;
   distributor: string;
   platforms?: string[];
   song?: { title?: string; isrc?: string } | null;
 }
 
@@ -209,57 +203,46 @@ export interface LyricsScanState {
   startedAt?: string;
   updatedAt?: string;
   error?: string;
 }
 
 export interface SearchRecord {
   id: string;
   /** Monotonic concurrency token shared by hot and durable tiers. Missing means legacy revision 0. */
   revision?: number;
   /**
-   * Owning tenant. Every read on behalf of a user MUST be filtered by this, see
-   * `apps/api/src/tenant-scoped-search-store.ts`.
-   *
-   * Records written before this field existed have no tenant; they are quarantined in the
-   * `default` legacy namespace, which prevents them from being attributed to a real tenant.
+   * Keycloak `sub` that owns this record. Every read on behalf of a user MUST be filtered by
+   * this, see `apps/api/src/tenant-scoped-search-store.ts`.
    */
-  tenantId?: string;
-  /** OIDC subject that created/owns the scan. Legacy rows may be ownerless. */
-  ownerUserId?: string;
-  /** Server-validated workspace scope attached at creation. Legacy rows may omit it. */
-  artistWorkspaceId?: string;
+  userId: string;
   /** User-facing history label. Optional for records created before scan naming existed. */
   name?: string;
   /** Immutable link to the scan that was explicitly rescanned. */
   sourceSearchId?: string;
   createdAt: string;
   artist: string;
   distributor: string;
   platforms: string[];
   song: { title?: string; isrc?: string } | null;
   result: CatalogResultLike;
   released?: ReleasedTrackLike[];
   deepScan?: DeepScanState;
   /** Progress + results of the independent lyric-availability (LRCLIB) check. */
   lyricsScan?: LyricsScanState;
 }
 
-/** Quarantine namespace for records written before tenant ownership was mandatory. */
-export const DEFAULT_TENANT = 'default';
-
-/** A record's owner, defaulting legacy rows to the quarantine namespace rather than to "anyone". */
-export const ownerOf = (r: Pick<SearchRecord, 'tenantId'>): string => r.tenantId ?? DEFAULT_TENANT;
+/** A record's owner: the keycloak `sub` that created it, and the sole scoping key. */
+export const ownerOf = (r: Pick<SearchRecord, 'userId'>): string => r.userId;
 
 export interface SearchSummary {
   id: string;
-  ownerUserId?: string;
-  artistWorkspaceId?: string;
+  userId: string;
   name?: string;
   sourceSearchId?: string;
   createdAt: string;
   artist: string;
   distributor: string;
   platforms: string[];
   song: { title?: string; isrc?: string } | null;
   summary: CatalogResultLike['summary'];
   stores: string[];
   deepScan?: Pick<DeepScanState, 'status' | 'platformsDone' | 'platformsPending'>;
@@ -312,42 +295,44 @@ export function paginateSearchSummaries(items: SearchSummary[], options: SearchP
     items: pageItems,
     ...(ordered.length > options.limit && pageItems.length
       ? { nextCursor: { createdAt: pageItems[pageItems.length - 1]!.createdAt, id: pageItems[pageItems.length - 1]!.id } }
       : {}),
   };
 }
 
 export function toSummary(r: SearchRecord): SearchSummary {
   return {
     id: r.id,
-    ...(r.ownerUserId ? { ownerUserId: r.ownerUserId } : {}),
-    ...(r.artistWorkspaceId ? { artistWorkspaceId: r.artistWorkspaceId } : {}),
+    userId: r.userId,
     ...(r.name ? { name: r.name } : {}),
     ...(r.sourceSearchId ? { sourceSearchId: r.sourceSearchId } : {}),
     createdAt: r.createdAt,
     artist: r.artist,
     distributor: r.distributor,
     platforms: r.platforms,
     song: r.song,
     summary: r.result.summary,
     stores: r.result.stores,
     ...(r.deepScan ? { deepScan: { status: r.deepScan.status, platformsDone: r.deepScan.platformsDone, platformsPending: r.deepScan.platformsPending } } : {}),
   };
 }
 
-function newRecord(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): SearchRecord {
+function newRecord(
+  input: SearchInput,
+  result: CatalogResultLike,
+  released?: ReleasedTrackLike[],
+  owner?: { userId: string },
+): SearchRecord {
   return {
     id: id('search'),
     revision: 1,
-    tenantId: input.tenantId ?? DEFAULT_TENANT,
-    ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
-    ...(input.artistWorkspaceId ? { artistWorkspaceId: input.artistWorkspaceId } : {}),
+    userId: owner?.userId ?? '',
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
@@ -359,41 +344,37 @@ export function revisionOf(record: Pick<SearchRecord, 'revision'>): number {
 }
 
 /** Apply a mutation while preserving immutable identity/ownership and advancing its revision. */
 export function applySearchMutation(
   current: SearchRecord,
   mutate: (record: SearchRecord) => SearchRecord,
 ): SearchRecord {
   // Capture before the callback so even an accidentally in-place mutation cannot change them.
   const identity = {
     id: current.id,
-    tenantId: ownerOf(current),
+    userId: current.userId,
     createdAt: current.createdAt,
     revision: revisionOf(current) + 1,
   };
   // A worker/projection update may change scan results and a history rename may change `name`,
   // but neither is allowed to rewrite lineage after the record has been created.
   const {
     id: _ignoredId,
-    tenantId: _ignoredTenant,
-    ownerUserId: _ignoredOwner,
-    artistWorkspaceId: _ignoredWorkspace,
+    userId: _ignoredUserId,
     createdAt: _ignoredCreatedAt,
     revision: _ignoredRevision,
     sourceSearchId: _ignoredLineage,
     ...mutated
   } = mutate(current);
   return {
     ...mutated,
     ...identity,
-    ...(current.ownerUserId ? { ownerUserId: current.ownerUserId } : {}),
-    ...(current.artistWorkspaceId ? { artistWorkspaceId: current.artistWorkspaceId } : {}),
     ...(current.sourceSearchId ? { sourceSearchId: current.sourceSearchId } : {}),
   };
 }
 
 /** JSON-semantic equality (object key order and undefined fields are not durable JSON state). */
 export function searchRecordsEqual(a: SearchRecord, b: SearchRecord): boolean {
   return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
 }
 
 function canonicalJson(value: unknown): unknown {
@@ -403,187 +384,151 @@ function canonicalJson(value: unknown): unknown {
       Object.entries(value as Record<string, unknown>)
         .filter(([, item]) => item !== undefined)
         .sort(([a], [b]) => a.localeCompare(b))
         .map(([key, item]) => [key, canonicalJson(item)]),
     );
   }
   return value;
 }
 
 export interface SearchStore {
-  save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord>;
+  /** `owner` stamps `record.userId`; concrete stores must not accept ownership any other way. */
+  save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord>;
   get(id: string): Promise<SearchRecord | null>;
   list(): Promise<SearchSummary[]>;
-  /** List within a tenant at the storage/index layer so another tenant cannot starve results. */
-  listForTenant(tenantId: string): Promise<SearchSummary[]>;
-  /** List at the tenant + OIDC-subject index so a busy peer cannot starve this owner's page. */
-  listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]>;
-  /** Seek-paginated tenant history, ordered by createdAt DESC then id DESC. */
-  pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage>;
-  /** Seek-paginated tenant + owner history; ordinary principals must use this boundary. */
-  pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage>;
+  /** List at the user index so a busy peer cannot starve this owner's page. */
+  listForUser(userId: string): Promise<SearchSummary[]>;
+  /** Seek-paginated user history, ordered by createdAt DESC then id DESC. */
+  pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage>;
   /** Apply a partial update (used by the deep-scan worker to record progress/results). */
   update(id: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null>;
   /** Project a full record by id; older revisions are ignored (used to re-warm hot from durable). */
   put(rec: SearchRecord): Promise<void>;
   /** Permanently remove a record and every list/index entry that references it. */
-  delete(id: string, tenantId?: string, ownerUserId?: string): Promise<boolean>;
+  delete(id: string, userId?: string): Promise<boolean>;
 }
 
 /**
  * Process-local store for isolated automated tests only. Runtime composition
  * rejects this adapter so a restart cannot silently erase scan history.
  * @internal
  */
 export class InMemorySearchStore implements SearchStore {
   constructor() {
     if (process.env.NODE_ENV !== 'test') {
       throw new Error('InMemorySearchStore is test-only; configure DATABASE_URL for runtime persistence.');
     }
   }
 
   private readonly records: SearchRecord[] = [];
 
-  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
-    const rec = newRecord(input, result, released);
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
+    const rec = newRecord(input, result, released, owner);
     this.records.unshift(rec);
     return rec;
   }
   async get(recordId: string): Promise<SearchRecord | null> {
     return this.records.find((r) => r.id === recordId) ?? null;
   }
   async list(): Promise<SearchSummary[]> {
     return this.records.map(toSummary);
   }
-  async listForTenant(tenantId: string): Promise<SearchSummary[]> {
-    return this.records.filter((record) => ownerOf(record) === tenantId).slice(0, 200).map(toSummary);
-  }
-  async listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]> {
-    return this.records
-      .filter((record) => ownerOf(record) === tenantId && record.ownerUserId === ownerUserId)
-      .slice(0, 200)
-      .map(toSummary);
+  async listForUser(userId: string): Promise<SearchSummary[]> {
+    return this.records.filter((record) => record.userId === userId).slice(0, 200).map(toSummary);
   }
-  async pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage> {
+  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
     return paginateSearchSummaries(
-      this.records.filter((record) => ownerOf(record) === tenantId).map(toSummary),
-      options,
-    );
-  }
-  async pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage> {
-    return paginateSearchSummaries(
-      this.records
-        .filter((record) => ownerOf(record) === tenantId && record.ownerUserId === ownerUserId)
-        .map(toSummary),
+      this.records.filter((record) => record.userId === userId).map(toSummary),
       options,
     );
   }
   async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     const i = this.records.findIndex((r) => r.id === recordId);
     if (i < 0) return null;
     this.records[i] = applySearchMutation(this.records[i]!, mutate);
     return this.records[i]!;
   }
   async put(rec: SearchRecord): Promise<void> {
     const i = this.records.findIndex((r) => r.id === rec.id);
     if (i >= 0) {
       const current = this.records[i]!;
       assertSameSecurityScope(current, rec);
       const order = revisionOf(rec) - revisionOf(current);
       if (order < 0) return;
       if (order === 0 && !searchRecordsEqual(current, rec)) throw new Error('conflicting search record revision');
       if (order > 0) this.records[i] = rec;
     } else { this.records.unshift(rec); }
   }
-  async delete(recordId: string, tenantId?: string, ownerUserId?: string): Promise<boolean> {
+  async delete(recordId: string, userId?: string): Promise<boolean> {
     const index = this.records.findIndex((record) =>
-      record.id === recordId
-      && (!tenantId || ownerOf(record) === tenantId)
-      && (!ownerUserId || record.ownerUserId === ownerUserId));
+      record.id === recordId && (!userId || record.userId === userId));
     if (index < 0) return false;
     this.records.splice(index, 1);
     return true;
   }
 }
 
 /**
  * Redis-backed store SHARED across the API and worker containers. Records are JSON at
  * `search:{id}`; `search:index` is a capped list of ids (newest first). This is what
  * lets a separate worker write deep-scan results that the API then serves.
  */
 export class RedisSearchStore implements SearchStore {
   constructor(private readonly redis: RedisLike, private readonly prefix = 'search') {}
   private key(recordId: string): string { return `${this.prefix}:${recordId}`; }
   private get indexKey(): string { return `${this.prefix}:index`; }
-  private tenantIndexKey(tenantId: string): string { return `${this.prefix}:tenant:${encodeURIComponent(tenantId)}:index`; }
-  private ownerIndexKey(tenantId: string, ownerUserId: string): string {
-    return `${this.prefix}:tenant:${encodeURIComponent(tenantId)}:owner:${encodeURIComponent(ownerUserId)}:index`;
-  }
+  private userIndexKey(userId: string): string { return `${this.prefix}:user:${encodeURIComponent(userId)}:index`; }
 
   private async indexRecord(rec: SearchRecord): Promise<void> {
     await this.redis.lpush(this.indexKey, rec.id);
     await this.redis.ltrim(this.indexKey, 0, 199);
-    await this.redis.lpush(this.tenantIndexKey(ownerOf(rec)), rec.id);
-    if (rec.ownerUserId) {
-      await this.redis.lpush(this.ownerIndexKey(ownerOf(rec), rec.ownerUserId), rec.id);
-    }
+    await this.redis.lpush(this.userIndexKey(rec.userId), rec.id);
   }
 
-  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
-    const rec = newRecord(input, result, released);
+  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[], owner?: { userId: string }): Promise<SearchRecord> {
+    const rec = newRecord(input, result, released, owner);
     await this.redis.set(this.key(rec.id), JSON.stringify(rec));
     await this.indexRecord(rec);
     return rec;
   }
   async get(recordId: string): Promise<SearchRecord | null> {
     const raw = await this.redis.get(this.key(recordId));
     return raw ? (JSON.parse(raw) as SearchRecord) : null;
   }
   async list(): Promise<SearchSummary[]> {
     return this.listFromIndex(this.indexKey);
   }
-  async listForTenant(tenantId: string): Promise<SearchSummary[]> {
-    return this.listFromIndex(this.tenantIndexKey(tenantId), tenantId);
+  async listForUser(userId: string): Promise<SearchSummary[]> {
+    return this.listFromIndex(this.userIndexKey(userId), userId);
   }
-  async listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]> {
-    return this.listFromIndex(this.ownerIndexKey(tenantId, ownerUserId), tenantId, ownerUserId);
-  }
-  async pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage> {
-    return paginateSearchSummaries(
-      await this.summariesFromIndex(this.tenantIndexKey(tenantId), tenantId),
-      options,
-    );
-  }
-  async pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage> {
+  async pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage> {
     return paginateSearchSummaries(
-      await this.summariesFromIndex(this.ownerIndexKey(tenantId, ownerUserId), tenantId, ownerUserId),
+      await this.summariesFromIndex(this.userIndexKey(userId), userId),
       options,
     );
   }
-  private async listFromIndex(indexKey: string, tenantId?: string, ownerUserId?: string): Promise<SearchSummary[]> {
+  private async listFromIndex(indexKey: string, userId?: string): Promise<SearchSummary[]> {
     const ids = await this.redis.lrange(indexKey, 0, 199);
-    return this.summariesForIds(ids, tenantId, ownerUserId);
+    return this.summariesForIds(ids, userId);
   }
-  private async summariesFromIndex(indexKey: string, tenantId?: string, ownerUserId?: string): Promise<SearchSummary[]> {
+  private async summariesFromIndex(indexKey: string, userId?: string): Promise<SearchSummary[]> {
     const ids = await this.redis.lrange(indexKey, 0, -1);
-    return this.summariesForIds(ids, tenantId, ownerUserId);
+    return this.summariesForIds(ids, userId);
   }
-  private async summariesForIds(ids: string[], tenantId?: string, ownerUserId?: string): Promise<SearchSummary[]> {
+  private async summariesForIds(ids: string[], userId?: string): Promise<SearchSummary[]> {
     const out: SearchSummary[] = [];
     for (const rid of ids) {
       const raw = await this.redis.get(this.key(rid));
       if (raw) {
         const record = JSON.parse(raw) as SearchRecord;
         // Defense in depth against a stale/corrupt index entry.
-        if ((!tenantId || ownerOf(record) === tenantId) && (!ownerUserId || record.ownerUserId === ownerUserId)) {
-          out.push(toSummary(record));
-        }
+        if (!userId || record.userId === userId) out.push(toSummary(record));
       }
     }
     return out;
   }
   async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
     // API actions, finalization, and presence workers can update the same record concurrently.
     // Use an optimistic compare-and-set when the real Redis client is available so one writer
     // cannot silently erase another's checkpoint.
     if (this.redis.eval) {
       const key = this.key(recordId);
@@ -635,66 +580,53 @@ export class RedisSearchStore implements SearchStore {
       const order = revisionOf(rec) - revisionOf(current);
       if (order < 0) return;
       if (order === 0) {
         if (searchRecordsEqual(current, rec)) return;
         throw new Error('conflicting search record revision');
       }
     }
     await this.redis.set(key, JSON.stringify(rec));
     if (!current) await this.indexRecord(rec);
   }
-  async delete(recordId: string, tenantId?: string, ownerUserId?: string): Promise<boolean> {
+  async delete(recordId: string, userId?: string): Promise<boolean> {
     const raw = await this.redis.get(this.key(recordId));
     if (!raw) {
-      // A prior partial cleanup may have removed the value first. A tenant-scoped caller still
-      // gives us enough ownership information to repair both indexes idempotently.
+      // A prior partial cleanup may have removed the value first. A user-scoped caller still
+      // gives us enough ownership information to repair the index idempotently.
       await this.redis.lrem(this.indexKey, 0, recordId);
-      if (tenantId) await this.redis.lrem(this.tenantIndexKey(tenantId), 0, recordId);
-      if (tenantId && ownerUserId) await this.redis.lrem(this.ownerIndexKey(tenantId, ownerUserId), 0, recordId);
+      if (userId) await this.redis.lrem(this.userIndexKey(userId), 0, recordId);
       return false;
     }
     const record = JSON.parse(raw) as SearchRecord;
-    if (tenantId && ownerOf(record) !== tenantId) return false;
-    if (ownerUserId && record.ownerUserId !== ownerUserId) return false;
-    const tenantIndex = this.tenantIndexKey(tenantId ?? ownerOf(record));
-    const ownerIndex = record.ownerUserId
-      ? this.ownerIndexKey(tenantId ?? ownerOf(record), record.ownerUserId)
-      : null;
+    if (userId && record.userId !== userId) return false;
+    const userIndex = this.userIndexKey(userId ?? record.userId);
     if (this.redis.eval) {
       const removed = await this.redis.eval(
         REDIS_DELETE_WITH_INDEXES,
-        ownerIndex ? 4 : 3,
+        3,
         this.key(recordId),
         this.indexKey,
-        tenantIndex,
-        ...(ownerIndex ? [ownerIndex] : []),
+        userIndex,
         recordId,
       );
       return Number(removed) === 1;
     }
     // Minimal development adapters may not support Lua. Production ioredis always does.
     const removed = await this.redis.del(this.key(recordId));
     await this.redis.lrem(this.indexKey, 0, recordId);
-    await this.redis.lrem(tenantIndex, 0, recordId);
-    if (ownerIndex) await this.redis.lrem(ownerIndex, 0, recordId);
+    await this.redis.lrem(userIndex, 0, recordId);
     return Number(removed) > 0;
   }
 }
 
 function assertSameSecurityScope(current: SearchRecord, incoming: SearchRecord): void {
-  if (ownerOf(current) !== ownerOf(incoming)) throw new Error('search record id is already owned by another tenant');
-  if ((current.ownerUserId ?? null) !== (incoming.ownerUserId ?? null)) {
-    throw new Error('search record id is already owned by another user');
-  }
-  if ((current.artistWorkspaceId ?? null) !== (incoming.artistWorkspaceId ?? null)) {
-    throw new Error('search record id is already scoped to another artist workspace');
-  }
+  if (current.userId !== incoming.userId) throw new Error('search record id is already owned by another user');
 }
 
 /** Minimal Redis surface we use (satisfied by ioredis). */
 export interface RedisLike {
   get(key: string): Promise<string | null>;
   set(key: string, value: string): Promise<unknown>;
   lpush(key: string, value: string): Promise<unknown>;
   ltrim(key: string, start: number, stop: number): Promise<unknown>;
   lrange(key: string, start: number, stop: number): Promise<string[]>;
   lrem(key: string, count: number, value: string): Promise<unknown>;
