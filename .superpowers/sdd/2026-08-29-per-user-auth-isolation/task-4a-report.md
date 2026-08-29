# Task 4a report — contracts + persistence + worker re-point to user scope

## Summary

`packages/contracts` and `packages/persistence` already typechecked cleanly against Task 3's
regenerated Prisma client (no compiler-forced field renames were needed in either package).
`apps/worker` had 14 real compiler errors, all caused by the already-completed search-store
refactor (Task 1) collapsing `SearchRecord.tenantId` / `ownerUserId` / `artistWorkspaceId` into a
single `userId` field. Separately, three raw-SQL stores in `packages/persistence` and one raw-SQL
store in `apps/worker/src/distrokid/snapshot-store.ts` referenced the literal `"tenantId"` Postgres
column that Task 3 renamed to `"userId"` on every affected model; none of this showed up as a
typecheck error (as the brief warned) and was found by reading `schema.prisma` and grepping for
quoted `"tenantId"` strings.

Green signal met: `packages/contracts`, `packages/persistence`, `apps/worker` all typecheck via the
project's real gate (`npx tsc --noEmit -p tsconfig.json`, the same one `npm run typecheck` runs),
and `npx vitest run packages/contracts packages/persistence apps/worker` is 116 passed / 30 skipped
(all skips are `*.integration.test.ts`, no DB in this environment). `apps/api` still fails (55
errors), all pre-existing and out of scope (Task 4b).

## Kind 1: compiler-forced field renames (Prisma-adjacent / search-store type change)

