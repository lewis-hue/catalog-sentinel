# Task 1 report — `UserScopedSearchStore` (the per-user scoping authority)

Branch: `per-user-auth-isolation`
Commit: `4ee30c5` — `feat(auth): scope search store by user_id (keycloak sub) only`

## Summary

Rewrote the search-store scoping layer so the only rule is `record.userId === principal.sub`.
All tenant/workspace/ownerUserId vocabulary is gone from the two files in scope. Both target
vitest files pass. `packages/search-store` does not typecheck standalone, but every error is
confined to files this task was explicitly told not to touch (postgres/tiered store + their
tests, all Task 2 territory) — none of the errors are in `search-store.ts` or either test file.

## Files changed

### `packages/search-store/src/search-store.ts` (modified)

- `SearchInput`: removed `tenantId`, `ownerUserId`, `artistWorkspaceId`. It now carries only
  content fields (`name`, `sourceSearchId`, `artist`, `distributor`, `platforms`, `song`).
  Ownership is no longer smuggled through the input object at all.
- `SearchRecord`: removed the same three fields, added `userId: string` (required, not
  optional — every record has exactly one owner).
- `SearchSummary`: `ownerUserId`/`artistWorkspaceId` replaced with `userId: string`.
- `ownerOf()`: kept (not deleted) but reduced to `(r) => r.userId`. Two out-of-scope worker
  files (`apps/worker/src/distrokid/principal-binding.ts`,
  `apps/worker/src/deep-scan-presence.ts`) import `ownerOf` from this package; keeping it with a
  compatible signature (`Pick<SearchRecord, 'userId'> => string`) means those two files keep
  compiling even though I never touched them. This was a judgment call, not mandated by the
  brief, but it was free (no scope-rule change) and it visibly shrinks the blast radius.
- `DEFAULT_TENANT` removed. It was a tenant-quarantine concept; with tenants gone there's
  nothing to quarantine into. `newRecord()` now defaults an ownerless record's `userId` to `''`
  when no `owner` is passed, rather than to a namespace string.
- `toSummary()`, `newRecord()`, `applySearchMutation()`, `assertSameSecurityScope()`: updated to
  the single `userId` field. `applySearchMutation` still treats `userId` (like `id`/`createdAt`)
  as immutable identity that a mutator callback cannot override — same guarantee as before, just
  on one field instead of three.
- `SearchStore` interface:
  - `save(input, result, released?, owner?: { userId: string })` — new 4th optional `owner` arg,
    exactly as specified.
  - `listForTenant`/`listForOwner`/`pageForTenant`/`pageForOwner` deleted, replaced by
    `listForUser(userId)` / `pageForUser(userId, options)`.
  - `delete(id, userId?)` — was `delete(id, tenantId?, ownerUserId?)`.
- `InMemorySearchStore`: reimplemented all of the above; `listForUser`/`pageForUser` filter on
  `record.userId === userId`.
- `RedisSearchStore`: collapsed the tenant index + tenant/owner composite index into a single
  `search:user:<id>:index` list (per the brief: "Redis: a single `user:<id>` index"). The
  `REDIS_DELETE_WITH_INDEXES` Lua call now always takes exactly 3 keys (record key, global
  index, user index) instead of conditionally 3 or 4.

### `apps/api/src/tenant-scoped-search-store.ts` (modified, effectively rewritten)

- `TenantScopedSearchStore` → `UserBoundSearchStore`. Constructor `(inner, userId: string)`.
  Same shape as before (`save`, `get`, `list`, `listPage`, `update`, `delete`), just scoped by
  `record.userId !== boundUserId` instead of `ownerOf(record) !== tenantId`. This is the
  worker/queue-bound class; `app.ts`'s `enqueueDeepScan` currently constructs the old
  `TenantScopedSearchStore(searchStore, tenantId)` — that call site is Task 4's job to update to
  `UserBoundSearchStore(searchStore, userId)`.
