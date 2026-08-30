# Task 4b report — API re-scope, delete org/erasure, whole-backend green

Status: **DONE_WITH_CONCERNS** (all hard gates green; one bounded, documented deviation on the
DistroKid live-connect pipeline's internal `artistWorkspaceId` slot — see Concerns).

## Green gate (verified)

- `npm run typecheck`: **fully clean for the WHOLE repo** (root `tsc -p tsconfig.json` + `apps/web` tsc). 0 errors.
- `npx vitest run`: **762 passed, 52 skipped, 0 failed** (all `*.integration.test.ts` stay skipped without infra).
- `npm run lint`: clean (`eslint . --max-warnings 0` for root and web).
- `apps/api/src/user-isolation.test.ts` proves Bob cannot reach Alice's search on any verb (read / list / catalogue / manual-review / rename / delete / rescan / store-check / lyrics-check / track-marks) — always 404/409/422, never 200 with Alice's data, never 500; Bob's list is empty; and a token with an empty `sub` is refused (401) so it can never be treated as an owner.

## A. `apps/api/src/app.ts`

- Imports: dropped `personalArtistWorkspaceId`, `PrincipalScopedSearchStore`, `TenantScopedSearchStore`; added `UserScopedSearchStore`, `UserBoundSearchStore`. Reduced the `@sentinel/db` import to only `DistroKidRecoveryAlreadyTerminalError` + `PostgresDistroKidRecoveryRepository` (all governance/org/erasure types removed).
- `AppDeps`: removed `organization` and `tenantErasure` fields; deleted the `publicErasureRequest` helper; renamed the `enqueueDeepScan`/`enqueueLyricsCheck` seam param to `userId`.
- Deleted the two constructor guards that threw when `deps.organization`/`deps.tenantErasure` were absent.
- Deleted the `/api/organization` allowlist prefix entry; removed `x-sentinel-organization-id` from CORS allow/expose headers and the OPTIONS allow-list; removed the `x-sentinel-organization-selection` expose header.
- Rate limiter: dropped the `x-sentinel-organization-id`/`tenantId` reads; the bucket key is now the verified subject alone.
- **Deleted**: the org-selection `preHandler`, `effectiveTenantId`, `tenantOf`, `governanceActor`, `organizationContexts`/`tenantContexts`, `governanceFailure`, `validIdentifier`, `organizationAdministrator`, `authorizeWorkspace`, every `/api/organization/*` route, and both erasure routes.
- Added one accessor `requireSubject(req, reply)` — the **`req.auth.sub` non-empty guard** (Task 1 minor): returns the trimmed subject or replies 401 and returns null. Used by the consent/connect/csv routes; `forPrincipal` carries the same guard inline.
- `forPrincipal(req, reply)` now `-> new UserScopedSearchStore(searchStore, { sub, roles, authenticated })` (no tenant argument, no `deps.organization`, no 503 branch), returning null after 401 when `sub` is empty.
- Scan/import creation uses `scoped.save(...)` (stamps `userId`); the rescan route uses `scoped.saveDerived(source, patch)` with `result`+`released` folded into the patch (**the deferred `saveDerived` wiring**).
- Every `governanceActor(req).tenantId`/`effectiveTenantId(req)`/`activeTenantId` scope value is now `req.auth.sub`; the worker/unscoped store binding in `enqueueDeepScan` uses `new UserBoundSearchStore(searchStore, userId)`. All `req.auth.tenantId` reads gone.
- Role policy: every `requireRole('user','artist_manager','tenant_admin')` -> `requireRole('user')`; every ops `requireRole('tenant_admin','platform_admin')` -> `requireRole('platform_admin')`. Consent-revocation / connect scan+cancel `allowTenantAdmin` is now `false` (owner-only; no tenant-admin override).
- `GET /api/searches` returns `{ searches: page.items }` (the new store returns `{ items, nextCursor }`).
- Consent grant route: no longer reads a body `tenantId`/`artistWorkspaceId`; `ctx = { tenantId: req.auth.sub }`; grants for the subject directly.

## B. `apps/api/src/main.ts`

- Removed the `PostgresOrganizationRepository` construction, the `createLocal/ProductionTenantErasureRequestRuntime` runtime + `verifyReady`, and both from the `buildApp({...})` deps + `closeAudit`. Trimmed the now-unused `isProductionEnvironment` / `GovernanceSqlPool` imports.

## C. `apps/api/src/auth.ts` + `packages/security/src/keycloak-auth.ts`

- `SENTINEL_ROLES = ['user','platform_admin','service_worker']`; `SENTINEL_INTERACTIVE_ROLES = ['user','platform_admin']` (dropped `artist_manager` and `tenant_admin`).
- `identityFromPayload`: `tenantId: sub` — a signed `tenant_id` claim is now ignored (kept the field equal to `sub` so structural consumers keep compiling; nothing derives authority from it). The empty-`sub` throw already existed and is the source-of-truth guard.
- `auth.ts`: deleted the `req.headers['x-tenant-id'] = req.auth.tenantId` overwrite.
- `hasCustomerScanAccess` already requires `user` (or the unauthenticated test identity) — unchanged in Task 1.

## D. `apps/api/src/openapi.ts`

- Deleted all `/api/organization/*` path definitions and the `OrganizationMembershipUpdate` / `WorkspaceMembershipGrant` / `IssueOrganizationInvitation` / `AcceptOrganizationInvitation` / `RequestTenantErasure` schemas. `CreateCatalogSearch` no longer requires/lists `artistWorkspaceId`. Updated the doc description + the `GET /api/searches` summary to per-user language.

## E. Delete files + exports — DEVIATION (see Concerns)

- Left `packages/db` untouched. `packages/db/src/organization-repository.ts` and `tenant-erasure.ts` were **not** deleted: `apps/worker/src/main.ts` still depends on the governance/erasure cluster via `ProductionGovernanceMaintenanceService` (`governance-service.ts -> tenant-erasure.ts -> governance-types.ts`), and `organization-repository.ts` is pulled in by `governance-runtime.ts`. Deleting them cascades into `governance-runtime/adapters/service` + `retention`/`audit-chain` and 4 passing db test suites, none of which are in Task 4b's file list. After decoupling `apps/api` (B), that cluster is compiled-but-unused by the per-user API and its behavior is unchanged. The one small db change made: `LinkConsent.artistWorkspaceId` is now optional (it lives in a JSON blob, no migration) so `distributor-link.ts` can omit it; the in-memory revocation-intent construction coalesces it to `''`.

## F. Strip vestigial workspace scoping

- `apps/worker/src/distrokid/principal-binding.ts`: removed `artistWorkspaceId` from `SnapshotPrincipalBinding`, dropped the `job.artistWorkspaceId` requirement and the `consent.artistWorkspaceId === job.artistWorkspaceId` comparison. Kept the per-user chain (`ownerOf(record) === job.tenantId`, `consent.tenantId === job.tenantId`, `consent.grantedByUserId === record.userId`) + scope/provider/expiry/not-revoked checks.
- `apps/worker/src/distrokid/composition.ts`: dropped `artistWorkspaceId` from the `consentActive` port type and the `assertConsentActive` job/binding.
- `apps/api/src/distributor-link.ts`: `grantConsent` and `assertReadConsent` no longer take/set/compare `artistWorkspaceId`; removed the workspace `workspaceId` fields from the consent audit entries.
- `/api/consent` + `/api/connect` route code no longer sets `artistWorkspaceId` (the connect route omits it entirely; `DistributorConnect.start` defaults its internal binding slot to `ownerUserId`).
- **Not** stripped: `packages/contracts` job schemas (`snapshotRefSchema.artistWorkspaceId` is optional; `deepScanJobSchema.artistWorkspaceId`) and the DistroKid live-connect/snapshot pipeline inside `distributor-connect.ts`. See Concerns.

## G. Tests

- Renamed `tenant-isolation.test.ts` -> **`user-isolation.test.ts`**, rewritten to the two-subject cross-access assertions through the real Fastify app: `bearer(sub)` mints an RS256 token whose subject is the scope; `createSearchAs('alice')` POSTs a real create; Bob is denied on every verb and sees an empty list; an empty-`sub` token is rejected 401.
- **Deleted** `organization-routes.test.ts`.
- Rewrote `search-history-pagination.test.ts` (per-user: alice 225 / bob 3 / carol 2, `store.put({ ...userId })`, `delete(id, userId)`, removed the tenant/tenant-admin cross-scope tests), `consent-subject-isolation.test.ts` (consent partitioned by the owner sub, owner-only revocation, `user` role), and updated `scan-history.test.ts` (records stamped `{ userId: 'anonymous' }` / a foreign owner, `listForUser`, enqueue owner assertions), `distributor-connect.test.ts` (`listForOwner` -> `listForUser`), `distributor-link.test.ts` (no `artistWorkspaceId`), `principal-binding.test.ts` (no workspace substitution case), `search-principal-isolation.test.ts` (full `CatalogResultLike` fixture), `auth.test.ts` + `keycloak-auth.test.ts` (roles/`tenantId===sub`, no header overwrite), and `app.test.ts` (asserts the org OpenAPI paths are absent).
- **Folded in a Task-4a test follow-through**: `health.test.ts`'s `healthySchemaRows` still described the old `tenant_id`/`owner_user_id`/`artist_workspace_id` scan_records contract, but `assertScanRecordsSchema` (committed at HEAD) now requires `user_id` + `scan_records_user_created_idx`. This made all 6 remaining health tests fail at HEAD. Updated the fixture + the column/index test to the migrated per-user schema.

## Concerns

1. **DistroKid live-connect pipeline retains an internal `artistWorkspaceId` slot** (`distributor-connect.ts` `DurableConnectSession`/`ConnectConsentBinding`/`createSession`/snapshot job + the optional `authorizeWorkspaceEdit` hook + `snapshotRefSchema.artistWorkspaceId` in `packages/contracts` + the worker snapshot persistence). Fully removing it cascades through `@sentinel/browser-link`'s `createSession`, the cross-app wire contract, `snapshot-store.ts`/`pipeline.ts`, and ~6 worker/queue tests — none in Task 4b's E/F file lists, and a real risk to the test gate. It is no longer an authorization boundary (principal-binding no longer checks it) and at the API boundary is now populated from `req.auth.sub`. The `apps/api/src` grep exceptions are all in this cluster (plus comments, the `ConnectWorkspaceAuthorization*Error` names, and the `security_audit_events.workspace_id` audit-table column check in `health.ts`).
2. **`packages/db` org/erasure cluster left intact** for the worker dependency reason in section E. The per-user API constructs none of it.