The brief anticipated these in the Prisma CLIENT itself; in practice none of the affected models
Task 3 re-pointed are written directly via `prisma.<model>.create/update/upsert` in worker or
persistence code (the DistroKid pipeline's Prisma writes go through `packages/db`, out of scope).
The actual "kind 1"-shaped breakage was the sibling `@sentinel/search-store` package (already
rewritten by Task 1 of the plan, not part of my scope, but consumed by worker), whose
`SearchRecord` type dropped `tenantId`/`ownerUserId`/`artistWorkspaceId` in favor of one required
`userId: string`. Fixed call sites:

- `apps/worker/src/distrokid/finalize-result.ts:116` — object literal spread into a `SearchRecord`
  return value used `tenantId: job.tenantId`; changed to `userId: job.tenantId` (the job's internal
  `tenantId` field already carries the sub, per the brief's ruling; only the SearchRecord-side key
  changed).
- `apps/worker/src/distrokid/finalize-result.test.ts:30,111` — fixture `SearchRecord` literals used
  `tenantId:`; changed to `userId:`.
- `apps/worker/src/deep-scan-presence.test.ts:37` — a bare `SearchRecord` literal (not built via
  `store.save`) was missing the now-required `userId`; added `userId: 'tenant-a'`.
- `apps/worker/src/deep-scan-presence.test.ts:43,116,147` — `store.save({ tenantId: 'tenant-a', ... })`
  passed ownership as an excess property on `SearchInput` (which never carried it); moved ownership
  to the store's 4th `owner` parameter: `store.save({...}, result, released, { userId: 'tenant-a' })`.
- `apps/worker/src/distrokid/principal-binding.ts:28-48` — this is the deeper one. The function
  cross-checked `record.ownerUserId`/`record.artistWorkspaceId` (queue-to-record-to-consent binding,
  security-relevant: prevents a forged same-tenant queue payload from attaching Alice's Steel
  session to Bob's scan) against `consent`/`job`. Neither field exists on `SearchRecord` any more
  (collapsed into `userId`, and the "workspace" dimension no longer exists on a search record at
  all — it still exists on `packages/db`'s `LinkConsent`/queue job, untouched, out of scope).
  Rewrote the check to preserve the same binding chain using only what still exists:
  - `record.ownerUserId` → `record.userId` (`!record.userId` fail-closed guard preserved).
  - `record.artistWorkspaceId === job.artistWorkspaceId` (record side) removed — record no longer
    carries a workspace at all.
  - `consent.artistWorkspaceId === record.artistWorkspaceId` → `consent.artistWorkspaceId ===
    job.artistWorkspaceId`: the workspace claim is now checked directly against the consent's
    actual workspace instead of bouncing through the (now absent) record field. Combined with
    `ownerOf(record) === job.tenantId` and `consent.tenantId === job.tenantId`, the same three-way
    binding (record ↔ job ↔ consent) still holds; only the record's own workspace field is gone.
  - `consent.grantedByUserId === record.ownerUserId` → `consent.grantedByUserId === record.userId`.
- `apps/worker/src/distrokid/principal-binding.test.ts` — fixture updated to match: `store.save`
  now passes `{ userId: 'tenant-a' }` as the owner (was `tenantId`/`ownerUserId`/`artistWorkspaceId`
  in the `SearchInput` literal, which no longer compiles); `consent.grantedByUserId` changed from
  `'alice'` to `'tenant-a'` so it equals `record.userId` in the fixture (previously it was a
  separate "member within the tenant" concept that no longer exists on the record side); the
  "legacy ownerless record" test destructures `userId` instead of `ownerUserId` and casts through
  `as SearchRecord` since `SearchRecord.userId` is now non-optional (was previously producible by
  omitting an optional `ownerUserId`).

## Kind 2: raw-SQL columns (compiler-invisible)

Read `packages/db/prisma/schema.prisma`. Every model touched by these stores declares `userId
String` with **no** `@map`, so the Postgres column name is the literal, case-sensitive `"userId"`
(not `user_id`) for all of them: `DistributorEndpointCandidate`, `DistributorEndpointProfile`,
`DistributorExtractionSnapshot`, `DistributorReleaseOutcome`, `DistributorTrackOutcome`,
`DistroKidSnapshotCheckpoint`, `DistroKidCheckpointIndex`, `DistroKidCheckpointOutcome`,
`DistroKidCheckpointProgress`, `DistroKidCheckpointChunk`, `DistroKidCheckpointPassPlanChunk`,
`DistroKidCheckpointTerminal`.

**`packages/persistence/src/candidate-store.ts`** (`DistributorEndpointCandidate`): every `WHERE
"tenantId"`, the `INSERT` column list, and the `ON CONFLICT ("tenantId", "scanId", "fingerprint")`
target changed to `"userId"`. `CandidateRow`/`toStored()` never read the column back, so no
row-shape follow-up needed.

**`packages/persistence/src/endpoint-registry-store.ts`** (`DistributorEndpointProfile`): same SQL
column renames (`WHERE`, `INSERT` column list, `ON CONFLICT`). This one DOES read the column back
via `SELECT *` into `ProfileRow`, so `ProfileRow.tenantId: string` was renamed to `userId: string`
(the actual shape Postgres now returns) and `toProfile()` changed to `tenantId: row.userId` — the
contract-facing `DistributorEndpointProfile.tenantId` field (from `packages/contracts`) is
deliberately left named `tenantId` per the brief's ruling (it's the scope-carrying type field, not
compiler-forced), only the row-parsing side needed to track the real column.

**`packages/persistence/src/outcome-repository.ts`** (`DistributorExtractionSnapshot`,
`DistributorReleaseOutcome`, `DistributorTrackOutcome`): 11 raw-SQL sites — every `WHERE
"tenantId"`/`s."tenantId"`/`s2."tenantId"` filter, all three `INSERT` column lists, and the
`ON CONFLICT ("tenantId", "snapshotId")` target — changed to `"userId"`. None of the `SELECT`
column lists here ever project `tenantId` into a typed row (only used as a filter), so no row-shape
follow-up was needed.

**`packages/persistence/src/persistence.integration.test.ts`**: 9 raw-SQL sites (`DELETE`/`SELECT`
against the same three tables, used for test setup/assertions) updated the same way. This is a
`*.integration.test.ts` file (skipped without `DATABASE_URL` in this environment) but is still raw
SQL inside `packages/persistence`, so it's covered by the brief's "zero stale tenantId COLUMN
strings remain in packages/persistence" requirement and would otherwise silently fail the moment
someone runs it against the new schema.

**`apps/worker/src/distrokid/snapshot-store.ts`** — **not explicitly named in the brief's file
list**, but it is a raw-SQL "sibling store" living inside `apps/worker/src/*` (my scope), hitting
the DistroKid checkpoint/recovery tables (`DistroKidSnapshotCheckpoint` and its six child tables)
with the exact same stale `"tenantId"` literal-column problem. Left unfixed, it would compile
cleanly and then fail every DistroKid pipeline write at runtime with "column tenantId does not
exist" — directly contradicting the task's stated goal ("compile AND run correctly against the new
schema"). I fixed it as an in-scope extension of kind 2, not a deviation from the brief's intent:
- 19 plain `WHERE`/`INSERT column-list`/`ON CONFLICT` renames from `"tenantId"` to `"userId"`
  across `bindSnapshot`, `refreshVersion`, `lock`, `bumpVersion`, `putIndex`/`getIndex`,
  `putOutcomes`/`getOutcomes`, `putProgress`, `markChunkComplete`/`completedChunks`/
  `completedChunkCount`, `putPassPlan`/`getPassPlan`, `claimTerminal`/`getTerminal`.
- 2 sites (`bindSnapshot`'s `SELECT` at line ~626 and `getProgress`'s `SELECT` at line ~836) DO
  project the column into a row that's cast straight to `SnapshotCheckpointBinding`/
  `SnapshotProgress` — both of which keep a `tenantId: string` field per the "leave the pipeline's
  internal tenantId naming as-is" ruling (renaming those would cascade into every
  `binding.tenantId`/`sameBinding()`/`SnapshotProgress` call site across this 1179-line file,
  exactly the ~20-file cascade the brief said not to chase). Used `SELECT "userId" AS "tenantId"`
  so the actual DB column is correct while the TS-side shape is untouched.
- `apps/worker/src/distrokid/snapshot-store.integration.test.ts:139` — one more raw-SQL `WHERE
  "tenantId"` (assertion query) updated the same way; also a `*.integration.test.ts`, skipped here.

Verified with a repo-wide grep: zero stale double-quoted `"tenantId"` column strings remain in
`packages/persistence` or `apps/worker`. The two remaining `"tenantId"` occurrences in
`snapshot-store.ts` are the intentional `AS "tenantId"` aliases described above, not stale
references.

## What was left named `tenantId` (and why)

Per the brief's ruling, left as-is (internal pipeline identifier that already carries the sub, or a
contract-level scope-type field, not compiler-forced):
- `packages/contracts/src/distrokid-pipeline.ts` — `finalizeJobSchema`'s `tenantId`, `DK_QUEUES`
  key builders (`SnapshotRef.tenantId`), all job schema fields. Contracts typechecked clean with no
  changes required at all.
