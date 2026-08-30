# Task 2 report — `PostgresSearchStore` + the rest of `packages/search-store` on `user_id`

Branch: `per-user-auth-isolation`

## Summary

Rewrote `postgres-search-store.ts` and `tiered-search-store.ts` from the old
`tenantId`/`ownerUserId`/`artistWorkspaceId` triple-scope model to the single `userId` model that
Task 1 already established in `search-store.ts`. Updated the contract test
(`postgres-search-store.test.ts`) and the integration-only pagination test
(`history-pagination.integration.test.ts`, which stays `describe.skip`d at runtime but still had
to typecheck) to match. `build-search-store.ts` needed no changes: it never calls the
tenant/owner-scoped methods directly, it only composes the store classes, so it started passing
once its dependencies did.

`packages/search-store` now typechecks cleanly and every unit test passes (integration test
correctly skipped, no DB/Redis in this environment).

## Files changed

### `packages/search-store/src/postgres-search-store.ts` (rewritten)

- `REQUIRED_COLUMNS`: dropped `tenant_id`, `owner_user_id`, `artist_workspace_id`; added
  `user_id` (`text`, not null). Final set: `id`, `user_id`, `artist`, `distributor`,
  `deep_scan_status`, `created_at`, `updated_at`, `record` (jsonb) — exactly the brief's list.
  I did **not** add a `revision` column requirement (see Deviations).
- `REQUIRED_INDEXES`: dropped `scan_records_tenant_created_idx`,
  `scan_records_tenant_owner_created_idx`, `scan_records_tenant_workspace_created_idx`; kept
  `scan_records_pkey` and `scan_records_created_idx`; added a single
  `scan_records_user_created_idx` on `(user_id, created_at)` descending.
