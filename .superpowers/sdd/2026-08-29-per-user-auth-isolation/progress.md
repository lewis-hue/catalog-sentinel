# SDD ledger — plan: docs/superpowers/plans/2026-08-29-per-user-auth-isolation.md

Setup: branch per-user-auth-isolation off checkpoint a3bc794; spec+plan at efaad26. Working on the branch (sufficient isolation off a clean checkpoint; no separate worktree).

Task 0 (branch): complete — per-user-auth-isolation created.

Pre-flight scan (tasks sharing files/interfaces):
- search-store: T1 (types + scoping + in-memory) -> T2 (postgres). Interface: SearchRecord.userId, listForUser/pageForUser, SearchStore.save gains owner {userId}. Consistent.
- app.ts: T4 (API re-scope) -> T5 (worker enqueue). Consistent (userId).
- schema: T3 depends on T1/T2 field names (userId, user_id). Consistent.
Rulings:
- Ruling: Tasks 1-3 intentionally leave the FULL repo non-compiling (API still imports PrincipalScopedSearchStore / references tenantId) until T4 lands the API re-scope. Plan documents this. T1-T3 reviews verify the task's OWN unit tests + diff quality, NOT a full-app typecheck. Cost if wrong: broken intermediate state closed by T4; final review catches residue.
- Ruling: SearchStore.save signature gains owner param {userId} in T1; T2 + in-memory/redis stores must match. Carried into T1/T2 dispatches.
- Ruling: Task 8 (destructive rollout: wipe postgres + keycloak-db volumes) is a mandatory STOP; confirm with the user before wiping.

Task 1 (store scoping): implementer DONE_WITH_CONCERNS, commit 4ee30c5, 8 tests pass. Concerns: (1) search-store standalone typecheck fails only in T2/T4 files (expected); (2) saveDerived implemented self-contained on UserScopedSearchStore (carry to T4 to reconcile app.ts call site); (3) tenant-isolation.test.ts left importing deleted names (T4 renames it to user-isolation). Dispatching task review.
Task 1: complete (commits efaad26..4ee30c5, review clean; SPEC ok, QUALITY approved).
Task 1: minor (deferred): userId:'' collision guard needed before real JWTs (belongs to T4 where req.auth.sub is wired) — carry to T4 + final review.
Task 1: minor (deferred): tenant-isolation.test.ts imports deleted names (T4 renames it to user-isolation.test.ts).

Task 2 (postgres/tiered/build user_id): DONE, commit ab26ea1, tsc clean for packages/search-store, 38 pass +1 skip. Concerns non-blocking: real DB migration is T3; dropped unused tenantId ctor param; no revision column. Dispatching review.
Task 2: complete (commits 4ee30c5..ab26ea1, review clean; SPEC pass, QUALITY approved, 0 findings).

Task 3 (prisma schema + migration): DONE, commit 5989c93, validate+generate pass, replayed migrations vs throwaway PG (zero drift). Concerns to carry: User model re-pointed to userId (verify); TenantErasure* models left vestigial (erasure removed in T4 - consider dropping in T4/final). Dispatching review.
Task 3: complete (commits ab26ea1..5989c93, review clean; SPEC pass, QUALITY approved, 0 findings; migration replayed vs real PG).
Ruling: re-order — run plan Task 5 (contracts+persistence+worker tenantId->userId) as Task 4a BEFORE the API layer (Task 4b), because apps/api imports @sentinel/persistence + @sentinel/contracts and cannot compile until those are re-pointed. Cost if wrong: none material; both still land before Keycloak/frontend. Carry to 4b: wire scoped.saveDerived (T1 exposed it), guard req.auth.sub non-empty (T1 minor), rename tenant-isolation.test.ts -> user-isolation.test.ts, delete org files, drop/keep vestigial TenantErasure* models (erasure removed).
Ruling (worker scope): the DistroKid pipeline keys locks/queues/checkpoints/recovery by an internal tenantId that ALREADY carries the user sub. Isolation is enforced by the search-store user_id scoping (T1-2) + user_id DB columns (T3), NOT the pipeline variable name. Task 4a re-points ONLY what correctness/compilation force: (a) prisma-model write fields tenantId->userId (forced by the T3 client regen), (b) packages/persistence outcome writes to the user_id column/field, (c) the UserBoundSearchStore binding takes the sub value. The pipeline internal tenantId routing identifier stays (out of scope for a cosmetic 20-file rename). Cost if wrong: internal naming reads tenantId while meaning userId; no isolation impact (search-store + columns enforce it). Green for 4a: worker+persistence+contracts typecheck + tests pass.

Task 4a (contracts+persistence+worker): DONE, commit 57364e5, those 3 typecheck +116 tests pass; 55 remaining errors are apps/api (T4b). Concerns: fixed extra raw-SQL bug in worker snapshot-store.ts; principal-binding.ts isolation check REWRITTEN (security-critical - review closely). Dispatching review.
Task 4a: complete (commits 5989c93..57364e5, review: SPEC ok, 1 Important ruled below, isolation verified against 3 attack shapes).
Task 4a: Ruling (plan-conflict) — the Important finding (principal-binding lost the record-side workspace anchor) conflicts with the plan, which REMOVES workspaces. User boundary is intact (record.userId + consent user cross-checked). Do NOT re-add workspace anchoring. Instead STRIP the vestigial artistWorkspaceId from the job payload (contracts), consent checks, and principal-binding as part of Task 4b workspace removal. Cost if wrong: a same-user could forge a cross-workspace job field, but no workspaces exist so no effect.
Task 4b MUST include: (a) API re-scope; (b) delete org routes/service/erasure + db files; (c) rework tenant-isolation.test -> user-isolation.test, delete organization-routes.test; (d) wire scoped.saveDerived; (e) guard req.auth.sub non-empty; (f) strip vestigial artistWorkspaceId (contracts job payload + consent + principal-binding); (g) whole-repo npm run typecheck green + all tests pass.
