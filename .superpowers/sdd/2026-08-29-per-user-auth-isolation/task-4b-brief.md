# Task 4b brief — API re-scope, delete org/erasure, whole-backend green

This is the largest task. It finishes the backend: re-scope `apps/api` to per-user, delete the organization/workspace/invitation/erasure surface, and get the WHOLE repo to `npm run typecheck` clean with all tests passing. Tasks 1-4a already did the store, schema, persistence, and worker. There are currently ~55 typecheck errors confined to `apps/api`; this task closes them all.

## Global constraints

- Isolation is the security guarantee: after this task, a user reaches ONLY records where `record.userId === req.auth.sub`. Every scoped route funnels through the per-user store. Foreign/missing records return 404/empty, never 500, never another user's data.
- Single interactive customer role `user` (keep `platform_admin` for ops, `service_worker` for the worker). No em dashes / AI icons.

## Interfaces you consume (already implemented)

- `apps/api/src/tenant-scoped-search-store.ts`: `UserScopedSearchStore(inner, principal: SearchPrincipal { sub, roles, authenticated })` with `get/save/saveDerived/update/delete/listPage`; `UserBoundSearchStore(inner, userId)` for the worker/unscoped path. `hasCustomerScanAccess(principal)`.
- `SearchRecord.userId`; store `listForUser`/`pageForUser`; `save(input, result, released?, owner?: { userId })`.

## The work (all of it)

### A. `apps/api/src/app.ts`
- `forPrincipal(req, reply)` -> `return new UserScopedSearchStore(searchStore, { sub: req.auth.sub, roles: req.auth.roles, authenticated: req.auth.authenticated })`. Remove the tenant argument, ALL `deps.organization` calls, and the 503 "organization service unavailable" branch.
- DELETE: the org-selection preHandler; `organizationAdministrator`; `authorizeWorkspace` and re-point its callers in `/api/consent`, `/api/connect`, `/api/searches`, `/api/distributor-imports/csv` to scope by `req.auth.sub` directly (no workspace); every `/api/organization/*` route; the erasure routes; the `deps.organization` field + the constructor guard that throws when it is absent; the `/api/organization` allowlist prefix entry; and ALL `x-sentinel-organization-id` handling and the `x-tenant-id` header-overwrite.
- `governanceActor`/`effectiveTenantId` -> a single accessor `const userId = req.auth.sub` used wherever a scope value was needed. The worker/unscoped store binding uses `new UserBoundSearchStore(searchStore, userId)`.
- Scan/import creation uses `scoped.save(...)` (stamps `userId`); the rescan route uses `scoped.saveDerived(source, patch)` (the store method exists from Task 1 — wire the call).
- Any `req.auth.tenantId` reads -> `req.auth.sub`.

### B. `apps/api/src/main.ts`
- Remove the `PostgresOrganizationRepository` construction, the `tenantErasure` runtime, and both from the `buildApp({...})` deps object and the `deps` type.

### C. `apps/api/src/auth.ts` + `packages/security/src/keycloak-auth.ts`
- Interactive customer role check = `user`; keep `platform_admin` as ops super-role. Drop `artist_manager` and `tenant_admin` from `SENTINEL_ROLES` / `SENTINEL_INTERACTIVE_ROLES` / any role list. `AuthIdentity`: drop `tenantId` (or set it equal to `sub` and stop reading it anywhere). `hasCustomerScanAccess` requires `user` (or the unauthenticated test identity).
- **Guard: `req.auth.sub` must be a non-empty string on any scoped route** (a principal with an empty sub must not be treated as an owner — reject with 401, or ensure `identityFromPayload` throws on empty `sub`). This closes the Task 1 minor.

### D. `apps/api/src/openapi.ts`
- Delete the `/api/organization/*` path definitions and any org schemas.

