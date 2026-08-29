# Task 3 report - Prisma schema teardown + destructive migration

## Status

DONE

Commit: `5989c93` - "feat(db): per-user schema, drop org/workspace/invitation tables" on branch `per-user-auth-isolation`.

## Step 1 - enumeration

Ran the brief's exact grep (`Tenant|Workspace|Organization|Membership|Invitation|tenantId|workspaceId|OrganizationRole|WorkspaceRole|MembershipStatus`) against the pre-change `packages/db/prisma/schema.prisma`: 202 matching lines. Read every model/enum it touched (all 1463 lines), not a hand-picked subset. Confirmed the pattern also catches `artistWorkspaceId` (contains "Workspace") across 8 models plus `DistroKidSnapshotCheckpoint.recoveryArtistWorkspaceId` - all of these were treated as scoping fields to collapse, matching the precedent the brief itself set for `ScanRecord` (`tenantId` + `ownerUserId` + `artistWorkspaceId` -> one `userId`).

Two fields were NOT matched by the literal pattern and were deliberately left alone: `AuditErasureReceipt.tenantHash`/`tenantDigest` and `AuditPurgeManifest.tenantDigest` (lowercase `tenant...`, not `tenantId`, and these are pseudonymous hash values with no FK - out of scope). Verified this by re-running the exact grep against the pre-change file; those lines never appear.

## Enums deleted

`OrganizationRole`, `WorkspaceRole`, `MembershipStatus`.

## Models deleted

`Tenant`, `Workspace`, `OrganizationMembership`, `WorkspaceMembership`, `OrganizationInvitation`, `InvitationWorkspaceGrant`.

## Models re-pointed to `userId`

