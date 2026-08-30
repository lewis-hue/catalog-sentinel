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

Task 4b (API re-scope): DONE_WITH_CONCERNS, commit be3520a. WHOLE-REPO typecheck clean, 762 tests pass, lint clean, user-isolation.test proves cross-user impossible + empty-sub 401. Deviations (vestigial non-auth): org-repo+tenant-erasure NOT deleted (worker governance-maintenance still imports them, no-op locally); artistWorkspaceId slot remains in distributor-connect/snapshot (fed the subject, not an auth boundary). Dispatching review.
Task 4b: complete (commits 57364e5..be3520a, review: SPEC ok, QUALITY strong, ISOLATION verified NO cross-user access; 0 Crit/0 Imp/3 Minor). WHOLE-REPO typecheck clean, 762 tests pass.
Task 4b: minor (deferred to final): (1) dead ConnectWorkspaceAuthorization* error branches; (2) vestigial artistWorkspaceId plumbing in distributor-connect/snapshot/browser-link (fed subject, dead hook); (3) orphaned web /organization page -> Task 7 deletes it.
Residual for final review (spec full-teardown intent): org-repo + tenant-erasure + governance-* cluster (packages/db) + worker governance-maintenance still exist (no live API path, no-op locally). User asked to REMOVE erasure/orgs fully; final review triages whether to delete the cluster before merge (cascades into worker + browser-link).

Task 6 (keycloak realm): DONE, commit 6f834aa, JSON valid, roles=user/platform_admin/service_worker, defaultRole grants user, no tenant_id/artist_manager/tenant_admin/google org mappers, loginTheme sentinel. Dispatching quick review.
Task 6: complete (commits be3520a..6f834aa, review SPEC ok 0/0/0).

Task 7 (frontend removal): DONE, commit b4416c7, web typecheck+lint 0, 57 tests pass. Dispatching review.
Task 7: complete (commits 6f834aa..b4416c7, review SPEC ok, 0/0/2 Minor). Minor (deferred to final): pre-existing user-facing "tenant" copy strings (auth/server.ts:254 comment, app/error.tsx:10, Overview.tsx:125) reference a removed concept - reword or leave.
ALL IMPLEMENTATION TASKS COMPLETE (1,2,3,4a,4b,6,7). Remaining: Task 8 rollout (DESTRUCTIVE - mandatory STOP). Running final whole-branch review first.

FINAL REVIEW: MERGE-READY. 0 Critical, 1 Important (deferrable), 3 Minor. Isolation verified end-to-end: NO cross-user access. MUST-FIX before merge: none.
Important (deferrable, recommend fast-follow): governance cluster (retention.ts, governance-adapters, organization-repository, tenant-erasure, worker governance-maintenance) still uses "tenantId"/"Workspace" in raw SQL but is INERT (production-AWS-gated, zero work on wiped DB, executed SELECTs do not name dropped columns, no live caller creates governance rows). Spec-teardown miss, not an isolation/rollout risk.
STOP: Task 8 (rollout) is destructive (wipe postgres + keycloak-db volumes). Awaiting user confirmation.

Task 8 (DESTRUCTIVE rollout): DONE + VERIFIED GREEN. User approved "Run the destructive rollout now." Wiped pgdata/keycloakdata/redisdata, fresh stack up. Migration per_user_isolation applied (exit 0). Keycloak re-imported single-role realm (themed login). Web 307, scanner listening clean.
Rollout surfaced a LIVE bug the final review missed (it only triaged the governance cluster): the DistroKid durable-recovery repo (packages/db/distrokid-recovery.ts) still named dropped column "recoveryArtistWorkspaceId" -> every worker-boot recovery sweep failed. Root-caused via improved sweep error log (was error.name only). T3 renamed ALL "tenantId" columns -> "userId" AND dropped every workspace column (verified: 0 tenantId columns, 0 workspace columns remain across 43 tables). Fix (commit e41d09e): recovery repo derives the collapsed workspace slot from userId (projected as tenantId), stops persisting a separate column; integration test round-trips it as the subject. Root typecheck clean. Worker now boots with ZERO recovery-sweep errors; pipeline+6 queues attached; store-check/web-verify path (search-store, already userId-scoped) unaffected.
Ruling (scope of column-rename sweep): Task 4a's tenantId->userId raw-SQL sweep was INCOMPLETE. Two latent buckets remain, NEITHER live on the local store-check path:
  (a) distributor-link/consent store (prisma-distributor-link-repo.ts: 5 raw-SQL "tenantId" + PrismaTenantStore hand-typed delegate passes {tenantId} to userId-field Prisma models) -> breaks a REAL connect/deep-scrape, but every call site is Steel-gated (distributor-link.ts, deep-scan-runner.ts, principal-binding.ts); un-testable locally. NOT dead code -> needs the tenantId->userId rename finished before production connect.
  (b) governance/erasure/audit/retention/organization cluster (~110 raw-SQL "tenantId" refs) -> governance.maintenance is not_started locally (production-AWS-gated); user's "full teardown" wants this cluster REMOVED, not renamed.
Cost if wrong: a production DistroKid connect would 500 at the consent/link store until (a) is fixed; local testing + auth isolation unaffected.
STOP (destructive boundary reached, per skill): surfacing to user. NOT merging/pushing (branch per-user-auth-isolation unmerged/unpushed). Decisions to present: finish (a) link-store rename now vs after live test; do the (b) governance-cluster REMOVAL (full-teardown) now vs later; merge timing.

FAST-FOLLOWS (user: "proceed in any order" -> did all three + merge):
- Phase A (0465bbd): finished tenantId->userId in prisma-distributor-link-repo (DistributorLinkRecord + ConsentRevocationIntent, the live API consent-revoke path); dropped the dropped artistWorkspaceId from ConsentRevocationIntent. Verified against live schema.
- Phase B (7ce780d): removed the inert, self-contained governance/erasure/org cluster (8 db modules + 5 tests) + worker governance-maintenance wiring + readiness gate. Only external consumer was the worker. Typecheck clean; 161 tests pass.
- Phase C (1b32331): finished the rename across the audit path -- PostgresAuditLogger INSERT/SELECT, the API health audit-schema probe (9->8 cols), and the BEFORE INSERT chain trigger sentinel_chain_audit_event() via new migration 20260830010000_audit_chain_userid (plpgsql body RENAME COLUMN could not rewrite; blocked every audit write). Append-only hash chain preserved, keyed by user_id.
Final sweep: 0 stale column refs remain in live code; the only tenant_id-referencing DB functions are the dormant audit-purge/anchor governance subsystem (self-consistent audit_purge_guards, or never-called) + the append-only guard (fires only on UPDATE/DELETE, works correctly). No triggers on any live app-write table.
VERIFIED LIVE: rebuilt image; migrate deploy applied 20260830010000 cleanly; worker boots zero errors; /health/ready -> ready:true (redis ok, scan-postgres ok, steel READY); audit-schema check complete=t; audit + link-store + recovery SQL all exercised against the live schema. Full backend suite: 683 passed / 0 failed / 46 integration-skipped.
DEFERRED (surfaced, non-blocking, no live path): drop the orphaned empty governance TABLES (RetentionPolicy, RetentionRun, TenantErasureRequest, audit_chain_heads/anchors, audit_purge_guards) + their dormant functions -- schema hygiene only; AuditLog stays (woven into the core repository abstraction). Cosmetic artistWorkspaceId->userId in-memory field rename (~90 refs, no behavior change).
MERGE: user authorized. Branch 13 ahead / 0 behind main -> merging to main.