- `SearchPrincipal`: now exactly `{ sub: string; roles: string[]; authenticated: boolean }` (the
  `tenantId` field is gone).
- `hasCustomerScanAccess(principal)`: unchanged shape, but the role check is now
  `principal.roles.includes('user')` (dropped `artist_manager` / `tenant_admin`, per the design
  spec's single-interactive-role model). Unauthenticated identity still passes (`!authenticated
  -> true`), same as before.
- Deleted entirely: `personalArtistWorkspaceId`, `withoutClientScope`, `saveInAuthorizedWorkspace`,
  `PrincipalWorkspaceAccess`, and every `tenantAdmin`/`workspaceAccess`/`unverifiedTestIdentity`
  branch in the old `PrincipalScopedSearchStore`.
- `PrincipalScopedSearchStore` → `UserScopedSearchStore`. The scope rule is now a single `owns()`
  predicate:
  ```ts
  private owns(record: SearchRecord | null): record is SearchRecord {
    return record !== null && hasCustomerScanAccess(this.principal) && record.userId === this.principal.sub;
  }
  ```
  No bypass for the unauthenticated/test identity or for any role: an unauthenticated caller can
  still pass the *access gate* (`hasCustomerScanAccess`), but ownership is checked identically
  for everyone, exactly as the brief states ("Scope rule everywhere: ... iff
  `hasCustomerScanAccess(principal)` AND `record.userId === principal.sub`"). This is a
  deliberate change from the old code, which let `unverifiedTestIdentity` and `tenantAdmin`
  bypass ownership entirely — the brief's design spec calls that bypass out by name as something
  to delete ("`unverifiedTestIdentity`-as-tenant").
  - `save(input, result, released?)` → `inner.save(input, result, released, { userId:
    principal.sub })`.
  - `saveDerived(source, patch)` → throws `'search source is outside the editable principal
    scope'` if `!owns(source)`, else calls `inner.save(...)` with `{ userId: source.userId }` so
    the derived record inherits the source's owner. **Signature deviation, explained below.**
  - `get`/`update`/`delete` guard on `owns`.
  - `listPage(limit, cursor?)` returns `{ items, nextCursor? }` — **not** `{ searches,
    nextCursor? }` like the old code. This matches the brief's literal test
    (`(await alice.listPage(50)).items`), not the old shape.
  - Cursor signing/verification (HMAC-signed opaque pagination cursor) is preserved, just
    simplified: `historyCursorScope` now hashes only `principal.sub` (previously it also mixed in
    tenant id and/or workspace ids for the tenant-admin/workspace-reader cases, which no longer
    exist).

## Deviation: `saveDerived(source, patch)` signature

The task-1-brief's "Interfaces produced" section states the method as `saveDerived(source,
patch)` (two args). The companion plan doc (`docs/superpowers/plans/...md`) sketches it as
`saveDerived(source: SearchRecord, patch: DerivedPatch) { return this.inner.saveDerived(source,
patch); }` — i.e. it implies `SearchStore` itself grows a `saveDerived` method. I did not add
`saveDerived` to the `SearchStore` interface, because:

- The brief's own "Interfaces produced" list (the section it calls out as canonical, "later
  tasks depend on these EXACT shapes") only adds `owner?` to `SearchStore.save` — it does not
  mention `SearchStore.saveDerived` anywhere.
- The literal test code the brief gives verbatim never calls `saveDerived` at all, so there was
  no failing-test pressure toward one shape or the other.
- The plan doc's pseudocode predates the brief (the brief looks like the refined/authoritative
  version for this dispatch) and is inconsistent with its own interface list.

I implemented `saveDerived` self-contained on `UserScopedSearchStore`, defining a local
`DerivedSearchPatch` type (`SearchInput & { result: CatalogResultLike; released?:
ReleasedTrackLike[] }`) and building the derived record via the *existing* `inner.save(...,
owner)` path rather than a new store method:

```ts
async saveDerived(source: SearchRecord, patch: DerivedSearchPatch): Promise<SearchRecord> {
  this.assertCanCreate();
  if (!this.owns(source)) throw new Error('search source is outside the editable principal scope');
  const { result, released, ...input } = patch;
  return this.inner.save(input, result, released, { userId: source.userId });
}
```

This satisfies the brief's literal behavioral description ("saveDerived throws if !owns(source),
else inherits source.userId") without inventing a new `SearchStore` surface. `DerivedSearchPatch`
is not one of the brief's canonical verbatim names, so I named it for clarity; if Task 4 (which
rewrites `app.ts`'s `scoped.saveDerived(source, { ...fields }, result, released)` call site)
prefers a different exact shape, only that one call site and this one method need to agree —
nothing else depends on it.

## Test file: `apps/api/src/search-principal-isolation.test.ts` (rewritten)

Replaced the entire prior file (which built a full Fastify app, JWT signing, and org/tenant HTTP
route assertions) with exactly the code block given verbatim in the brief. The old file's route
assertions (demo/workspace/organization 404s, tenant-admin behavior, platform-admin-only 403,
etc.) are gone — that coverage belongs to `app.ts`'s re-scoping in Task 4, and re-adding an
HTTP-level test here would just reintroduce the org/tenant setup the brief explicitly says to
delete.

## Test file: `packages/search-store/src/in-memory.test.ts` (created — did not previously exist)

The brief's step 5 says "fix `in-memory.test.ts` fixtures that used `tenantId`/`ownerUserId` ->
`userId`," which implies a pre-existing file. I searched the tree; no file at that path (or
under any other name importing `InMemorySearchStore` in isolation) exists in this repo. I
created it fresh rather than trying to locate or reconstruct a "prior" version. It covers, on
`InMemorySearchStore` directly (not through the `UserScopedSearchStore` wrapper, which is
already exercised by the other test file):

- `save()` stamps `owner.userId`, defaults to `''` when no owner is given.
- `get()` is unscoped (by id only) — this is the property the worker path relies on.
- `listForUser()` / `pageForUser()` filter correctly, newest-first ordering, and seek-pagination
  across a page boundary (verified with `put()`-inserted records at fixed `createdAt` timestamps
  rather than relying on real-clock ordering, which is not reliably distinguishable at
  millisecond resolution across fast sequential `await`s).
- `update()` treats `id`/`userId`/`createdAt` as immutable even if the mutator callback tries to
  overwrite them, and bumps `revision`.
- `delete()` with a `userId` argument only removes a matching-owner record; without one it
  removes unconditionally (the worker/unscoped path).
- `put()` rejects overwriting an existing id with a record owned by a different user
  (`assertSameSecurityScope`).
- `list()` is unscoped and returns every owner's records (documented as worker/admin-only, never
  request-facing).

7 tests, all passing.

## Commands run and output

```
$ npx vitest run apps/api/src/search-principal-isolation.test.ts packages/search-store/src/in-memory.test.ts
 RUN  v4.1.10 C:/Users/Lewis/Downloads/Distrokid

 ✓ packages/search-store/src/in-memory.test.ts (7 tests) 16ms
 ✓ apps/api/src/search-principal-isolation.test.ts (1 test) 9ms

 Test Files  2 passed (2)
      Tests  8 passed (8)