Every model below had its `tenantId`/`workspaceId`/`artistWorkspaceId` field(s) and any relation to `Tenant`/`Workspace` removed, replaced by a single `userId String` (with `@map("user_id")` only where the model already used snake_case `@map` on its other fields, to preserve each model's existing mapping convention), plus `@@index([userId])`. Where a model had a `(tenantId, createdAt)`-shaped index, it became `@@index([userId, createdAt(sort: Desc)])` per the brief's rule.

Brief's named examples: `Artist`, `Release`, `Track`, `ScanJob`, `ConsentGrant`, `ScanRecord` (exact contract, see below).

Additional models re-pointed (all surfaced by Step 1's grep, "any others"):
`User`, `DistributorAccount`, `DSPAccount`, `CredentialReference`, `CatalogSnapshot`, `Issue`, `IssueEvidence`, `SupportPacket`, `ScanRun`, `RoyaltyReport`, `AuditLog`, `SecurityAuditEvent`, `AuditChainHead`, `AuditChainAnchor`, `AuditAnchorOutbox`, `BrowserLinkSession`, `BrowserStateRef`, `DistributorConnection`, `DeepScanRun`, `DeepScanCheckpoint`, `DistributorCatalogSnapshot`, `DistributorRelease`, `DistributorTrack`, `DistributorExtractionSnapshot`, `DistributorReleaseOutcome`, `DistributorTrackOutcome`, `DistributorEndpointProfile`, `DistributorEndpointCandidate`, `ScanEvent`, `ObjectStorageArtifact`, `DistributorLinkRecord`, `ConsentRevocationIntent`, `TenantErasureRequest`, `RetentionPolicy`, `RetentionRun`, `DistroKidSnapshotCheckpoint` + its six composite-key children (`DistroKidCheckpointIndex`, `DistroKidCheckpointOutcome`, `DistroKidCheckpointProgress`, `DistroKidCheckpointChunk`, `DistroKidCheckpointPassPlanChunk`, `DistroKidCheckpointTerminal`).

Notable per-model handling:

- **`ScanRecord`**: matches the brief's contract exactly - `id, user_id (not null, @map), artist, distributor, deep_scan_status, created_at, updated_at, record`; indexes `scan_records_created_idx` and `scan_records_user_created_idx` on `(user_id, created_at desc)`. Dropped the `@default("default")` that used to live on `tenantId` (no default now; every write must supply a real user id).
- **`User`**: had its own `tenantId` field even though it isn't one of the six deleted models, so it was re-pointed too: kept `id` as its internal PK, added `userId String` (the owning auth subject) as a distinct field, `@@unique([userId, email])`, `@@index([userId])`.
- **`ConsentGrant`**: `workspaceId` -> `userId` (the owner-scoping field); the pre-existing `grantedByUserId` field and its relation to `User.id` (an unrelated business fact, "who granted this consent") were left untouched.
- **`AuditLog`**: had both `tenantId` and an optional `workspaceId` - collapsed into one required `userId`.
- **`BrowserLinkSession`**: had `tenantId`, an *already-existing optional* `userId`, and `artistWorkspaceId` - all three collapsed into one required `userId` (same pattern as `ScanRecord`'s three-field collapse).
- **`DistributorConnection`**: `@@unique([tenantId, artistWorkspaceId, distributor])` -> `@@unique([userId, distributor])`.
- **`DistroKidSnapshotCheckpoint`** and its six children: composite PK `(tenantId, connectionId, snapshotId)` -> `(userId, connectionId, snapshotId)`, including the composite FK relations on all six child tables. `recoveryArtistWorkspaceId` (part of the recovery-authority JSON bundle, not the row's own scoping key) renamed to `recoveryUserId`.

## Deliberately left unchanged

- `AuditErasureReceipt` (`tenantHash`, `tenantDigest`) and `AuditPurgeManifest` (`tenantDigest`) - not matched by the literal field-name grep; pseudonymous hashes, no FK, out of scope.
- Model *names* `TenantErasureRequest` / `TenantErasureStep` - only their `tenantId` field was renamed to `userId`; the model names themselves were left as-is. Renaming the model would rename the generated Prisma Client accessor (`prisma.tenantErasureRequest...`), which is a different, larger kind of downstream breakage than the ".tenantId reads fail to typecheck" scope the ruling anticipated. Flagged below as a minor concern.

## Migration SQL - approach and output

Used `npx prisma migrate diff --from-migrations packages/db/prisma/migrations --to-schema-datamodel packages/db/prisma/schema.prisma --shadow-database-url <throwaway> --script`, per the brief's primary option. The shadow database was a brand-new, disposable `postgres:16-alpine` Docker container on a free host port (55432), created solely for this diff and removed immediately after (`docker run --rm ...` / `docker stop`). The project's real dev Postgres (`distrokid-postgres-1`) was never touched or used as the shadow target.

**Pre-existing drift check.** The raw diff also proposed 4 statements unrelated to org/tenant/workspace: `DROP TABLE "audit_purge_guards"` (a hand-written-SQL-only table with no Prisma model, before or after this change - used by the PL/pgSQL purge procedures), two `ALTER COLUMN ... SET DATA TYPE TIMESTAMPTZ(3)` fixes on `audit_erasure_receipts` and `audit_purge_manifests`, and one cosmetic `RENAME INDEX` on `DistributorReleaseOutcome`. I verified these are pre-existing repo drift, not caused by this task, by running the identical diff against the untouched (pre-edit, `git show HEAD:...`) schema - all 4 statements appeared there too, byte-for-byte. I excluded all 4 from the committed migration since dropping `audit_purge_guards` in particular would destroy a table the purge stored procedures depend on, and none of the 4 relate to org/tenant/workspace removal.

**End-to-end verification.** Replayed the full pre-existing migration history (all 18 prior migrations, in order) plus the new `20260830000000_per_user_isolation/migration.sql` against a second fresh throwaway Postgres container via raw `psql`, then re-ran `prisma migrate diff --from-url <applied db> --to-schema-datamodel schema.prisma --script`. The only remaining diff was exactly those same 4 pre-existing/unrelated statements - proof the committed migration fully and correctly closes every gap this task is responsible for, with nothing missing and nothing extra.

`packages/db/prisma/migrations/20260830000000_per_user_isolation/migration.sql` (691 lines): drops all workspace/tenant FKs and indexes first, then `ALTER TABLE ... DROP COLUMN ... ADD COLUMN "userId"/"user_id"` for every re-pointed table (composite PKs dropped and recreated with `userId` in place of `tenantId`), then drops the six org/workspace tables and three enums, then creates all new `userId`-based indexes/uniques, then re-adds the six DistroKid composite FKs. No data backfill (fresh start, per the brief).

## Validate / generate

- `npx prisma validate --schema packages/db/prisma/schema.prisma` -> "The schema ... is valid".
- `npx prisma generate --schema packages/db/prisma/schema.prisma` -> Prisma Client generated successfully (v6.19.3).
- Confirmed via grep that no `tenantId`, `workspaceId`, `OrganizationRole`, `WorkspaceRole`, `MembershipStatus`, or the six deleted model declarations remain anywhere in the new schema.

## Other changes

- Scrubbed the 11 pre-existing em-dash characters in `schema.prisma` comments (replaced with " - "), and updated the top-of-file and a few section comments that described the old multi-tenant/workspace model, since I was rewriting the whole file anyway and the no-em-dash rule applies to the final file content.
- Did NOT touch anything outside `packages/db/prisma`. Did not run `prisma migrate deploy`/`db push` against any real or persistent database.

## Deviations / concerns for the reviewer

1. **Judgment call on scope of "re-point every model."** The brief's bullet literally says "field named `tenantId`/`workspaceId`", but Step 1's own grep pattern (and the `ScanRecord` example) clearly intend `artistWorkspaceId`-named fields and the one pre-existing optional `userId` field on `BrowserLinkSession` to be swept into the same collapse. I followed that broader, consistent interpretation everywhere rather than the narrower literal field-name reading. If that's wrong, the affected models are exactly those listed under "Notable per-model handling" above.
2. **`User` model re-pointed even though not named in the brief's examples.** It has a `tenantId` field and isn't one of the six models slated for deletion, so by the general rule it had to be re-pointed. This does leave `User.userId` conceptually distinct from `User.id` (internal PK vs. the owning auth subject) - flagging in case the intent was actually to retire the `User` table entirely in favor of Keycloak-only identity.
3. **`TenantErasureRequest`/`TenantErasureStep` model names left as `Tenant*`** despite the tenant concept being gone; only their `tenantId` field became `userId`. A future cleanup task may want to rename these models (and regenerate the client) for consistency, but that's a larger, separate change than this task's mandate.
4. **Migration excludes 4 pre-existing/unrelated drift statements** (see above). If a later task wants those addressed too (the `audit_purge_guards` table, the two timestamp-type fixes, the index rename), they're independent of this refactor and can be a separate migration.

## Scope discipline

Did not touch `apps/api`, `apps/worker`, or `packages/persistence`. `.tenantId` reads there will now fail to typecheck, as the ruling anticipated - left for Task 4/5. Did not dispatch any subagents.