- `assertScanRecordsSchema`'s zero-row probe `SELECT` now lists `id, user_id, artist,
  distributor, deep_scan_status, created_at, updated_at, record`.
- Constructor: dropped the `tenantId?: string` "deliberately scoped instance" parameter
  entirely. Nothing in the tree constructed `PostgresSearchStore` with a second argument (grepped
  all call sites first), and `InMemorySearchStore`/`RedisSearchStore` never had an
  instance-level scope either — scoping is purely a call-parameter concern (`owner`,
  `listForUser(userId)`, `delete(id, userId)`), matching the `SearchStore` interface Task 1 set.
- `save(input, result, released?, owner?)`: builds the record inline (mirrors `newRecord()` in
  `search-store.ts`, which is not exported) with `userId: owner?.userId ?? ''`, then calls
  `upsert`.
- `upsert(rec)`: writes `user_id` in the `INSERT`; `ON CONFLICT (id) DO UPDATE ... WHERE
  scan_records.user_id = EXCLUDED.user_id AND COALESCE((record->>'revision')::bigint,0) < $8`.
  On a zero-row conflict, re-reads `user_id, record` for the existing row and throws
  `Error('scan record is owned by another user')` if `existing.user_id !== owned.userId` — exact
  message from the brief. Otherwise falls through to the existing stale/equal-revision/conflict
  logic (unchanged from before).
- `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` deleted, replaced by
  `listForUser(userId)` (`WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`) and
  `pageForUser(userId, options)` (same seek-cursor mechanism as before — `(created_at, id) <
  ($2,$3)` — just single-key instead of two-key scope). The opaque signed-cursor wrapper lives in
  `apps/api/src/tenant-scoped-search-store.ts` (Task 1 territory, already updated); this file only
  ever dealt with the plain `{createdAt, id}` `SearchPageCursor`, so nothing changed structurally
  there.
- `update`: `WHERE id = $1 AND user_id = $2 AND ...revision...` instead of `tenant_id = $2`.
- `delete(recordId, userId?)`: was `delete(recordId, tenantId?, ownerUserId?)` (3 params, 3 SQL
  branches). Now 2 params, 2 branches: `WHERE id = $1 AND user_id = $2` when a `userId` is given,
  `WHERE id = $1` otherwise.
- Denormalized `deep_scan_status` column write kept unchanged in both `upsert` and `update`.

### `packages/search-store/src/tiered-search-store.ts` (rewritten)

- `save(input, result, released?, owner?)` now forwards `owner` to `this.durable.save(...)`
  (previously dropped it — Task 1's `SearchStore.save` signature already had the 4th arg, this
  file just wasn't passing it through).
- `listForTenant`/`listForOwner`/`pageForTenant`/`pageForOwner` deleted, replaced by
  `listForUser(userId)` / `pageForUser(userId, options)`, both thin try/catch wrappers around the
  durable tier exactly as before (fail-closed: any durable-tier throw becomes `Error('durable
  search store unavailable')`).
- `delete(recordId, userId?)`: reads the durable record first (unchanged pattern); if a `userId`
  is given and doesn't match `durableRecord.userId`, returns `false` without touching either
  tier; otherwise deletes from durable then hot (durable failure propagates, hot failure is
  logged and swallowed — unchanged behavior, just one scope key instead of two).
- Removed the `ownerOf` import (no longer needed now there's exactly one field to read).

### `packages/search-store/src/postgres-search-store.test.ts` (rewritten)

Updated `FakePg` to emulate the new single-key schema and SQL shapes:
- `schemaRows` now list `user_id` instead of `tenant_id`/`owner_user_id`/`artist_workspace_id`,
  and the index rows are `scan_records_pkey`, `scan_records_created_idx`,
  `scan_records_user_created_idx`.
- `INSERT INTO scan_records` conflict emulation compares `existing.userId !== incoming.userId`
  (was three-way tenant/owner/workspace comparison).
- `UPDATE scan_records SET` emulation compares `existing.userId !== userId` (param 1, was
  `tenantId`).
- `DELETE FROM scan_records` emulation checks `user_id = $2` (was checking both `tenant_id = $2`
  and `owner_user_id = $3` independently).
- The post-conflict ownership-check `SELECT` branch matches on `'SELECT user_id, record'` (was
  `'SELECT tenant_id, owner_user_id'`) and returns `{ user_id, record }`.
- The listing branch matches `'WHERE user_id = $1'` for scoping and otherwise the same
  cursor/limit logic as before, just without the "owner-scoped adds two more params" special
  case (there's only one scope key now, so the cursor params are always at fixed positions 1/2).

Test-by-test changes (all renamed/reworded for "user" instead of "tenant"/"owner", full diff is
in the file):
- The two schema-validation tests: default-owner save now asserts `saved.userId === ''` (was
  `saved.tenantId === 'default'`); the missing-index test filters out
  `scan_records_user_created_idx` and asserts the error message names it.
- "rejects a record id collision across tenants" → "across users", asserts
  `'scan record is owned by another user'`.
- "rejects full-record ownership or workspace rewrites" → "rejects a full-record ownership
  rewrite" (the artist-workspace half of this test is gone — there is no workspace scope left to
  rewrite). Still asserts the ownership-rewrite throw and that the persisted row is unchanged.
- The two separate tenant-scope and tenant+owner-scope listing tests collapsed into one "lists at
  the SQL user boundary ... and excludes unowned legacy rows" test, since tenant and owner used
  to be two independent scope dimensions and are now one.
- The 225-row seek-pagination test now seeds/pages through `pageForUser('alice', ...)`.
- The `RedisSearchStore` describe block (`'revision-aware hot store'`) and the `TieredSearchStore`
  describe block: every `save({ tenantId, ownerUserId, artistWorkspaceId, ... })` call became
  `save({ ...content }, result(), released?, { userId })`; every `listForTenant`/`listForOwner`/
  `pageForOwner` call became `listForUser`/`pageForUser`; Redis index-key assertions changed from
  `search:tenant:<t>:index` / `search:tenant:<t>:owner:<o>:index` to `search:user:<u>:index`
  (this key format was already implemented by Task 1 in `search-store.ts`'s `RedisSearchStore`,
  I only had to fix the test's expectations to match what's actually there).

### `packages/search-store/src/history-pagination.integration.test.ts` (updated, stays skipped)

This file is real-infra-only (`describe.skip` unless `DATABASE_URL`+`REDIS_URL` are set) but is
still included by `tsconfig.json`'s `src/**/*` and therefore had to typecheck. Replaced
`tenantId`/`ownerUserId`/`artistWorkspaceId` fixture fields with a single `userId`, and
`pageForOwner(tenantId, ownerUserId, ...)` / `delete(id, tenantId, ownerUserId)` calls with
`pageForUser(userId, ...)` / `delete(id, userId)`.

### `packages/search-store/src/manual-review.test.ts` (one-line fix)

Not mentioned in the brief's file list, but `tsc` caught it: the test's local `record()` fixture
builds a bare `SearchRecord` object literal and was missing the now-required `userId` field
(unrelated to any tenant/owner vocabulary — this file never had any). Added `userId: 'user-1'`.

### `packages/search-store/src/build-search-store.ts` (unchanged)

Re-read it against the brief's instruction to "re-point method calls" — it doesn't call
`listForUser`/`pageForUser`/`save(..., owner)` or any of the old tenant methods at all, it only
constructs `PostgresSearchStore`/`TieredSearchStore`/`RedisSearchStore`/`InMemorySearchStore`
instances and returns them behind the `SearchStore` interface. It compiled with no edits once its
dependencies did.

## Deviations from the brief

1. **No `revision` column in `REQUIRED_COLUMNS`.** The brief says "plus revision if present." I
   checked the actual Prisma migrations for `scan_records`
   (`packages/db/prisma/migrations/20260722122000_scan_records/migration.sql` and
   `.../20260722170000_scan_record_principal_scope/migration.sql`): there is no `revision`
   column at the SQL level, only `record->>'revision'` inside the JSONB blob (which is how
   `revisionOf()` already reads it everywhere). No migration in the repo adds one. Since the
   phrase is conditional ("if present") and nothing in the actual schema or in any test fixture
   has it, I left `REQUIRED_COLUMNS` at exactly the 8 columns the brief lists by name, with no
   `revision` entry. If a later task's migration does add a real `revision` column, this map
   will need one more line — flagging this explicitly as a possible gap.
2. **Dropped the `tenantId?: string` constructor parameter from `PostgresSearchStore` entirely**
   rather than renaming it to `userId?`. The brief doesn't mention the constructor. I grepped
   every `new PostgresSearchStore(...)` call site in the repo before removing it — none passed a
   second argument — and the sibling stores (`InMemorySearchStore`, `RedisSearchStore`) never had
   an instance-level scope either, so an unused `userId?` constructor param would have been dead
   surface area inconsistent with the rest of the interface.
3. Merged two of the old test's tenant-scope/tenant+owner-scope listing tests into one, and
   dropped the artist-workspace half of the "rejects full-record ownership or workspace rewrites"
   test, since tenant/owner/workspace were three independent scope dimensions and are now one
   (`userId`). No coverage was silently dropped that doesn't map onto a coverage duplicate: the
   cross-user upsert rejection and cross-user full-record-put rejection are each still covered by
   a dedicated test.

## Commands run and output

```
$ npx tsc --noEmit -p packages/search-store/tsconfig.json
(no output — exit 0)
```

```
$ npx vitest run packages/search-store
 RUN  v4.1.10 C:/Users/Lewis/Downloads/Distrokid

 ✓ packages/search-store/src/manual-review.test.ts (5 tests) 18ms
 ✓ packages/search-store/src/redis-client.test.ts (3 tests) 21ms
 ✓ packages/search-store/src/postgres-search-store.test.ts (21 tests) 96ms
 ✓ packages/search-store/src/build-search-store.test.ts (2 tests) 9ms
 ✓ packages/search-store/src/in-memory.test.ts (7 tests) 17ms
 ↓ packages/search-store/src/history-pagination.integration.test.ts (1 test | 1 skipped)

 Test Files  5 passed | 1 skipped (6)
      Tests  38 passed | 1 skipped (39)
```

`git status --porcelain packages/search-store` before committing confirmed only the five files
listed above changed (no stray edits, nothing outside the package). Grepped all changed files for
em dashes: none found.

I did not run `apps/api`'s typecheck, `packages/persistence`'s typecheck, or a full-repo
`npm run typecheck`/`npx vitest run` — the brief explicitly rules those out as Task 4/5 territory
and states the full app is expected to still be red.

## Concerns / things the next task should know

1. **The `revision` column ambiguity above** — worth a one-line confirmation from whoever owns
   the next `packages/db` migration touching `scan_records`, so `REQUIRED_COLUMNS` here gets
   updated in lockstep if a real `revision` column is ever added.
2. **No migration exists yet that renames `tenant_id`/`owner_user_id`/`artist_workspace_id` to
   `user_id` on the real `scan_records` table.** `assertScanRecordsSchema` will fail against
   today's actual (un-migrated) database — by design, since this task's contract is the unit-test
   fake, not a live database, and the brief scoped DB migrations out of `packages/search-store`.
   Whichever task owns the `packages/db` migration chain needs to add a migration that: adds
   `user_id`, backfills/collapses it from `owner_user_id` (or leaves new rows-only, matching how
   `owner_user_id` itself was left NULL for pre-existing rows in the prior migration), drops
   `tenant_id`/`owner_user_id`/`artist_workspace_id`, and replaces the three old indexes with
   `scan_records_user_created_idx`. Until that lands, this package's runtime `init()` schema
   assertion will reject startup against the real database (fails closed, as intended, but it
   will need that migration before the app can boot with this code).
3. `apps/api`, `packages/persistence`, and the worker still reference the deleted
   `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant`/three-arg `delete` surface (this
   was already true before this task, per Task 1's report) — untouched, as instructed.
