# Per-User Identity & Data Isolation (remove orgs/teams) - Design Spec

**Date:** 2026-08-29
**Status:** Approved design, pending implementation-plan.

## Goal

Every authenticated user has their own identity and can access **only their own** searches and data. Remove the organization / workspace / invitation / team-collaboration subsystem entirely, and remove the GDPR tenant-erasure feature. Fresh start: existing app data is wiped (approved), so migrations are destructive and need no data preservation.

## Global constraints (apply to every task)

- **Isolation is the whole point.** After this change, an authenticated user MUST NOT be able to read, list, mutate, or delete another user's searches/data through any route. Missing/foreign records return 404/empty (anti-enumeration), never another user's data and never a 500.
- **Security/compliance rules stay in force:** use only user-authorized distributor sessions; never collect/store passwords or 2FA codes; never store raw cookies/auth headers/tokens; never bypass CAPTCHA/account controls; do not enumerate other users' release IDs.
- **No em dashes, no AI-style icons** anywhere (copy or comments), per the standing project rule.
- Fail-closed auth: with `ENABLE_KEYCLOAK_AUTH` set, an unauthenticated request to a scoped route is rejected.

## Identity model (target)

- The Keycloak **`sub`** (stable per user, including Google-federated) is the sole user identifier. No app-side user table is introduced.
- **One interactive role: `user`.** `artist_manager` and `tenant_admin` are removed. `platform_admin` (ops) and `service_worker` (worker service account) remain.
- Every data row is owned by exactly one **`user_id = sub`**. There are no tenants, workspaces, organizations, memberships, invitations, or sharing.

---

## 1. Data model (`packages/db`)

**Prisma schema (`packages/db/prisma/schema.prisma`):**
- **Remove enums:** `OrganizationRole` (~24-30), `WorkspaceRole` (~32-37), `MembershipStatus` (~39-42).
- **Remove models:** `Tenant` (~78-90), `Workspace` (~109-136), `OrganizationMembership` (~140-154), `WorkspaceMembership` (~156-172), `OrganizationInvitation` (~175-196), `InvitationWorkspaceGrant` (~198-210).
- **Re-point every model that FK'd `Tenant`/`Workspace`** to a single indexed `userId String` column and drop the `tenantId`/`workspaceId` fields + relations. Known referrers: `Artist`, `Release`, `Track`, `ScanJob`, `ConsentGrant`. **Implementation step: grep the schema for every `tenantId`/`workspaceId`/`Tenant`/`Workspace` reference and re-point ALL of them** (do not rely on this list being exhaustive).
- Add an index on `userId` (and `(userId, createdAt)` where a "list mine, newest first" query exists).

**`scan_records` table (`packages/search-store/src/postgres-search-store.ts`):**
- Collapse `tenant_id` + `owner_user_id` + `artist_workspace_id` into a single **`user_id text not null`** column.
- Replace indexes `scan_records_tenant_owner_created_idx` and `scan_records_tenant_workspace_created_idx` with one `scan_records_user_created_idx` on `(user_id, created_at desc)`.
- Update `REQUIRED_COLUMNS` / `REQUIRED_INDEXES` (~lines 29-48) and the `upsert` / query SQL accordingly.

**Migration (`packages/db/prisma/migrations/<ts>_per_user_isolation/migration.sql`):**
- Destructive: drop the org tables + FKs, drop `tenant_id`/`workspace_id` columns, add `user_id` columns + indexes. No data backfill (fresh start). App Postgres is wiped on rollout.
- Delete the now-obsolete governance migration content only by superseding it with the new migration (do not rewrite history of applied migrations; add a new forward migration).

**Delete files:** `packages/db/src/organization-repository.ts`, `packages/db/src/tenant-erasure.ts`. Remove their exports from `packages/db/src/index.ts` (~line 14). Trim `packages/db/src/governance-types.ts` to drop org/workspace/invitation types (keep `GovernanceActor` only if still used; otherwise remove).

---

## 2. Search-store re-scoping (`packages/search-store`, `apps/api/src/tenant-scoped-search-store.ts`)

- **`PrincipalScopedSearchStore` → `UserScopedSearchStore`** (`tenant-scoped-search-store.ts:145-338`): the ONLY scoping rule is `record.userId === principal.sub`. Delete `workspaceAccess`, `tenantAdmin`, `unverifiedTestIdentity`-as-tenant, and all tenant/workspace branches. `save` stamps `userId = principal.sub`. `saveDerived` inherits the source `userId`. Remove `saveInAuthorizedWorkspace` (folds into `save`). Remove `personalArtistWorkspaceId` / `withoutClientScope` workspace logic.
- **`PostgresSearchStore`** (`postgres-search-store.ts`): replace `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` with `listForUser`/`pageForUser` (`WHERE user_id = $1`). Remove tenant/workspace query paths. Update `upsert` conflict guard to key on `(id)` with a `user_id` cross-owner rejection (a record owned by a different user cannot be overwritten).
- **In-memory + Redis stores** (`packages/search-store/src/search-store.ts`, redis client): mirror the `user_id`-only scoping (owner index by user_id; drop tenant/workspace indexes).
- **`TenantScopedSearchStore`** (worker/queue path, `tenant-scoped-search-store.ts:50-91`): rename to `UserBoundSearchStore` binding one `userId`; `get`/`update`/`delete` return null/false for a different user.

