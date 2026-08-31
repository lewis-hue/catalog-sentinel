# Reusable Session (Idle Keep-Alive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user rescan their distributor catalogue without a fresh attended login for a bounded idle window after a scan, reusing the same warm Steel session, without storing credentials.

**Architecture:** Today a connect session is one-shot: `confirmAndScan` claims it, starts the snapshot, then `ack()` deletes the durable record; the worker finalizer then releases the Steel session. This plan changes both edges to a keep-with-idle-expiry model - the durable record and the Steel session survive until an idle deadline (`min(now+idleWindow, consentExpiry, Steel plan cap)`) - while preserving the existing per-rescan re-authorization (`claim(connectId, principal)` + `authorizeWorkspaceEdit`) so a leaked connectId is still not authorization. The existing expired-claim reaper (`recoverAbandoned` → `claimExpired`) becomes the release path at idle expiry.

**Tech Stack:** Node.js/TypeScript ESM, Fastify (API), BullMQ (worker pipeline), Redis + Postgres (durable session/claim store), Steel cloud browser, Vitest.

## Global Constraints

- **Never store raw cookies, auth headers, access tokens, passwords, or 2FA codes.** Only the encrypted, opaque Steel reference (`DurableConnectSession.steelSessionId`, already `encryptor.encrypt`-ed into jobs) persists. (verbatim project rule)
- **Authorized-session-only, consent-bounded.** A reusable session must never outlive its consent grant; the idle deadline is `min(now+idleWindow, consentExpiry)`. Steel's own plan cap (free = 15 min per `cloud-live-provider.ts`) is the hard ceiling.
- **connectId is not authorization.** Every reuse re-runs `sessionRegistry.claim(connectId, principal, …)` and `authorizeWorkspaceEdit`; possession of the connectId never bypasses those.
- **Tunable/off:** idle window comes from `SESSION_IDLE_KEEPALIVE_MS` (default 900000 = 15 min). `0` = today's release-after-scan behavior (feature disabled).
- **Do not rebuild/redeploy** without explicit user go-ahead (build-deploy gating).

---

### Task 1: Idle-window config helper

**Files:**
- Modify: `apps/api/src/distributor-connect.ts` (near `connectClaimVisibilityMs`)
- Test: `apps/api/src/distributor-connect.test.ts`

**Interfaces:**
- Produces: `sessionIdleKeepAliveMs(env: NodeJS.ProcessEnv): number` - parsed, clamped `[0, 3_600_000]`, default `900_000`.
- Produces: `idleExpiryIso(nowMs: number, idleMs: number, consentExpiresAtIso: string | undefined): string` - ISO of `min(nowMs+idleMs, Date.parse(consentExpiresAtIso))`; when `idleMs === 0` returns ISO of `nowMs` (immediate expiry → release-after-scan).

