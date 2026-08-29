# Task 2 review — `PostgresSearchStore` + rest of `packages/search-store` on `user_id`

Verified independently (not just trusting the report):
- `npx tsc --noEmit -p packages/search-store/tsconfig.json` -> exit 0, no output.
- `npx vitest run packages/search-store` -> 5 passed / 1 skipped test files, 38 passed / 1 skipped tests. Matches report exactly.
- `git show --stat HEAD` -> single commit `ab26ea1 feat(db): scan_records keyed by user_id`, correct `Co-Authored-By` trailer, exactly the 5 files the report lists, working tree clean.
- Grep across `packages/search-store` for `tenantId|ownerUserId|artistWorkspaceId|DEFAULT_TENANT|listForTenant|listForOwner|pageForTenant|pageForOwner|tenant_id|owner_user_id|artist_workspace_id` -> no matches. No residual scope dimensions anywhere in the package.
- Grep for em dashes in `postgres-search-store.ts`, `tiered-search-store.ts`, `postgres-search-store.test.ts` -> no matches.
- Grep `packages/db/prisma/migrations` for `revision` -> no files, confirming the report's deviation #1 (no real `revision` column exists to require).
- All `new PostgresSearchStore(...)` call sites (in-package + report) use the single-arg constructor only.

## Isolation checks (attention lens)

- `REQUIRED_COLUMNS`/`REQUIRED_INDEXES` in `postgres-search-store.ts:29-44`: exactly `id, user_id, artist, distributor, deep_scan_status, created_at, updated_at, record` + `scan_records_pkey, scan_records_created_idx, scan_records_user_created_idx(user_id, created_at)`. Matches the brief verbatim, no residual tenant/owner/workspace columns or indexes.
- `upsert` (`postgres-search-store.ts:128-167`): `ON CONFLICT (id) DO UPDATE ... WHERE scan_records.user_id = EXCLUDED.user_id AND ...revision...`. On a zero-row conflict it re-selects `user_id, record` and throws `Error('scan record is owned by another user')` when `existing.user_id !== owned.userId` — a thrown error, not a silent no-op success. Verified this path is actually exercised by two tests (`postgres-search-store.test.ts:238-248` cross-user `put`/collision, `:250-259` cross-user full-record rewrite) and both assert the persisted row is unchanged after the rejected write.
- `listForUser`/`pageForUser` (`postgres-search-store.ts:181-207`): both scope with `WHERE user_id = $1` (page adds the seek predicate `AND (created_at, id) < (...)` after it); no way to change scope via the cursor since `userId` is a hard query parameter, not decoded from the cursor. Confirmed by the 225-row seek-pagination test (`:211-236`) and the Redis 205-row peer-starvation test (`:330-357`).
- `delete` in both `PostgresSearchStore` (`postgres-search-store.ts:235-241`) and `TieredSearchStore` (`tiered-search-store.ts:74-86`): `TieredSearchStore.delete` reads the durable record first and returns `false` without deleting anything if a `userId` is given and it doesn't match — verified by the "partially removed" test at `postgres-search-store.test.ts:311-328`.
- `get()` remains unscoped (`WHERE id = $1` only) in `PostgresSearchStore`. This is inherited from Task 1's `SearchStore` interface (`get(id): Promise<SearchRecord | null>` has no `userId` parameter anywhere — same in `InMemorySearchStore`/`RedisSearchStore`), which the brief explicitly told this task to use verbatim. Scoping enforcement for by-id reads is the API-layer wrapper's job (`apps/api/src/tenant-scoped-search-store.ts`, per the `SearchRecord.userId` docstring, out of this task's scope). Not a Task 2 gap.

## Test hygiene

- Contract test asserts the exact new column/index set and fails with the right message when `scan_records_user_created_idx` is missing (`:162-170`).
- Cross-user rejection tests assert both the specific error string and that the durable row is untouched — not vacuous.
- The dropped "artist workspace rewrite" half of the old combined test is legitimate: `artistWorkspaceId` no longer exists as a field on `SearchRecord` (confirmed in `search-store.ts`), so there is nothing left to test there. Coverage for cross-user rejection is still present via two independent tests (collision-on-put, full-record ownership rewrite).
- `manual-review.test.ts` and `history-pagination.integration.test.ts` fixture fixes (adding required `userId`, swapping `pageForOwner`/`delete(id, tenantId, ownerUserId)` calls) were necessary for the package to typecheck and are correctly scoped — not gold-plating.

## Quality / YAGNI

- No dead tenant/owner/workspace code left anywhere in the touched files (grep-confirmed above).
- Constructor's unused `tenantId?` scoping parameter was removed entirely rather than cargo-culted into `userId?`; report shows the grep evidence that nothing used it. Reasonable simplification, consistent with `InMemorySearchStore`/`RedisSearchStore` never having had an instance-level scope.
- SQL is not duplicated beyond what's structurally necessary (`upsert`/`update`/`get`/`list*` each need their own statement).
- No em dashes, no AI-style icons.

## Findings

None — no Critical, Important, or Minor findings.

## Verdicts

SPEC: PASS — every requirement in the brief (columns, indexes, upsert rejection + throw, `listForUser`/`pageForUser`, `save(..., owner)`, `tiered-search-store.ts`/`build-search-store.ts` repointing, unit tests green, package typechecks) is met and independently verified.

QUALITY: approved — no dead code, no duplicated SQL, no naming drift, deviations from the brief (constructor param removal, no `revision` column, test consolidation) are well-justified and documented in the report.

Critical: 0
Important: 0
Minor: 0