- `packages/contracts/src/endpoint-registry-port.ts` — `RegistryScope.tenantId`,
  `DistributorEndpointProfile.tenantId`, `CandidateScope.tenantId`. Unchanged; these are the
  "scope TYPE field" the brief explicitly says may stay `tenantId`.
- Every DistroKid pipeline file's internal `tenantId` variable/parameter naming (`locks.ts`,
  `composition.ts`, `pipeline.ts`, `pipeline-queue.ts`, `deep-scan-runner.ts`,
  `distrokid-lyric-scan.ts`, `lyrics-verification.ts`, `main.ts`, `bullmq.ts`,
  `deep-scan-dispatch.ts`, `metrics.ts`, `snapshot-store.ts`'s `SnapshotCheckpointBinding`/
  `SnapshotProgress`/`SnapshotPrincipalBinding` interfaces, and all their `*.test.ts` fixtures) —
  left untouched. This is the ~20-file surface the brief explicitly says not to cosmetically rename.
- `principal-binding.ts`'s `SnapshotPrincipalBinding.tenantId` and `.artistWorkspaceId` — untouched
  (queue-job shape, not the search-store).

Renamed to `userId` only where forced by the search-store type or where a value crosses into a
`store.save(..., { userId })` binding: `finalize-result.ts`, `deep-scan-presence.test.ts`,
`principal-binding.ts`'s `record.*` accesses, and the fixtures in their `*.test.ts` files.

