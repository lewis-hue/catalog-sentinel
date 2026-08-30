# Task 1 review — `UserScopedSearchStore`

Reviewed diff: commit `4ee30c5` (efaad26..4ee30c5), the four files in the review package.
Verified independently (not just trusting the report):

- Ran `npx vitest run apps/api/src/search-principal-isolation.test.ts packages/search-store/src/in-memory.test.ts`
  -> 2 files, 8 tests, all green, matches the report's output exactly.
- Ran `npx tsc --noEmit -p packages/search-store/tsconfig.json` and filtered every `error TS` line's
  source file. All errors originate in exactly the 6 files the report names as pre-existing/out-of-scope
  (`postgres-search-store.ts`, `postgres-search-store.test.ts`, `tiered-search-store.ts`,
  `build-search-store.ts`, `history-pagination.integration.test.ts`, `manual-review.test.ts`). Zero
  errors in `search-store.ts`, `in-memory.test.ts`, or `search-principal-isolation.test.ts`. Report's
  typecheck claim confirmed accurate.
- Grepped both modified source files for `tenantId|ownerUserId|artistWorkspaceId|listForTenant|
  listForOwner|pageForTenant|pageForOwner|personalArtistWorkspaceId|withoutClientScope|
  PrincipalWorkspaceAccess|saveInAuthorizedWorkspace|tenantAdmin|unverifiedTestIdentity|
  TenantScopedSearchStore|PrincipalScopedSearchStore|DEFAULT_TENANT` -> no matches in either file.
  Confirmed fully removed, not just renamed-and-forgotten.
- Grepped for em dashes in all four changed files -> none.
- Read the full current content of `tenant-scoped-search-store.ts` and `search-store.ts` line by
  line, not just the diff, to check invariants that a diff alone can hide (e.g. what `newRecord`
  does with an absent `owner`, what `applySearchMutation` strips).

## Isolation rule (the core security guarantee)

Traced every read/write/list/delete path in both classes:

- `UserScopedSearchStore.owns()` = `record !== null && hasCustomerScanAccess(principal) &&
  record.userId === principal.sub` — the AND ordering from the brief is preserved (access gate
  always evaluated, not short-circuited away by a userId coincidence).
- `get`/`update`/`delete` all route through `owns()` and return `null`/`null`/`false` for a foreign
  record, never a throw, never the record's existence otherwise observable.
- `save`/`saveDerived` stamp `{ userId: principal.sub }` (or inherit `source.userId` after an
  `owns(source)` check) via the storage-layer `owner` argument. Neither method spreads the raw
  client `input` into the stored record: `newRecord()` in `search-store.ts` builds the record with an
  explicit field list and never reads `input.userId` — so even if a route elsewhere naively casts an
  untrusted JSON body to `SearchInput`, there is no field on it that can smuggle a foreign `userId`
  into storage. (This is actually stronger than the old code, which needed an explicit
  `withoutClientScope()` strip step because `SearchInput` itself used to declare passthrough scope
  fields.)
- `list`/`listPage` gate on `hasCustomerScanAccess` and then delegate to `listForUser`/`pageForUser`,
  both of which filter by `record.userId === userId` in both `InMemorySearchStore` and
  `RedisSearchStore`.
- `UserBoundSearchStore` (worker-bound) checks `record.userId !== this.userId` directly on `get`/
  `update`/`delete` — correct, and intentionally has no principal/access-gate concept, matching the
  brief's description of the worker's unscoped-but-job-bound use case.
- Confirmed with the isolation test (ran it myself, not just read the report): alice creates a
  record, bob's `get`/`update`/`delete`/`listPage` all observe it as absent, alice's own `listPage`
  sees exactly her one record. Not vacuous — it exercises both the negative (bob) and positive
  (alice) case in one assertion chain.

## Canonical names

All verbatim per the brief: `UserScopedSearchStore`, `UserBoundSearchStore`,
`SearchPrincipal { sub: string; roles: string[]; authenticated: boolean }`, `SearchRecord.userId:
string`, `listForUser(userId)`/`pageForUser(userId, options)`, `SearchStore.save(input, result,
released?, owner?: { userId })`. `saveDerived(source, patch)` matches the brief's own "Interfaces
produced" section literally (two args); the report's flagged deviation is against an older plan
doc, not against this task's actual brief, so it is not a compliance gap.

## Removal of tenant/workspace vocabulary

`listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant`, `DEFAULT_TENANT`,
`personalArtistWorkspaceId`, `withoutClientScope`, `saveInAuthorizedWorkspace`,
`PrincipalWorkspaceAccess`, the `tenantAdmin`/`unverifiedTestIdentity` bypass branches, and the
Redis tenant + tenant/owner composite indexes are all gone, confirmed by grep returning zero
matches in both modified source files. Redis collapses to the single `search:user:<id>:index` the
brief calls for. `ownerOf()` was kept (brief explicitly allowed this) reduced to `(r) => r.userId`.

## Findings

### Minor: ownerless records default to `userId: ''`, a theoretical same-value collision with an empty `sub`
- File: `packages/search-store/src/search-store.ts:328` (`newRecord`), reachable via `owns()` in
  `apps/api/src/tenant-scoped-search-store.ts:129-131`.
- What: previously an ownerless/legacy record was stamped `tenantId: DEFAULT_TENANT` ('default'), a
  namespace no real tenant could ever equal. Now an ownerless record gets `userId: ''`. `owns()` is
  a plain `===` compare, so a `SearchPrincipal` with `sub === ''` would be treated as the owner of
  every ownerless record in the store.
- Why it's Minor, not Critical: neither `UserScopedSearchStore` nor `UserBoundSearchStore` (the two
  classes this task rewrites) ever calls `inner.save()` without an `owner`, so this path isn't
  reachable through anything in this diff. It would only matter if (a) some other caller saves a
  record with no owner, and (b) a real `SearchPrincipal` is later constructed with an empty `sub`,
  which shouldn't happen with real Keycloak tokens. Flagging as a defensive-hardening note for
  whichever later task wires real JWTs into `SearchPrincipal` (reject/guard an empty `sub` before it
  reaches `owns()`), not a defect in this task's own scope.

### Minor / informational: `apps/api/src/tenant-isolation.test.ts` now fails to import (not part of this diff)
- File: `apps/api/src/tenant-isolation.test.ts` (untouched by commit `4ee30c5`).
- What: it imports `PrincipalScopedSearchStore`, `TenantScopedSearchStore`, and
  `personalArtistWorkspaceId` from `tenant-scoped-search-store.ts`, all of which this commit deletes.
  The file will fail at import time, not just at type-check time.
- Why it's not counted against this task: it is not in the brief's "Test:" file list (only
  `search-principal-isolation.test.ts` and `in-memory.test.ts` are named), it is not part of the
  reviewed diff, and the pre-flight ruling scopes this review to the task's own unit tests plus diff
  quality, not the whole app. The report already discloses this transparently as a known followup.
  Noting it here only so it isn't lost before Task 4.

No Critical or Important findings. No dead code, no vestigial tenant/workspace scoping, no naming
drift from the canonical set, no verbatim-duplicated logic between the two classes (their
divergent shapes are intentional and match the brief's description of the worker vs. request-bound
use cases).

## Counts
- Critical: 0
- Important: 0
- Minor: 2