```

Ran twice: once before committing, once after, both green (output above is the post-commit run).

```
$ npx tsc --noEmit -p packages/search-store/tsconfig.json
```
Does **not** pass. Every single error is in files this task does not own:
- `postgres-search-store.ts` / `postgres-search-store.test.ts` — still built entirely around
  `tenantId`/`ownerUserId`/`artistWorkspaceId` (SQL columns, upsert conflict guard, fixtures).
  This is explicitly Task 2 ("`packages/search-store: T1 (types + scoping + in-memory) -> T2
  (postgres)`" per `.superpowers/sdd/2026-08-29-per-user-auth-isolation/progress.md`).
- `tiered-search-store.ts` — implements the old `SearchStore` shape (`ownerUserId`, missing
  `listForUser`/`pageForUser`), also Task 2/4 territory (it composes Postgres + Redis).
- `build-search-store.ts` — fails only because it composes `TieredSearchStore` /
  `PostgresSearchStore`, which are themselves broken; not touched by this task.
- `history-pagination.integration.test.ts`, `manual-review.test.ts` — fixtures built on the old
  field names; both are integration/sibling tests outside this task's two named test files.

Zero errors originate in `search-store.ts`, `in-memory.test.ts`, or
`search-principal-isolation.test.ts` themselves — I confirmed this by reading the full `tsc`
output line by line; every path in it is one of the five files above. This is exactly the
fallback case the brief anticipates ("If `@sentinel/search-store` won't build standalone because
of an unrelated pre-existing issue, note it and rely on the vitest run as your green signal"), so
per that instruction I'm relying on the vitest run (green) as the signal for this task, not the
package typecheck.

I did not run `apps/api`'s typecheck or the full-repo `npm run typecheck` — the brief explicitly
rules that out ("Do NOT try to fix the whole app... Leave `apps/api/src/app.ts` and other compile
errors alone").

## Other deviations from the brief

- **`apps/api/src/tenant-isolation.test.ts` left untouched.** This file tests the old
  `PrincipalScopedSearchStore`/`TenantScopedSearchStore` classes directly and will fail to even
  import after this rewrite (those export names no longer exist). It is not in the brief's
  "Test:" file list (only `search-principal-isolation.test.ts` and `in-memory.test.ts` are), and
  the pre-flight ledger's ruling states Task 1-3 reviews check "the task's OWN unit tests + diff
  quality, NOT a full-app typecheck." The design spec (section 6) does say this file should
  eventually become `user-isolation.test.ts`, but doesn't assign that rename to Task 1, and the
  task-1-brief — which I was told is the authoritative, complete requirement for this dispatch —
  doesn't mention it. I left it alone rather than guess. Whoever picks up Task 4 (or a dedicated
  cleanup task) will need to either delete or rewrite it; right now it's dead code that doesn't
  compile.
- Kept `ownerOf()` exported (see above) instead of removing it, since the brief explicitly
  offered that as one of two acceptable choices ("Remove `ownerOf()` or make it return
  `record.userId`").
- `SearchSummary` gained `userId` (not in the brief's explicit list, but `SearchRecord` gained it
  and `toSummary()` needs to project something for the owner; keeping it symmetric seemed like
  the least surprising choice for later tasks that render/consume summaries).

## Concerns / things the next task should know

1. **`DerivedSearchPatch` naming/shape is not brief-canonical** — flagged above. If Task 4's
   `app.ts` rewrite of the rescan route expects a different `saveDerived` shape, only that one
   call site and this one method need to change together.
2. **`packages/search-store` will not typecheck standalone until Task 2 lands.** This was
   expected and is documented in the pre-flight ledger, but flagging it again here since I
   couldn't get a clean `tsc` signal for this task by design.
3. `apps/api/src/tenant-isolation.test.ts` is now dead/broken code sitting in the tree (import
   errors, not just type errors) until some later task deletes or rewrites it. It doesn't block
   `vitest run apps/api/src/search-principal-isolation.test.ts` (vitest only fails on files it's
   asked to run or that fail to *transform*, and I didn't run the whole suite), but a full
   `npm test` right now will show it as a hard failure, not just a type error.
4. I did not run the full repo test suite (`npx vitest run` with no path) since that's expected
   to have many pre-existing-for-this-refactor failures across files this task doesn't own
   (worker tests, `scan-history.test.ts`, `organization-routes.test.ts`,
   `search-history-pagination.test.ts`, etc., all of which construct `SearchInput`/`SearchRecord`
   objects with `tenantId` directly). That matches the plan's own note: "the backend build/tests
   are green only at the END of Task 4."