### E. Delete files + exports
- Delete `packages/db/src/organization-repository.ts` and `packages/db/src/tenant-erasure.ts`; remove their `export *` lines from `packages/db/src/index.ts`; trim `packages/db/src/governance-types.ts` to only types still imported (if none remain, delete the file + its export). Delete the vestigial `TenantErasureRequest`/`TenantErasureStep` Prisma models from `schema.prisma` IF nothing else references them (and add the DROP to the existing per-user migration); if that is non-trivial, leave the models and note it.

### F. Strip vestigial workspace scoping (the Task 4a Important finding)
- Remove `artistWorkspaceId` from the job payload schema in `packages/contracts` (the presence/lyrics job), from the `/api/consent` + `/api/connect` code that set it, and from `apps/worker/src/distrokid/principal-binding.ts`'s workspace check + any `consent.artistWorkspaceId` comparison. Workspaces no longer exist; the user boundary (record.userId + consent user) is the only scope. Keep the consent's per-user + scope + not-revoked checks.

### G. Tests
- Rename `apps/api/src/tenant-isolation.test.ts` -> `apps/api/src/user-isolation.test.ts` and rewrite it to the two-user cross-access assertions (below). DELETE `apps/api/src/organization-routes.test.ts`. Remove org/workspace assertions from `auth.test.ts`, `consent-subject-isolation.test.ts`, `search-history-pagination.test.ts`, and any other test the compiler flags. Keep `search-principal-isolation.test.ts` (already per-user from Task 1).

The core new test (`user-isolation.test.ts`) must assert, with two distinct authenticated subs (`alice`, `bob`) through the real Fastify app, that Bob cannot reach Alice's search on ANY verb:

```ts
it('Bob cannot read, list, update, delete, rescan, store-check, or lyric-check Alice\'s search', async () => {
  const aliceId = (await createSearchAs('alice')).id;
  for (const [method, url] of [
    ['GET', `/api/searches/${aliceId}`],
    ['GET', `/api/searches/${aliceId}/catalogue`],
    ['POST', `/api/searches/${aliceId}/rescan`],
    ['POST', `/api/searches/${aliceId}/store-check`],
    ['POST', `/api/searches/${aliceId}/lyric-check`],
  ] as const) {
    const res = await app.inject({ method, url, headers: bearer('bob'), payload: {} });
    expect([404, 422, 409]).toContain(res.statusCode); // never 200 with Alice's data, never 500
  }
  const list = await app.inject({ method: 'GET', url: '/api/searches', headers: bearer('bob') });
  expect(list.json().searches ?? []).toHaveLength(0);
});
```
Use the existing test harness's way of building an authenticated request for a given sub (look at how `auth.test.ts` / `search-principal-isolation.test.ts` / the deleted `tenant-isolation.test.ts` built identities and reuse that mechanism; if auth is disabled in the test runtime, use whatever header/identity injection the existing tests use to set `req.auth.sub`).

## Steps

1. Read `apps/api/src/app.ts` (esp. `forPrincipal`, the org routes/helpers/preHandler, the scoped route handlers), `main.ts`, `auth.ts`, `packages/security/src/keycloak-auth.ts`, and the tests named above before editing.
2. Do A-F. Run `npm run typecheck` repeatedly and drive the apps/api errors to zero. Then G.
3. Full green gate: `npm run typecheck` (0), `npx vitest run` (all pass; integration `*.integration.test.ts` stay skipped without infra), and `npm run lint` if quick.
4. Commit: `git add -A && git commit -m "feat(auth): per-user API scoping; remove org/workspace/invitation/erasure"` (append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Do NOT push.

## Green signal

`npm run typecheck` is clean for the WHOLE repo, `npx vitest run` passes (unit; integration skipped), the new `user-isolation.test.ts` proves cross-user access is impossible, and grep shows no remaining `organization`/`workspace`/`invitation`/`artistWorkspaceId`/`x-sentinel-organization-id` in `apps/api/src` (except unavoidable string literals you can justify). Do NOT dispatch subagents.