## 3. API re-scoping (`apps/api/src`)

**`app.ts`:**
- **`forPrincipal` (1156-1186):** return `new UserScopedSearchStore(searchStore, principal)` directly. Remove all `deps.organization` calls and the 503 branch.
- **Delete:** org-selection preHandler (371-459), `organizationAdministrator` (460-477), `authorizeWorkspace` (478-524) and re-point its call sites (`/api/consent` ~796, `/api/connect` ~1736, `/api/searches` ~1113, `/api/distributor-imports/csv` ~1900) to scope by `sub` directly. Delete every `/api/organization/*` route (526-780) and the erasure routes. Remove the `deps.organization` field + guard (119, 158-160) and the `/api/organization` allowlist entry (179).
- **Remove `x-sentinel-organization-id`** handling (211-213, 270-271, 288, 325-326) and the `x-tenant-id` overwrite semantics - the principal is `sub`.
- **`governanceActor`/`effectiveTenantId` (322-343):** replace with a single `userId = req.auth.sub` accessor (`GovernanceActor` becomes `{ userId }` or is inlined).
- Scan/consent/connect/csv creation stamps `user_id = sub`; the worker path preserves the record's existing `user_id`.

**`main.ts` (14, 48, 62):** drop the `PostgresOrganizationRepository` construction + injection and the `tenantErasure` runtime.

**`auth.ts` / `packages/security/src/keycloak-auth.ts`:** interactive-role set becomes `['user','platform_admin']` (or `['user']` for customer routes; `platform_admin` stays a super-role for ops). `identityFromPayload` already defaults identity to `sub`; drop the `tenantId` concept from `AuthIdentity` (or set `tenantId = sub` and stop reading it). `hasCustomerScanAccess` requires `user`.

**`openapi.ts` (16-90):** remove org route definitions.

**Worker / persistence (`apps/worker`, `packages/persistence`):** any job payload or write scoped by `tenantId` (e.g. the presence deep-scan job `{ searchId, tenantId }`, DistroKid outcome writes) becomes `{ searchId, userId }` / scoped by `userId`. Sweep `apps/worker` + `packages/persistence` for `tenantId` and re-point to `userId`.

## 4. Keycloak realm (`docker/keycloak/realm-sentinel.json`)

- Remove realm roles `artist_manager` (24) and `tenant_admin` (25). Keep `user`, `platform_admin`, `service_worker`.
- Remove the `tenant_id` user-profile attribute (14) and its `sentinel-web` protocol mapper (44-55).
- Remove the Google IdP mappers `google-catalog-manager-role` (assigns `artist_manager`) and `google-personal-tenant` (maps sub→tenant_id) (~127-143); add/keep a mapper that assigns the default role **`user`** to Google sign-ups.
- The `sentinel` login theme (`loginTheme`) is already in the realm JSON, so a fresh import preserves it.
- Applied on rollout by wiping `keycloak-db` and re-importing (`--import-realm`).

## 5. Frontend (`apps/web`)

- Delete `app/organization/page.tsx` + `app/organization/OrganizationManager.tsx`. Remove the `/organization` nav entry (`_components/SideNav.tsx:26`).
- Strip org-selector plumbing from `lib/api-client.ts` (10-100): `ACTIVE_ORGANIZATION_KEY`, `activeOrganizationId`, `selectActiveOrganization`, `ApiRequestInit.organizationId`, the `x-sentinel-organization-id` header, and the `x-sentinel-organization-selection: invalid` recovery.
- `lib/auth/server.ts` `sessionDisplayFromAccessToken` (311-329): identity display = email/`sub`; drop tenant/org fields.
- Remove any remaining "invite" / "team" / "organization" copy or UI across the app (grep `organization|invite|workspace|tenant|team`).

## 6. Testing

**Add / keep (per-user isolation is the core guarantee):**
- User A cannot read, list, update, delete, rescan, store-check, or lyric-check user B's search (→ 404/empty, never B's data, never 500).
- `GET /api/searches` returns only the caller's records; history pagination stays owner-scoped.
- Scan/import creation stamps `user_id = sub`; the worker preserves it.
- `UserScopedSearchStore` unit tests: `canRead/canWrite` true only for own `userId`.
- `postgres-search-store` column/index contract for `user_id`; cross-user upsert rejection.

**Remove:** `organization-routes.test.ts`, `packages/db/src/governance.integration.test.ts`, `packages/db/src/tenant-repo.test.ts` (org parts), org-selector cases in `apps/web/lib/api-client.test.ts`.
**Rework:** `tenant-isolation.test.ts` → `user-isolation.test.ts`; `search-principal-isolation.test.ts` stays (already per-`sub`) with org references removed.

## 7. Rollout (destructive)

1. Land code + schema + realm changes; `npm run typecheck`, full test suite, lint all green.
2. New Prisma migration generated and checked in.
3. Wipe app Postgres volume + `keycloak-db` volume (fresh start, approved).
4. `docker compose up` → `migrate` applies the new schema; Keycloak re-imports the updated realm.
5. Rebuild `sentinel-app`, redeploy.
6. Verify: two distinct Google users each sign in, each sees only their own (empty→populated) catalogue; cross-user access is impossible.

## Out of scope (YAGNI)

- No app-side user/profile table (the `sub` is the identity).
- No re-introduction of any sharing, roles hierarchy, or erasure.
- No data migration (fresh start).
