# Task 4a brief — contracts + persistence + worker re-point to user scope

Task 3 regenerated the Prisma client with `userId` (was `tenantId`) on every re-pointed model, and renamed the DB columns. Your job: make `packages/contracts`, `packages/persistence`, and `apps/worker` compile AND run correctly against the new schema, preserving isolation (every DB row scoped by the user's `sub`). Do NOT touch `apps/api` (that is Task 4b) or `packages/search-store` / `packages/db/prisma` (done).

## The two kinds of breakage you must fix

1. **Compiler-forced (Prisma CLIENT writes):** any code doing `prisma.<model>.create/update/upsert/findMany({ where/data: { tenantId ... } })` on a re-pointed model now fails typecheck because the field is `userId`. Change the FIELD to `userId`. These are in `apps/worker` (e.g. the DistroKid pipeline finalize/persist paths) and possibly `packages/persistence`.

2. **Compiler-INVISIBLE (raw SQL column names):** `packages/persistence/src/candidate-store.ts` and `endpoint-registry-store.ts` (and any sibling raw-SQL store) query a literal `"tenantId"` COLUMN (e.g. `WHERE "tenantId" = $1`, `ON CONFLICT ("tenantId", ...)`, column lists). Task 3 renamed that column. FIRST read `packages/db/prisma/schema.prisma` for the affected models (`DistributorEndpointCandidate`, the endpoint-registry model, and any other model these raw-SQL stores target) to learn the EXACT new column name (`userId` if the field has no `@map`, or `user_id` if it has `@map("user_id")` — check which T3 used per model). Then update every raw-SQL reference (`WHERE`, `INSERT` column list, `ON CONFLICT`, `SELECT`) to that exact new column name. This will NOT show up as a typecheck error, so grep to confirm zero stale `"tenantId"` column references remain in `packages/persistence`.

## Ruling carried from pre-flight (bounds your scope — read carefully)

The DistroKid pipeline keys locks/queues/checkpoints/recovery by an INTERNAL `tenantId` identifier that already carries the user's `sub`. Isolation is enforced by the search-store `user_id` scoping and the `user_id` DB columns, NOT by this variable name. Therefore:
- **Do NOT undertake a cosmetic rename** of the pipeline's internal `tenantId` routing/lock/queue/checkpoint variable across ~20 files. Leave those names as-is.
- On the TypeScript side, the raw-SQL stores' scope TYPE field may STAY named `tenantId` (it holds the sub) to avoid a cascade of worker call-site renames — only the SQL COLUMN string changes.
- ONLY rename to `userId` where the Prisma CLIENT typing forces it (kind 1 above) or where a value crosses into the search-store binding (`UserBoundSearchStore(store, <sub value>)`).

## Files

- `packages/contracts/src/*` — check the job schemas (`presenceJobSchema` etc.). If a job payload field is named `tenantId` and it carries the sub, you MAY leave it named `tenantId` (the api will send the sub into it); change it only if the compiler forces it. Note what you decide.
- `packages/persistence/src/*` — raw-SQL column fixes (kind 2) + any Prisma-client writes (kind 1).
- `apps/worker/src/*` — Prisma-client write field renames (kind 1); ensure the search-store binding uses the sub value.

## Steps

1. `npx tsc --noEmit -p packages/contracts/tsconfig.json`, then `packages/persistence`, then `apps/worker` — collect the real compiler errors (kind 1). Fix each by renaming the field to `userId` at the Prisma-client call site.
2. Read `schema.prisma` for the raw-SQL-targeted models; update all raw-SQL column references in `packages/persistence` to the new column name (kind 2). Grep to confirm no stale `"tenantId"` column string remains in raw SQL.
3. Run tests: `npx vitest run packages/contracts packages/persistence apps/worker` (integration `*.integration.test.ts` stay skipped without a DB). Fix fixtures that referenced the old field/column.
4. Confirm typecheck: `npx tsc --noEmit -p packages/persistence/tsconfig.json` and `-p apps/worker/tsconfig.json` pass.
5. Commit: `git add packages/contracts packages/persistence apps/worker && git commit -m "feat(worker): user-scoped writes and persistence columns"` (append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). Do NOT push.

## Green signal for THIS task

`packages/contracts`, `packages/persistence`, `apps/worker` typecheck AND their unit tests pass; zero stale `"tenantId"` COLUMN strings remain in `packages/persistence` raw SQL. `apps/api` is expected to STILL fail (Task 4b). Do NOT dispatch subagents.
