# Per-User Identity & Data Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every authenticated user accesses only their own searches/data (`user_id === keycloak sub`), and the organization/workspace/invitation/team-collaboration + GDPR-erasure subsystems are removed entirely.

**Architecture:** The per-user path already exists as the fallback in `PrincipalScopedSearchStore` (`record.ownerUserId === principal.sub`). We make it the ONLY path, collapse `tenant_id`/`owner_user_id`/`artist_workspace_id` into one `user_id` column, delete the org service + routes + UI + Keycloak org roles, and re-scope the worker/persistence writes by `userId`. Destructive migration + volume wipe (fresh start, approved).

**Tech Stack:** npm workspaces monorepo, TypeScript ESM, Fastify API, Next.js 15 BFF, Prisma + Postgres, Redis, Keycloak 26, Docker Compose, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-per-user-auth-isolation-design.md`

## Global Constraints

- **Isolation is the security guarantee:** after this change, an authenticated user MUST NOT read, list, mutate, delete, rescan, store-check, or lyric-check another user's data through ANY route. Foreign/missing records return 404/empty (anti-enumeration), never another user's data, never 500.
- Fail-closed auth: with `ENABLE_KEYCLOAK_AUTH` set, an unauthenticated request to a scoped route is rejected (401).
- Never store passwords, 2FA codes, raw cookies, auth headers, or access tokens. Only user-authorized distributor sessions.
- **No em dashes** (copy or code comments) and **no AI-style / Lucide icons** anywhere.
- Single interactive customer role: `user`. `platform_admin` (ops super-role) and `service_worker` (worker) remain.
- Canonical names introduced here (use verbatim): store class `UserScopedSearchStore`; worker-bound store `UserBoundSearchStore`; principal `SearchPrincipal = { sub: string; roles: string[]; authenticated: boolean }`; record field `userId`; query methods `listForUser(userId)` / `pageForUser(userId, options)`; column `user_id`; index `scan_records_user_created_idx`.

## File Structure (what changes and why)

- `apps/api/src/tenant-scoped-search-store.ts` — the scoping authority. Becomes `UserScopedSearchStore` + `UserBoundSearchStore`; sole rule `userId === sub`.
- `packages/search-store/src/search-store.ts` — `SearchRecord`/`SearchStore` types + in-memory + Redis stores; `user_id`-only scoping.
- `packages/search-store/src/postgres-search-store.ts` — durable store; `user_id` column/index/SQL.
- `apps/api/src/app.ts` — delete org routes/preHandler/helpers; `forPrincipal` returns the user store; scan creation stamps `userId`.
- `apps/api/src/main.ts` — drop `organization` + `tenantErasure` deps.
- `apps/api/src/auth.ts`, `packages/security/src/keycloak-auth.ts` — role set + identity (`sub`).
- `packages/db/*` — delete `organization-repository.ts`, `tenant-erasure.ts`; trim `governance-types.ts`, `index.ts`; rewrite `schema.prisma` + one destructive migration.
- `apps/worker/*`, `packages/persistence/*` — `tenantId` → `userId` in job payloads + writes.
- `docker/keycloak/realm-sentinel.json` — remove org roles/attribute/mappers.
- `apps/web/app/organization/*`, `apps/web/app/_components/SideNav.tsx`, `apps/web/lib/api-client.ts`, `apps/web/lib/auth/server.ts` — remove org UI + selector plumbing.

**Build note:** this is a coordinated cross-layer refactor. The backend build/tests are green only at the END of Task 4 (store + schema + API move together). Do the work on a branch; run the full suite at Task 4 and again at the end.

---

### Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b per-user-auth-isolation
```

Expected: on a new branch off `main`.

---

### Task 1: `UserScopedSearchStore` (the scoping authority)

**Files:**
- Modify: `apps/api/src/tenant-scoped-search-store.ts`
- Modify: `packages/search-store/src/search-store.ts` (SearchRecord/SearchStore types + in-memory store)
- Test: `apps/api/src/search-principal-isolation.test.ts` (rework), `packages/search-store/src/in-memory.test.ts`

**Interfaces:**
- Produces: `export class UserScopedSearchStore` with `constructor(inner: SearchStore, principal: SearchPrincipal)`, methods `get(id)`, `save(input, result, released?)`, `saveDerived(source, patch)`, `update(id, mutate)`, `delete(id)`, `listPage(limit, cursor?)`. Scope rule: a record is visible/writable iff `record.userId === principal.sub` and `hasCustomerScanAccess(principal)`.
- Produces: `export interface SearchPrincipal { sub: string; roles: string[]; authenticated: boolean }`.
- Produces: `SearchRecord.userId: string` (replaces `tenantId`/`ownerUserId`/`artistWorkspaceId`).
- Consumes: `SearchStore.listForUser(userId)`, `SearchStore.pageForUser(userId, options)` (added to the in-memory store in this task).

- [ ] **Step 1: Write failing unit tests for per-user scoping**

In `apps/api/src/search-principal-isolation.test.ts`, replace the org/tenant setup with a pure per-user test against the in-memory store:

```ts
import { describe, it, expect } from 'vitest';
import { InMemorySearchStore } from '@sentinel/search-store';
import { UserScopedSearchStore, type SearchPrincipal } from './tenant-scoped-search-store';

const principal = (sub: string): SearchPrincipal => ({ sub, roles: ['user'], authenticated: true });
const input = (artist: string) => ({ artist, distributor: 'distrokid' as const });
const result = () => ({ tracks: [], warnings: [], summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: new Date().toISOString() });

describe('UserScopedSearchStore isolates by keycloak sub', () => {
  it('a user sees only their own records; another user gets null and an empty list', async () => {
    const inner = new InMemorySearchStore();
    const alice = new UserScopedSearchStore(inner, principal('alice'));
    const bob = new UserScopedSearchStore(inner, principal('bob'));

    const saved = await alice.save(input('Alice KE'), result());
    expect(saved.userId).toBe('alice');

    expect((await alice.get(saved.id))?.id).toBe(saved.id);
    expect(await bob.get(saved.id)).toBeNull();               // cannot read
    expect(await bob.update(saved.id, (r) => r)).toBeNull();  // cannot write
    expect(await bob.delete(saved.id)).toBe(false);           // cannot delete
    expect((await bob.listPage(50)).items).toHaveLength(0);   // not in B's list
    expect((await alice.listPage(50)).items.map((r) => r.id)).toEqual([saved.id]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run apps/api/src/search-principal-isolation.test.ts`
Expected: FAIL (UserScopedSearchStore / SearchPrincipal / saved.userId not defined; listForUser missing).

- [ ] **Step 3: Update the SearchRecord/SearchStore types + in-memory store**

In `packages/search-store/src/search-store.ts`: on `SearchRecord`, remove `tenantId`, `ownerUserId`, `artistWorkspaceId`; add `userId: string`. Remove `ownerOf()` (or make it `record.userId`). Add to the `SearchStore` interface and `InMemorySearchStore`:

```ts
listForUser(userId: string): Promise<SearchSummary[]>;
pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage>;
```

Implement them in `InMemorySearchStore` by filtering `record.userId === userId` (mirror the existing `listForOwner`/`pageForOwner`, then delete those and the tenant/workspace variants). Remove the Redis owner/tenant/workspace indexes in favor of a single `user:<id>` index.

- [ ] **Step 4: Rewrite `UserScopedSearchStore`**

In `apps/api/src/tenant-scoped-search-store.ts`: delete `personalArtistWorkspaceId`, `withoutClientScope` workspace logic, `saveInAuthorizedWorkspace`, and every tenant/workspace/tenantAdmin branch. Define `SearchPrincipal = { sub; roles; authenticated }`, keep `hasCustomerScanAccess(principal)` (unauthenticated test identity OR roles includes `user`). Implement:

```ts
export class UserScopedSearchStore {
  constructor(private readonly inner: SearchStore, private readonly principal: SearchPrincipal) {}
  private owns(record: SearchRecord | null): record is SearchRecord {
    return !!record && hasCustomerScanAccess(this.principal) && record.userId === this.principal.sub;
  }
  async get(id: string) { const r = await this.inner.get(id); return this.owns(r) ? r : null; }
  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]) {
    return this.inner.save({ ...input }, result, released, { userId: this.principal.sub }); // save stamps userId
  }
  async saveDerived(source: SearchRecord, patch: DerivedPatch) {
    if (!this.owns(source)) throw new Error('cannot derive from a record you do not own');
    return this.inner.saveDerived(source, patch); // inherits source.userId
  }
  async update(id: string, mutate: (r: SearchRecord) => SearchRecord) {
    const current = await this.inner.get(id);
    if (!this.owns(current)) return null;
    return this.inner.update(id, mutate);
  }
  async delete(id: string) { const r = await this.inner.get(id); return this.owns(r) ? this.inner.delete(id) : false; }
  async listPage(limit: number, cursor?: string) {
    if (!hasCustomerScanAccess(this.principal)) return { items: [], nextCursor: null };
    return this.inner.pageForUser(this.principal.sub, { limit, cursor });
  }
}
```

Rename `TenantScopedSearchStore` → `UserBoundSearchStore` binding one `userId` (worker path): `get/update/delete` no-op for `record.userId !== boundUserId`. Adjust `SearchStore.save` signature to accept the owner: `save(input, result, released?, owner?: { userId: string })` and default `userId` from `owner` in the concrete stores.

- [ ] **Step 5: Run tests to green**

Run: `npx vitest run apps/api/src/search-principal-isolation.test.ts packages/search-store/src/in-memory.test.ts`
Expected: PASS. (Update `in-memory.test.ts` fixtures that referenced `tenantId`/`ownerUserId` to `userId`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/tenant-scoped-search-store.ts packages/search-store/src apps/api/src/search-principal-isolation.test.ts
git commit -m "feat(auth): scope search store by user_id (keycloak sub) only"
```

---

### Task 2: `PostgresSearchStore` — `user_id` column, index, SQL

**Files:**
- Modify: `packages/search-store/src/postgres-search-store.ts`
- Test: `packages/search-store/src/postgres-search-store.test.ts`

**Interfaces:**
- Consumes: `SearchRecord.userId`, `listForUser`/`pageForUser` (Task 1).
- Produces: `scan_records` contract with `user_id text not null` and index `scan_records_user_created_idx (user_id, created_at desc)`.

- [ ] **Step 1: Update the column/index contract test**

In `postgres-search-store.test.ts`, change the expected `REQUIRED_COLUMNS` to include `user_id` (not null) and drop `tenant_id`/`owner_user_id`/`artist_workspace_id`; expect the single `scan_records_user_created_idx`. Update the cross-owner-upsert test to a cross-`user_id` rejection.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/search-store/src/postgres-search-store.test.ts`
Expected: FAIL (contract still lists tenant columns).

- [ ] **Step 3: Implement**

In `postgres-search-store.ts`: set `REQUIRED_COLUMNS` = `id`, `user_id` (not null), `artist`, `distributor`, `deep_scan_status`, `created_at`, `updated_at`, `record`, plus `revision`; `REQUIRED_INDEXES` = pkey + `scan_records_created_idx` + `scan_records_user_created_idx`. Rewrite `INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE scan_records.user_id = EXCLUDED.user_id` (reject cross-user overwrite → throw "record is owned by another user"). Replace `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` with `listForUser`/`pageForUser` (`WHERE user_id = $1 ORDER BY created_at DESC`). The denormalized `deep_scan_status` column stays.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/search-store/src/postgres-search-store.test.ts`
Expected: PASS (unit-level contract; the `*.integration.test.ts` needs a DB and stays skipped in CI).

- [ ] **Step 5: Commit**

```bash
git add packages/search-store/src/postgres-search-store.ts packages/search-store/src/postgres-search-store.test.ts
git commit -m "feat(db): scan_records keyed by user_id"
```

---

### Task 3: Prisma schema teardown + destructive migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<generated_ts>_per_user_isolation/migration.sql`

- [ ] **Step 1: Enumerate every org/tenant/workspace reference**

Run: `grep -nE "Tenant|Workspace|Organization|Membership|Invitation|tenantId|workspaceId" packages/db/prisma/schema.prisma`
Record every model + field that references them. Do NOT trust a hand-listed set.

- [ ] **Step 2: Rewrite `schema.prisma`**

Delete enums `OrganizationRole`, `WorkspaceRole`, `MembershipStatus` and models `Tenant`, `Workspace`, `OrganizationMembership`, `WorkspaceMembership`, `OrganizationInvitation`, `InvitationWorkspaceGrant`. For every model found in Step 1 (Artist, Release, Track, ScanJob, ConsentGrant, and any others), remove the `tenantId`/`workspaceId` fields + `@relation`s and add `userId String` with `@@index([userId])` (and `@@index([userId, createdAt])` where a "mine, newest" query exists).

- [ ] **Step 3: Generate the migration**

Run: `npx prisma migrate dev --name per_user_isolation --create-only --schema packages/db/prisma/schema.prisma`
Then edit the generated `migration.sql` so it is destructive-and-safe on the fresh DB: `DROP TABLE ... CASCADE` for the org tables; `ALTER TABLE ... DROP COLUMN tenant_id/workspace_id, ADD COLUMN user_id text not null` (no backfill — data is wiped), plus the new indexes and the `scan_records` `user_id` change from Task 2.

- [ ] **Step 4: Validate**

Run: `npx prisma validate --schema packages/db/prisma/schema.prisma` and `npx prisma generate --schema packages/db/prisma/schema.prisma`
Expected: schema valid, client generates.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma
git commit -m "feat(db): per-user schema, drop org/workspace/invitation tables"
```

---

### Task 4: API re-scope + delete org routes/service (backend goes green here)

**Files:**
- Modify: `apps/api/src/app.ts`, `apps/api/src/main.ts`, `apps/api/src/auth.ts`, `apps/api/src/openapi.ts`, `packages/security/src/keycloak-auth.ts`
- Delete: `packages/db/src/organization-repository.ts`, `packages/db/src/tenant-erasure.ts`
- Modify: `packages/db/src/index.ts`, `packages/db/src/governance-types.ts`
- Test: `apps/api/src/tenant-isolation.test.ts` → rename `user-isolation.test.ts`; delete `apps/api/src/organization-routes.test.ts`; update `apps/api/src/auth.test.ts`

**Interfaces:**
- Consumes: `UserScopedSearchStore`, `UserBoundSearchStore`, `SearchPrincipal` (Task 1).

- [ ] **Step 1: Write the failing cross-user isolation test**

Rename `tenant-isolation.test.ts` → `user-isolation.test.ts` and assert, with two distinct authenticated subs (`alice`, `bob`) through the real Fastify app, that every `/api/searches*` verb on Alice's record returns 404/empty for Bob:

```ts
it('Bob cannot read, list, update, delete, rescan, store-check, or lyric-check Alice’s search', async () => {
  const aliceId = (await createSearchAs('alice')).id;
  for (const [method, url] of [
    ['GET', `/api/searches/${aliceId}`],
    ['GET', `/api/searches/${aliceId}/catalogue`],
    ['POST', `/api/searches/${aliceId}/rescan`],
    ['POST', `/api/searches/${aliceId}/store-check`],
    ['POST', `/api/searches/${aliceId}/lyric-check`],
  ] as const) {
    const res = await app.inject({ method, url, headers: bearer('bob'), payload: {} });
    expect([404, 422]).toContain(res.statusCode); // never 200 with Alice's data, never 500
  }
  const list = await app.inject({ method: 'GET', url: '/api/searches', headers: bearer('bob') });
  expect(list.json().searches).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run apps/api/src/user-isolation.test.ts`
Expected: FAIL (compile errors: `deps.organization`, `forPrincipal` org calls, `PrincipalScopedSearchStore`).

- [ ] **Step 3: Rewrite `forPrincipal` + delete the org surface in `app.ts`**

- `forPrincipal(req, reply)` → `return new UserScopedSearchStore(searchStore, { sub: req.auth.sub, roles: req.auth.roles, authenticated: req.auth.authenticated })`. Remove the tenant arg + all `deps.organization` calls + the 503 branch.
- Delete: the org-selection preHandler, `organizationAdministrator`, `authorizeWorkspace` (+ re-point its callers in `/api/consent`, `/api/connect`, `/api/searches`, `/api/distributor-imports/csv` to use `req.auth.sub`), every `/api/organization/*` route, the erasure routes, the `deps.organization` field + guard, the `/api/organization` allowlist entry, and all `x-sentinel-organization-id` / `x-tenant-id`-overwrite handling.
- `governanceActor`/`effectiveTenantId` → a single `userId(req) = req.auth.sub`. Worker/unscoped store binding uses `UserBoundSearchStore(store, userId)`.
- Scan/import creation calls `scoped.save(...)` (stamps `userId`); rescan calls `scoped.saveDerived(...)`.

- [ ] **Step 4: `main.ts`, `auth.ts`, `keycloak-auth.ts`, delete db files**

- `main.ts`: remove the `PostgresOrganizationRepository` construction, the `tenantErasure` runtime, and both from the `buildApp({...})` deps + the `deps` type.
- `auth.ts`/`keycloak-auth.ts`: interactive customer role check = `user`; keep `platform_admin` as super-role for `/api/admin*`/ops. `AuthIdentity` drops `tenantId` (or sets it to `sub` and nothing reads it). `hasAnyRole`/`SENTINEL_ROLES` drop `artist_manager`, `tenant_admin`.
- `openapi.ts`: delete the `/api/organization/*` definitions.
- Delete `packages/db/src/organization-repository.ts`, `packages/db/src/tenant-erasure.ts`; remove their `export *` from `index.ts`; trim `governance-types.ts` to only types still referenced (likely none — remove the file + its export if unused).

- [ ] **Step 5: Delete/rework tests and run the FULL backend suite**

Delete `apps/api/src/organization-routes.test.ts`. Remove org assertions from `auth.test.ts`, `consent-subject-isolation.test.ts`, `search-history-pagination.test.ts`. Then:

Run: `npm run typecheck && npx vitest run --project ./apps/api --project ./packages` (or the repo's test command)
Expected: typecheck 0, all backend tests PASS. Fix every remaining `tenantId`/org reference the compiler flags.

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/db packages/security
git commit -m "feat(auth): per-user API scoping, remove org routes/service/erasure"
```

---

### Task 5: Worker + persistence `tenantId` → `userId`

**Files:**
- Modify: `apps/worker/src/*` (esp. `deep-scan-presence.ts`, `presence-deep-scan-queue.ts`, `main.ts`, `lyrics-verification.ts`), `packages/persistence/src/outcome-repository.ts`, `packages/contracts/src/*` (job schemas), `apps/api/src/app.ts` (enqueue call sites)

**Interfaces:**
- Consumes: `UserBoundSearchStore` (Task 1/4).

- [ ] **Step 1: Sweep**

Run: `grep -rnE "tenantId|tenant_id" apps/worker/src packages/persistence/src packages/contracts/src`
List every job-payload field and write scoped by tenant.

- [ ] **Step 2: Re-point**

Rename the payload/field `tenantId` → `userId` in the presence-deep-scan job schema (`presenceJobSchema`), the lyrics job, and the enqueue call sites in `app.ts`. The worker's `runStorePresenceDeepScan(searchId, deps, expectedUserId)` compares `record.userId === expectedUserId`. `outcome-repository` writes/reads scoped by `userId`.

- [ ] **Step 3: Run the worker tests**

Run: `npx vitest run apps/worker/src packages/persistence`
Expected: PASS (update any fixtures using `tenantId`).

- [ ] **Step 4: Commit**

```bash
git add apps/worker packages/persistence packages/contracts apps/api/src/app.ts
git commit -m "feat(worker): scope jobs and outcome writes by user_id"
```

---

### Task 6: Keycloak realm cleanup

**Files:**
- Modify: `docker/keycloak/realm-sentinel.json`

- [ ] **Step 1: Edit the realm JSON**

Remove realm roles `artist_manager` and `tenant_admin`. Remove the `tenant_id` user-profile attribute and its `sentinel-web` protocol mapper. Remove the Google IdP mappers `google-catalog-manager-role` and `google-personal-tenant`. Add/keep a Google IdP mapper (or realm default-roles entry) that assigns the realm role `user` to new sign-ups. Keep the `loginTheme: "sentinel"` line.

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('docker/keycloak/realm-sentinel.json','utf8')); console.log('valid')"`
Expected: `valid`.

- [ ] **Step 3: Commit**

```bash
git add docker/keycloak/realm-sentinel.json
git commit -m "feat(auth): keycloak realm single user role, drop org claims"
```

---

### Task 7: Frontend removal

**Files:**
- Delete: `apps/web/app/organization/page.tsx`, `apps/web/app/organization/OrganizationManager.tsx`
- Modify: `apps/web/app/_components/SideNav.tsx`, `apps/web/lib/api-client.ts`, `apps/web/lib/auth/server.ts`, `apps/web/lib/api-client.test.ts`

- [ ] **Step 1: Delete + unwire**

Delete the `organization/` route + component. Remove the `/organization` nav entry in `SideNav.tsx`. Strip `ACTIVE_ORGANIZATION_KEY`, `activeOrganizationId`, `selectActiveOrganization`, `ApiRequestInit.organizationId`, the `x-sentinel-organization-id` header, and the `x-sentinel-organization-selection: invalid` recovery from `api-client.ts`. In `auth/server.ts` `sessionDisplayFromAccessToken`, return `{ sub, email, name }` (drop `tenantId`). Remove org cases from `api-client.test.ts`.

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rniE "organization|workspace|invite|tenant|team collaboration" apps/web/app apps/web/lib | grep -v node_modules`
Remove any remaining org/invite/team UI or copy (respecting the no-em-dash rule on any edited copy).

- [ ] **Step 3: Verify web build**

Run: `npm run -w apps/web typecheck && npm run -w apps/web lint && npx vitest run apps/web`
Expected: typecheck 0, lint 0, tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): remove organization/team UI and org-selector plumbing"
```

---

### Task 8: Rollout (destructive) + end-to-end verification

- [ ] **Step 1: Full green gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all green. Fix anything outstanding before touching infra.

- [ ] **Step 2: Rebuild image**

Run: `docker compose build scanner`
Expected: `sentinel-app Built`, exit 0.

- [ ] **Step 3: Wipe volumes (fresh start, approved) + bring up**

```bash
docker compose down
docker volume rm distrokid_postgres-data distrokid_keycloak-db-data   # confirm exact volume names with: docker volume ls | grep distrokid
docker compose up -d
```
Expected: `migrate` applies the per-user schema; Keycloak re-imports the updated realm (single `user` role, `sentinel` login theme).

- [ ] **Step 4: Verify per-user isolation end-to-end**

Sign in as two distinct Google users. Each sees only their own (initially empty) catalogue. Confirm one user cannot reach the other's search id (manually hit `/api/searches/<other-id>` via the BFF → 404). Confirm no `/organization` route exists and the nav has no Organization entry.

- [ ] **Step 5: Final commit + open PR**

```bash
git add -A && git commit -m "chore: per-user isolation rollout notes"
gh pr create --base main --head per-user-auth-isolation --title "Per-user identity and data isolation" --body "Removes orgs/teams/invitations + GDPR erasure; scopes all data by keycloak sub. Destructive migration + volume wipe."
```

---

## Self-Review

**Spec coverage:** §1 data model → Tasks 2,3; §2 search-store → Task 1; §3 API → Tasks 4,5; §4 Keycloak → Task 6; §5 frontend → Task 7; §6 testing → Tasks 1,4 (+ deletions); §7 rollout → Task 8. Identity model + global constraints → carried in the header + Task 1/4 role checks. No gaps.

**Placeholders:** the only `<...>` tokens are Prisma's generated migration timestamp and a git branch/PR — both concrete conventions, not deferred work.

**Type consistency:** `UserScopedSearchStore`, `UserBoundSearchStore`, `SearchPrincipal { sub, roles, authenticated }`, `SearchRecord.userId`, `listForUser`/`pageForUser`, column `user_id`, index `scan_records_user_created_idx` are used identically across Tasks 1-4.