## Deviations from the literal brief

1. **`apps/worker/src/distrokid/snapshot-store.ts` (+ its integration test)** — fixed even though
   not named in the brief's file list, for the reason above (kind-2 breakage in worker's own raw
   SQL; leaving it would violate the task's own "run correctly against the new schema" goal).
2. **Brief step 4's exact command** (`npx tsc --noEmit -p apps/worker/tsconfig.json` run standalone)
   fails with `TS6059` "not under rootDir" errors — a pre-existing, unrelated structural issue:
   `apps/worker/tsconfig.json` sets `rootDir: "src"` but the package imports sibling packages
   (`@sentinel/db`, `@sentinel/adapters`, `@sentinel/browser-link`, ...) via path aliases pointing
   at their `src/`, which trips `rootDir` the moment that tsconfig is invoked in isolation. Verified
   this is untouched by this session (`git diff` on all tsconfig files is empty, last real change to
   `apps/worker/tsconfig.json` predates this branch) and is unrelated to tenantId/userId. The
   project's actual typecheck gate — `npm run typecheck`, i.e. `npx tsc --noEmit -p tsconfig.json`
   at the repo root — has zero errors in `contracts`/`persistence`/`worker` (confirmed above); only
   `apps/api`'s 55 pre-existing errors remain, as expected for Task 4b.
3. Fixed `packages/persistence/src/persistence.integration.test.ts`'s raw-SQL `"tenantId"` strings
   even though it's an integration test (skipped without a DB here), since it's still inside
   `packages/persistence` and the brief's green signal is "zero stale tenantId COLUMN strings
   remain in packages/persistence raw SQL" with no carve-out for integration tests.

## Concerns

- `principal-binding.ts`'s security-relevant rewrite (see kind 1 above) is a judgment call, not a
  mechanical rename: the old code independently verified the record's workspace against both the
  job's claimed workspace AND the consent's workspace; the new code can only compare the job's claim
  against the consent's actual workspace (the record no longer carries a workspace at all). The
  `ownerOf(record) === job.tenantId` and `consent.tenantId === job.tenantId` checks still anchor
  everything to the same tenant/user identity, and all 4 existing tests (including the "workspace
  substitution" and "legacy ownerless record" negative cases) pass, but Task 4b/a security reviewer
  should double check this reasoning against the full per-user threat model.
- `snapshot-store.ts`'s two `SELECT ... AS "tenantId"` aliases are a deliberate, narrow choice to
  avoid a multi-hundred-line internal rename in a file outside the brief's named scope; flagging in
  case a later task wants that file's internal naming fully migrated to `userId` for consistency.

## Verification

- `npx tsc --noEmit -p packages/contracts/tsconfig.json` — exit 0.
- `npx tsc --noEmit -p packages/persistence/tsconfig.json` — exit 0.
- `npx tsc --noEmit -p tsconfig.json` (repo root, matches `npm run typecheck`) — 55 errors, all
  `apps/api/*`, zero in `contracts`/`persistence`/`worker`.
- `npx vitest run packages/contracts packages/persistence apps/worker` — 17 test files passed, 4
  integration files skipped (no DB); 116 tests passed, 30 skipped, 0 failed.
- `grep -rn '"tenantId"' packages/persistence apps/worker` — only the two intentional `AS
  "tenantId"` aliases in `snapshot-store.ts`.
