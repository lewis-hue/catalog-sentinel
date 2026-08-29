# Task 4a review — contracts + persistence + worker re-scope

Reviewed diff 5989c93..57364e5 (commit 57364e5) against task-4a-brief.md.

## Verification performed

- `npx tsc --noEmit -p packages/contracts/tsconfig.json` — exit 0 (confirms report).
- `npx tsc --noEmit -p packages/persistence/tsconfig.json` — exit 0 (confirms report).
- `npx tsc --noEmit -p tsconfig.json` (root) — remaining errors are all in `apps/api/*`
  (search-history-pagination.test.ts, search-principal-isolation.test.ts), zero in
  contracts/persistence/worker. Confirms report's claim.
- `npx vitest run packages/contracts packages/persistence apps/worker` — 116 passed, 30 skipped
  (all `*.integration.test.ts`, no DB here), 0 failed. Confirms report.
- `grep -rn '"tenantId"' packages/persistence apps/worker/src` — only 2 hits, both the intentional
  `SELECT "userId" AS "tenantId"` aliases in `apps/worker/src/distrokid/snapshot-store.ts:626,836`.
  Zero stale bare `WHERE/INSERT/CONFLICT "tenantId"` column references remain.
- Cross-checked every raw-SQL-touched model (`DistributorEndpointCandidate`,
  `DistributorEndpointProfile`, `DistributorExtractionSnapshot`, `DistributorReleaseOutcome`,
  `DistributorTrackOutcome`, `DistroKidSnapshotCheckpoint` + its six child tables) against
  `packages/db/prisma/schema.prisma`: every model declares `userId String` with no `@map`, so the
  literal case-sensitive column really is `"userId"`. Cross-checked the migration SQL
  (`20260830000000_per_user_isolation/migration.sql`): each of these tables does
  `DROP COLUMN "tenantId" / ADD COLUMN "userId"`, confirming the renamed target column is exactly
  what the raw SQL now references. All renames in the diff are correct.
- Searched `apps/worker/src` and `packages/persistence/src` for `prisma.<model>.` client calls:
  none exist (confirms report's finding that these packages don't write via Prisma client
  directly; that path lives in `packages/db`, out of scope).
