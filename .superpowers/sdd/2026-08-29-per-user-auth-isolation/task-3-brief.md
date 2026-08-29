# Task 3 brief — Prisma schema teardown + destructive migration

Rewrite `packages/db/prisma/schema.prisma` to the per-user model (drop orgs/workspaces/invitations, re-point every FK to `userId`) and generate ONE new destructive forward migration. Fresh start is approved: no data preservation. The DB is wiped at rollout (a later task), so this migration only needs to produce the correct final schema when applied.

## Context / interfaces to match (already done in Tasks 1-2)

- The app-side store (`packages/search-store`) now keys `scan_records` on `user_id`, expecting EXACTLY these columns: `id`, `user_id` (text, NOT NULL), `artist`, `distributor`, `deep_scan_status`, `created_at`, `updated_at`, `record` (jsonb); and one index `scan_records_user_created_idx` on `(user_id, created_at desc)` plus `scan_records_created_idx`. Your `ScanRecord` model MUST produce exactly this.

## Steps

1. **Enumerate.** Run: `grep -nE "Tenant|Workspace|Organization|Membership|Invitation|tenantId|workspaceId|OrganizationRole|WorkspaceRole|MembershipStatus" packages/db/prisma/schema.prisma`. Read every model + enum it lists. Do NOT trust a hand-listed set.

2. **Rewrite `schema.prisma`:**
   - Delete enums `OrganizationRole`, `WorkspaceRole`, `MembershipStatus`.
   - Delete models `Tenant`, `Workspace`, `OrganizationMembership`, `WorkspaceMembership`, `OrganizationInvitation`, `InvitationWorkspaceGrant`.
   - For EVERY remaining model that has a `tenantId`/`workspaceId` field or a `@relation` to Tenant/Workspace (from Step 1 — e.g. `Artist`, `Release`, `Track`, `ScanJob`, `ConsentGrant`, and any others): remove those fields + relations and add `userId String @map("user_id")`, plus `@@index([userId])` (and, where the model already had a `(tenantId, createdAt)` index, replace it with `@@index([userId, createdAt(sort: Desc)])`).
   - **`ScanRecord`** (currently ~line 1214): replace `tenantId`, `ownerUserId`, `artistWorkspaceId` with a single `userId String @map("user_id")`; delete the three indexes `scan_records_tenant_created_idx`, `scan_records_tenant_owner_created_idx`, `scan_records_tenant_workspace_created_idx` and add `@@index([userId, createdAt(sort: Desc)], map: "scan_records_user_created_idx")`; KEEP `@@index([createdAt(sort: Desc)], map: "scan_records_created_idx")` and `@@map("scan_records")`. Preserve every other field/column (`deep_scan_status`, `record`, etc.) untouched.
   - Preserve each field's existing `@map("snake_case")` convention when renaming (so DB columns stay snake_case).

3. **Validate + generate (no DB needed):**
   - `npx prisma validate --schema packages/db/prisma/schema.prisma` → "valid".
   - `npx prisma generate --schema packages/db/prisma/schema.prisma` → client generates.

4. **Generate the migration SQL (no live DB — use the migrations as the "from" state):**
   - `npx prisma migrate diff --from-migrations packages/db/prisma/migrations --to-schema-datamodel packages/db/prisma/schema.prisma --script > /tmp/per_user.sql` (if `--from-migrations` needs a shadow DB and none is available, instead use `--from-schema-datamodel` against a copy of the pre-change schema, OR hand-write the SQL: `DROP TABLE ... CASCADE` for the six org tables + enums, and for each re-pointed table `ALTER TABLE ... DROP COLUMN tenant_id, DROP COLUMN workspace_id, ADD COLUMN user_id text NOT NULL`, plus the `scan_records` column/index swap).
   - Create `packages/db/prisma/migrations/20260830000000_per_user_isolation/migration.sql` containing that SQL. Make it self-consistent (drop dependents before parents; `CASCADE` where FKs exist). No data backfill.

5. **Commit:** `git add packages/db/prisma && git commit -m "feat(db): per-user schema, drop org/workspace/invitation tables"` (append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Do NOT push.

## Green signal for THIS task

`prisma validate` + `prisma generate` succeed, and the migration SQL exists and is internally consistent (drops the six org tables + three enums, re-points every model found in Step 1 to `user_id`, and applies the `scan_records` column/index swap matching the contract above). The migration is APPLIED against a real DB only at the rollout task; do not apply it now.

## Rulings carried from pre-flight

- `prisma generate` regenerates the client; code in `apps/api`, `packages/persistence`, `apps/worker` that reads `.tenantId` on these models will now fail to typecheck. That is Task 4/5 territory — do NOT fix it here. Your scope is `packages/db/prisma` only.
- Do NOT dispatch subagents.
