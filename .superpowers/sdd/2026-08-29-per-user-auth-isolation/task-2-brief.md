# Task 2 brief — `PostgresSearchStore` + the rest of `packages/search-store` on `user_id`

This is your requirements. Task 1 already rewrote `packages/search-store/src/search-store.ts` (the `SearchRecord`/`SearchStore` types + `InMemorySearchStore`) and `apps/api/src/tenant-scoped-search-store.ts` to a single per-user scope. Your job: bring the REST of `packages/search-store` in line so the whole package typechecks and its unit tests pass.

## Interfaces you consume (already implemented in Task 1 — use verbatim, do not change them)

- `SearchRecord.userId: string` (the old `tenantId`/`ownerUserId`/`artistWorkspaceId` are gone).
- `SearchStore.save(input, result, released?, owner?: { userId: string })` — stamp `record.userId = owner.userId`.
- `SearchStore.listForUser(userId: string): Promise<SearchSummary[]>` and `SearchStore.pageForUser(userId: string, options: SearchPageOptions): Promise<SearchPage>` (filter `record.userId === userId`, newest first). The old `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` no longer exist on the interface.

## Files (whatever exists in the package)

- Modify: `packages/search-store/src/postgres-search-store.ts` (durable store — the primary target)
- Modify: `packages/search-store/src/tiered-search-store.ts` (redis-hot + postgres-durable wrapper) and `packages/search-store/src/build-search-store.ts` (factory) — re-point their method calls to `listForUser`/`pageForUser`/`save(..., owner)`.
- Modify: the Redis store implementation (in `search-store.ts` or a `redis-*.ts` sibling) if Task 1 did not already finish it — a single `user:<id>` owner index.
- Test: `packages/search-store/src/postgres-search-store.test.ts`; leave `*.integration.test.ts` skipped (needs a live DB).

## Global constraints

- Isolation is the security guarantee: every read/list/write/delete path keys on `user_id`. A record owned by a different `user_id` must NOT be overwritable or readable.
- No em dashes, no AI-style icons in code/comments.

## Steps (TDD)

1. Update the contract test in `postgres-search-store.test.ts`: `REQUIRED_COLUMNS` must be `id`, `user_id` (not null), `artist`, `distributor`, `deep_scan_status`, `created_at`, `updated_at`, `record` (jsonb), plus `revision` if present; drop `tenant_id`/`owner_user_id`/`artist_workspace_id`. `REQUIRED_INDEXES` must include the pkey, `scan_records_created_idx`, and a single `scan_records_user_created_idx` on `(user_id, created_at)` — drop the tenant/owner/workspace indexes. Change the cross-owner-upsert rejection test to a cross-`user_id` rejection.

2. Run it, confirm it fails: `npx vitest run packages/search-store/src/postgres-search-store.test.ts`.

3. Implement in `postgres-search-store.ts`:
   - `REQUIRED_COLUMNS` / `REQUIRED_INDEXES` per Step 1.
   - `upsert`/`put`: write `user_id`; `INSERT ... ON CONFLICT (id) DO UPDATE SET ... WHERE scan_records.user_id = EXCLUDED.user_id` and, after a no-op conflict, detect a cross-user attempt and throw `Error('scan record is owned by another user')`. Read `user_id` from `record.userId`.
   - Replace `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` with `listForUser(userId)` / `pageForUser(userId, options)` (`WHERE user_id = $1 ORDER BY created_at DESC`). Keep the signed opaque page cursor mechanism; it now encodes user scope.
   - Keep the denormalized `deep_scan_status` column + its write.

4. Update `tiered-search-store.ts` + `build-search-store.ts` so they call the new methods (`listForUser`/`pageForUser`, `save(..., owner)`). The tiered store's `get` stays "durable (postgres) first, warm redis"; just drop tenant/workspace params.

5. Run `npx vitest run packages/search-store` to green (unit files only; integration files stay skipped). Then confirm the package typechecks: `npx tsc --noEmit -p packages/search-store/tsconfig.json` should now pass (Task 1 left errors here that this task closes). If a `packages/persistence` or other consumer still errors, that is out of scope — note it; do NOT fix other packages.

6. Commit: `git add packages/search-store && git commit -m "feat(db): scan_records keyed by user_id"` (append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Do NOT push.

## Rulings carried from pre-flight

- The FULL app (esp. `apps/api/src/app.ts`, `packages/persistence`, worker) still will NOT typecheck after this task — that is Task 4/5 territory. Your green signal is: `packages/search-store` typechecks AND its unit tests pass. Do NOT touch `apps/api` or other packages.
- Do NOT dispatch subagents.