- Searched for em dashes in the diff content: none found in the actual 11 changed files (the
  em dashes turned up by an initial overly-broad `git diff` were pre-existing content in unrelated
  files outside this task's diff, not introduced here).
- Read `packages/search-store/src/search-store.ts`: confirms `SearchRecord` has only `userId`
  (no `ownerUserId`/`artistWorkspaceId`/`tenantId`) — this is pre-existing (Task 1), not something
  4a introduced or could avoid.
- Read `DistributorConnection` in schema.prisma: `@@unique([userId, distributor])` — no workspace
  dimension at the connection layer any more, consistent with the "workspace" concept being
  vestigial post-refactor (only `LinkConsent`, out of scope, still carries it).

## principal-binding.ts — detailed isolation analysis

Old check (pre-diff):
```
!record.ownerUserId || !record.artistWorkspaceId → fail closed
ownerOf(record) === job.tenantId
&& record.artistWorkspaceId === job.artistWorkspaceId       // record-anchored
&& consent.tenantId === job.tenantId
&& consent.artistWorkspaceId === record.artistWorkspaceId   // record-anchored
&& consent.grantedByUserId === record.ownerUserId
```

New check (post-diff):
```
!record.userId → fail closed
ownerOf(record) === job.tenantId
&& consent.tenantId === job.tenantId
&& consent.artistWorkspaceId === job.artistWorkspaceId      // consent-anchored, direct
&& consent.grantedByUserId === record.userId
```

Traced both cross-user attack shapes the docstring names ("a forged same-tenant payload must not
attach Alice's Steel session to Bob's scan, or vice versa"):

1. **Record belongs to a different user than the job claims** (`record.userId = 'tenant-a'`,
   `job.tenantId = 'tenant-b'`): `ownerOf(record) === job.tenantId` still fails this exactly as
   before. Rejected. Correct.
2. **Job forges `job.tenantId` to match the record's real owner, but supplies a consentId that
   belongs to a different actual user**: `repository.consents.get({ tenantId: job.tenantId },
   job.consentId)` is itself scoped by `job.tenantId`; a consent created under a different tenant
   is not retrievable under this scope (out of scope for 4a, but this pre-existing behavior in
   `packages/db` is what the check depends on and it is unchanged). `!consent` → fail closed.
   Rejected. Correct.
3. **Consent granted by a different subject than the record owner** (covered by the existing test
   "rejects a consent granted by another same-tenant subject"): `consent.grantedByUserId ===
   record.userId` still catches this — mechanically identical to the old
   `consent.grantedByUserId === record.ownerUserId`, since `ownerUserId` collapsed into `userId`.
   Rejected. Correct.

All three cross-user paths are preserved exactly. The three-way anchor
(`record.userId === job.tenantId === consent.tenantId`, plus `consent.grantedByUserId ===
record.userId`) still fully binds record ownership to job claim to consent identity. No path was
found where the new code passes a job whose target record belongs to a different user's sub.

**One structural weakening, not a 4a-introduced cross-user defect:** the old code independently
verified workspace two ways — `record.artistWorkspaceId === job.artistWorkspaceId` (job's claim
vs. the record's own stored workspace) AND `consent.artistWorkspaceId === record.artistWorkspaceId`
(consent vs. record) — a double anchor through the record. The new code can only do
`consent.artistWorkspaceId === job.artistWorkspaceId` (job's claim vs. consent directly), because
`SearchRecord` no longer carries any workspace field at all (removed wholesale by the
already-shipped, out-of-scope Task 1 search-store refactor — verified directly in
`search-store.ts:208-231`, there is no way for `packages/persistence`/`apps/worker` code in this
task's scope to reintroduce it without reopening Task 1's package). This means a same-user,
cross-workspace job forgery (job names a *different* one of that same user's own workspaces than
the one the target record was actually created under) is no longer caught by a record-side check;
it is only prevented to the extent a valid, non-revoked consent for that claimed workspace must
still exist and must have been granted by that same user. Given `DistributorConnection` is now
`@@unique([userId, distributor])` (no workspace dimension left at the connection layer), it's
unclear the multi-workspace-per-user shape this check originally defended against is even still
reachable in the current schema — but that determination sits outside this task's file scope.
The implementer's own report flags this exact tension in its "Concerns" section, so it is not a
silently-introduced gap. Recorded below as Important, not Critical, because it does not create any
path where one user's job can bind or write another user's record — the reviewer's stated primary
criterion is not violated.

## Findings

### Important
1. `apps/worker/src/distrokid/principal-binding.ts:34-38` — the workspace binding check lost its
   record-side anchor (`record.artistWorkspaceId === job.artistWorkspaceId`) because `SearchRecord`
   no longer carries a workspace field (pre-existing Task 1 constraint, not fixable in 4a's scope).
   The remaining `consent.artistWorkspaceId === job.artistWorkspaceId` still requires a real,
   non-revoked, same-user consent for the claimed workspace, so no user boundary is crossed, but a
   same-user cross-workspace queue-payload forgery is no longer independently caught at the record
   level. Flag for the security reviewer / Task 1 follow-up to confirm whether multi-workspace-per-
   user is still a reachable shape given `DistributorConnection` is now unique per `(userId,
   distributor)`; if not reachable, this is moot.

### Minor
None found.

## Spec compliance checklist

- Kind 1 (Prisma-client field renames): no direct `prisma.<model>.*` writes exist in
  `apps/worker`/`packages/persistence` (confirmed by grep); the actual forced renames were at the
  `@sentinel/search-store` `SearchRecord` boundary, correctly identified and fixed by the
  implementer as the practical equivalent of "kind 1."
- Kind 2 (raw-SQL columns): every raw-SQL site in `candidate-store.ts`, `endpoint-registry-store.ts`,
  `outcome-repository.ts`, their integration test, and `snapshot-store.ts` (+ its integration test,
  reasonably in-scope per the brief's own "run correctly" goal even though not literally named)
  correctly renamed to `"userId"`, verified against schema.prisma and the migration SQL.
- Internal-tenantId-name ruling followed: contracts left untouched (`tenantId` fields kept where the
  brief permits); pipeline's internal `tenantId` routing/lock/queue/checkpoint variable names in
  ~20 files left untouched (verified no unexpected renames present in the diff — the Stat block
  only touches 11 files, matching exactly what the brief's ruling should have produced); the two
  `SELECT ... AS "tenantId"` aliases in `snapshot-store.ts` are the correct minimal-footprint way to
  keep the DB column correct while leaving the internal `SnapshotCheckpointBinding`/
  `SnapshotProgress` TS shape (and its ~20-file cascade) alone.
- `ProfileRow`/`toProfile()` in `endpoint-registry-store.ts` correctly tracks the real
  `userId` DB column while still projecting the contract-facing `tenantId` field outward — read vs.
  write shape is consistent (verified `SELECT *` returns `userId`, row type renamed to match, output
  mapping renamed to `tenantId: row.userId`).
- Test hygiene: `principal-binding.test.ts` still has a real negative assertion covering workspace
  substitution (`artistWorkspaceId: 'workspace-b'` → false) and tenant substitution (→ throws), a
  legacy-ownerless-record fail-closed case, and a revoked-consent fail-closed case — all still
  meaningfully assert, none were hollowed out to make them pass. `deep-scan-presence.test.ts`'s
  cross-tenant rejection test (`runStorePresenceDeepScan(..., 'tenant-b')` against a record owned by
  `tenant-a`) still asserts `.rejects.toThrow(/tenant/i)`. `finalize-result.test.ts`'s cross-tenant
  test still asserts `.toThrow(/tenant/i)` against a record with a substituted `userId`.
- No em dashes or AI-icon-style additions found in the diff.
- `apps/api` untouched by this diff (confirmed via Stat block — 11 files, none under `apps/api`) and
  still fails typecheck as expected for Task 4b.

## Verdicts

SPEC: compliant, no gaps against the brief.
QUALITY: good — correct, minimal-footprint changes; the implementer's own report already
self-identifies the one open judgment call (workspace anchor) rather than hiding it.
Critical: 0. Important: 1. Minor: 0.

Principal-binding isolation one-liner: the rewritten check still fully rejects any job whose target
record or consent belongs to a different user (`record.userId`/`consent.tenantId`/
`consent.grantedByUserId` are all still cross-checked against `job.tenantId` exactly as before,
verified against three attack shapes), and the only real loss is a same-user cross-workspace
record-side double-anchor that could not survive `SearchRecord` dropping the workspace field in
the earlier, out-of-scope Task 1 refactor.