- [ ] **Step 1: Write failing tests** for `sessionIdleKeepAliveMs` (default 900000; parses "600000"; clamps negatives to 0; clamps >3.6e6 to 3.6e6) and `idleExpiryIso` (idle < consent → now+idle; idle > consent → consent; idle 0 → now), following the existing `describe/it` + fake-`nowMs` patterns already in `distributor-connect.test.ts`.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/distributor-connect.test.ts -t "idle"` → FAIL (undefined).
- [ ] **Step 3: Implement** both pure helpers next to `connectClaimVisibilityMs` (mirror its clamp/parse style).
- [ ] **Step 4: Run** the same test → PASS.
- [ ] **Step 5: Commit** `feat(connect): idle keep-alive window config helpers`.

---

### Task 2: Worker finalizer keeps the session instead of releasing it

**Files:**
- Modify: `apps/worker/src/distrokid/composition.ts` (`releaseSession(job)` finalizer, ~line 322; and the `BrowserSessionSource` contract if a keep signal is needed)
- Test: `apps/worker/src/distrokid/composition.recovery.test.ts` (or a new `composition.keepalive.test.ts`)

**Interfaces:**
- Consumes: `FinalizeJob` (already carries `sessionExpiresAt`, `consentId`, `connectionId`, `tenantId`).
- Produces: finalizer behavior - on a **successful/terminal-complete** snapshot, do **not** call `sessions.release(job)` when keep-alive is active (`sessionIdleKeepAliveMs(env) > 0`); still call `recovery?.clear(job)` for the snapshot checkpoint. On terminal FAILURE/cancel it releases as today.

- [ ] **Step 1: Write failing test** - with `sessions.release` a spy and `SESSION_IDLE_KEEPALIVE_MS=900000`, a successful finalize does NOT call `release`; with `SESSION_IDLE_KEEPALIVE_MS=0` it DOES. Cancel/terminal-failure always releases. Follow the existing composition test harness (in-memory `sessions` stub) in `composition.recovery.test.ts`.
- [ ] **Step 2: Run** the new test → FAIL.
- [ ] **Step 3: Implement** the guard in `releaseSession`/finalizer: branch on `sessionIdleKeepAliveMs(opts.env)` and the terminal outcome. Keep the "never clear before release succeeds" invariant for the release branch.
- [ ] **Step 4: Run** → PASS, plus `npx vitest run apps/worker/src/distrokid` stays green.
- [ ] **Step 5: Commit** `feat(worker): keep Steel session warm after scan when idle keep-alive is on`.

---

### Task 3: Retain the durable connect session on ack (with idle expiry) instead of deleting it

**Files:**
- Modify: `apps/api/src/distributor-connect.ts` - `InMemoryConnectSessionRegistry.ack` (~247) and `RedisConnectSessionRegistry.ack` (~802); the `ConnectSessionRegistry.ack` contract may gain an options arg.
- Test: `apps/api/src/distributor-connect.test.ts`

**Interfaces:**
- Consumes: `idleExpiryIso` (Task 1).
- Produces: `ack(claim, opts?: { retainUntilIso?: string })` - when `retainUntilIso` is set, the registry keeps the record but updates `session.expiresAt = retainUntilIso` and releases the visibility claim (so the next `claim()` can re-acquire it); when absent, behaves exactly as today (delete). Reuse must still pass ownership/expiry checks in `claim`.

- [ ] **Step 1: Write failing tests** - `ack(claim, { retainUntilIso })` leaves the record claimable again (a subsequent `claim(connectId, samePrincipal, 'confirm', …)` returns `status:'claimed'` with `session.expiresAt === retainUntilIso`); `ack(claim)` (no opts) deletes it (existing behavior preserved); a `claim` after retention with a DIFFERENT principal still returns `ownership-mismatch`; a `claim` after `expiresAt` passed returns `not-found` (existing `Date.parse(expiresAt) <= nowMs` guard at line 207).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the retain branch in both registries (in-memory: update record + clear claim token instead of `records.delete`; Redis: set the session hash `expiresAt` + PEXPIRE to the retain window + release the claim key - mirror the existing Lua/TTL patterns already in the Redis registry).
- [ ] **Step 4: Run** → PASS; `npx vitest run apps/api/src/distributor-connect` green.
- [ ] **Step 5: Commit** `feat(connect): retain connect session on ack for warm reuse`.

---

### Task 4: `confirmAndScan` retains-and-reuses instead of consuming

**Files:**
- Modify: `apps/api/src/distributor-connect.ts` - `confirmAndScan` (~1263), the `ack` call after `startSnapshot` (~1345).
- Test: `apps/api/src/distributor-connect.test.ts`

**Interfaces:**
- Consumes: Task 1 `idleExpiryIso`/`sessionIdleKeepAliveMs`, Task 3 `ack(claim, { retainUntilIso })`.
- Produces: `confirmAndScan` behavior - on success calls `ack(liveClaim, { retainUntilIso: idleExpiryIso(now, sessionIdleKeepAliveMs(env), live.expiresAt) })` when keep-alive is on; a second `confirmAndScan(connectId, samePrincipal)` within the window succeeds WITHOUT a new attended login and reuses the same `live.steelSessionId`; the per-call `claim` + `authorizeWorkspaceEdit` re-authorization is unchanged.

- [ ] **Step 1: Write failing test** - with keep-alive on: first `confirmAndScan` starts a snapshot; a second `confirmAndScan` on the same connectId+principal starts ANOTHER snapshot reusing the same encrypted steelSessionId (assert `startSnapshot` called twice, same decrypted steelSessionId) and never requires re-creating a session. With a different principal, the second call throws `ConnectSessionOwnershipError`. With keep-alive `0`, the second call is `not-found` (today's behavior). Use the existing `confirmAndScan` test setup (fake registry + `startSnapshot` spy + `store`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the retain-on-ack call in `confirmAndScan`; guard by `sessionIdleKeepAliveMs(env) > 0`. Keep the existing `ack` failure handling (`connectSessionClaimLostError`).
- [ ] **Step 4: Run** → PASS; full `distributor-connect` suite green.
- [ ] **Step 5: Commit** `feat(connect): warm rescan reuses the retained session (re-authorized each time)`.

---

### Task 5: Reaper releases the Steel session at idle expiry

**Files:**
- Modify: `apps/api/src/distributor-connect.ts` - the expired-claim path (`recoverAbandoned` ~1437 / a dedicated `sweepExpiredSessions`) so an EXPIRED retained session (past `expiresAt`, not a cancel/confirm claim) results in `provider.terminateSession(steelSessionId)` + record delete.
- Test: `apps/api/src/distributor-connect.test.ts`

**Interfaces:**
- Consumes: `claimExpired`, `provider.terminateSession`/`releaseRemoteSession`.
- Produces: a sweep that, for a retained session whose `expiresAt` has passed, releases the Steel session and deletes the record (idempotent; a failed release keeps the record for retry - mirror the existing "never clear before release succeeds" invariant).

- [ ] **Step 1: Write failing test** - a retained session past `expiresAt` is picked by the sweep and triggers exactly one `terminateSession(steelSessionId)` then record deletion; a not-yet-expired retained session is left untouched; a release failure retains the record.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** by extending the `claimExpired` consumer to distinguish a retained-idle-expired session from a cancel/confirm claim and release it. Confirm a scheduler already invokes `recoverAbandoned`/the sweep on an interval (grep `recoverAbandoned(` in `app.ts`); if not on a timer for this path, add a bounded interval next to the existing session maintenance.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(connect): release warm sessions at idle expiry via the reaper`.

---

### Task 6: Sign-out / disconnect / consent-revoke terminate immediately

**Files:**
- Modify: `apps/api/src/distributor-connect.ts` and/or `apps/api/src/distributor-link.ts` (disconnect/consent-revocation already terminate Steel - extend to also drop a retained warm session); the sign-out/disconnect API route in `apps/api/src/app.ts`.
- Test: `apps/api/src/distributor-connect.test.ts`, `apps/api/src/distributor-link.test.ts`

**Interfaces:**
- Produces: on disconnect/sign-out for a `(tenant, connection)` and on consent revoke/expiry, any retained warm session is released (`terminateSession`) + record deleted immediately, ahead of idle expiry. Reuse the existing consent-revocation claim path (`claimByConsent`/`markConsentRevoked`/`completeCancellation`).

- [ ] **Step 1: Write failing test** - a disconnect (and a consent-revoke) releases a retained warm session immediately (`terminateSession` called; subsequent `confirmAndScan` → `not-found`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the terminate hooks, reusing the existing cancellation/consent-revocation reconciliation so there is one release path (idempotent).
- [ ] **Step 4: Run** → PASS; `distributor-link` + `distributor-connect` suites green.
- [ ] **Step 5: Commit** `feat(connect): terminate warm sessions on sign-out/disconnect/consent-revoke`.

---

### Task 7: Frontend warm-rescan affordance (optional, low-risk)

**Files:**
- Modify: `apps/web/app/connect/*` (the connect/scan UI) - a "Rescan" action that calls the existing scan endpoint (which now reuses transparently) and a subtle "session active" hint driven by the session `expiresAt` already returned by the API.
- Test: existing web tests / component test if present.

- [ ] **Step 1:** Add a "Rescan" affordance that hits the scan endpoint without initiating an attended login; show the login flow only if the API responds that no warm session exists.
- [ ] **Step 2:** Run `npm run --workspace apps/web typecheck` + `lint`.
- [ ] **Step 3: Commit** `feat(web): warm rescan without re-login`.

---

## Self-Review

- **Spec coverage:** idle keep-alive (Tasks 1,2,4), reuse (4), reaper release at idle+consent bound (1,5), terminate on sign-out/disconnect/consent-revoke/new-login (6; new-login is inherent - a fresh attended login creates a new connectId/session and the old one idle-expires or is dropped on disconnect), compliance/no-cookies (Global Constraints; nothing stores browser state), tunable/off via idle=0 (1,2,4). Frontend (7). Covered.
- **Placeholder scan:** none; each task has concrete methods (`ack`, `claim`, `confirmAndScan`, `claimExpired`, `terminateSession`) and real integration points. Test code follows the existing `distributor-connect.test.ts` harness (fake registry + spies), referenced explicitly rather than reproduced.
- **Type consistency:** `ack(claim, opts?)`, `idleExpiryIso`, `sessionIdleKeepAliveMs`, `retainUntilIso` used consistently across Tasks 1/3/4/5.
- **Security note:** the central risk is relaxing the one-shot property. Mitigation is in every reuse task: reuse always goes through `claim(connectId, principal)` + `authorizeWorkspaceEdit`; connectId possession alone never reuses.

## Sequencing note

This is a larger, security-critical change than the extraction fixes. Recommend landing it AFTER verifying the pending extraction scan (art/metadata + the `/mymusic` index under-count), which is higher immediate user impact. Tasks are independently testable and can be reviewed one at a time.
