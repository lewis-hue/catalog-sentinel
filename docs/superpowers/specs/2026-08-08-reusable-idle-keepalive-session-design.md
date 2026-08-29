# Reusable distributor session (idle-timeout keep-alive) — design

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation
**Author:** pairing session

## Goal

Let a user rescan their distributor catalogue without signing in again, for a warm window after a
scan — avoiding a fresh attended login (and the CAPTCHA/bot-detection/MFA step-ups a fresh login can
trigger). Do it **without increasing cost unboundedly** and **without weakening the compliance
posture**.

## Non-negotiable constraints (unchanged)

- **No stored credentials.** Never store raw cookies, auth headers, access tokens, passwords, or 2FA
  codes. Cookies stay *inside Steel*; the app persists only the **encrypted, opaque Steel session
  reference** (`BrowserLinkSession.providerSessionIdEncrypted`).
- **Authorized-session-only, consent-bounded.** A reusable session must never outlive the consent
  grant that authorized it.
- **Rejected alternative (explicitly):** the "stateless" approach — close Steel, export the browser
  auth state, store it in Redis/Postgres, replay later — is **out of scope and prohibited**. It
  violates the no-stored-credentials rule, turns the datastore into a credential vault (one breach =
  mass DistroKid account takeover), and is self-defeating (replaying cookies in a fresh browser
  context is a classic anti-fraud trigger, re-raising the very CAPTCHA/MFA it aimed to avoid).

## Chosen behavior: idle-timeout keep-alive

After a scan finalizes, **keep the live Steel session** instead of releasing it, but release it once
it has been idle (no rescan) for a bounded window. Rescans inside the window re-attach to the same
warm session and skip the attended login entirely.

- **Idle window:** `SESSION_IDLE_KEEPALIVE_MS`, default **~10–15 min**, configurable.
- **Hard bound:** effective keep-alive = `min(now + idleWindow, consentExpiry, steelPlanSessionCap)`.
  Steel caps a single session by plan (free plan = 15 min per `cloud-live-provider.ts`), so the real
  ceiling is the Steel plan; the mechanism uses whatever the plan allows.
- **Warm, not just alive:** a lightweight heartbeat (existing `lastHeartbeatAt`) keeps the session
  from idle-dying inside the window.

## Lifecycle / state machine

Reuse the existing `BrowserSessionStatus` enum
(`CREATED READY USER_ACTIVE LOGIN_CONFIRMED VALIDATED QUEUED_SCAN EXPIRED TERMINATED FAILED`).

1. First scan runs as today (attended login → `VALIDATED` → `QUEUED_SCAN`).
2. **Finalizer change:** instead of `releaseSession(job)` immediately, transition to a **reusable/idle**
   state (reuse `VALIDATED`) with an idle-release deadline (`expiresAt = min(now+idleWindow, consentExpiry)`).
3. **Rescan:** the scan flow first looks for a live reusable session for that `(tenant, connection)`;
   if found and not past deadline, **re-attach** via the encrypted reference, reset the idle deadline,
   and skip attended login. Otherwise, prompt a fresh attended login.
4. **Reaper/heartbeat worker:** periodically (a) heartbeats live reusable sessions to keep them warm,
   and (b) releases + marks `EXPIRED`/`TERMINATED` any past their deadline or consent bound. Reuse the
   existing session-claim / `claimExpired` / `expiresAt` infrastructure rather than adding a new store.

## Terminate immediately (before idle timeout) on

- **Sign-out / disconnect** (user's explicit choice) → release Steel + `TERMINATED` at once.
- **Consent revoked or consent grant expired** → release immediately (compliance hard line; reuses
  `markConsentRevoked`). Never let keep-alive exceed the consent window.
- **New attended login for the same connection** → release the prior session first (one live session
  per connection; no leaks).
- **Steel ends the session** (plan cap) → next rescan transparently falls back to one attended login.

## Integration points (to detail in the implementation plan)

- `apps/worker/src/distrokid/composition.ts` — `releaseSession(job)` finalizer: keep-vs-release + idle
  deadline transition.
- `apps/api/src/distributor-connect.ts` — the scan claim flow (`liveClaim`/`claimLive`) + reuse
  decision; the reaper/heartbeat sweep; sign-out/disconnect hook.
- `BrowserLinkSession` store — status transitions + `expiresAt`/`lastHeartbeatAt` updates (no schema
  change expected; columns already exist).
- Frontend — a "Rescan" affordance that reuses silently when warm; optional "session active" hint.

## Cost & security notes

- Cost is bounded by the idle window (not a full hour), so an idle session is released quickly.
- A kept-alive session is still a live authenticated browser: encrypted reference only, tenant-scoped,
  revocable, consent-bounded, auto-expiring.

## Testing

- Unit: finalizer keeps (not releases) within window; releases past deadline; consent expiry caps the
  deadline; sign-out/disconnect/new-login force immediate release.
- Unit: scan reuse picks a live reusable session and skips attended login; falls back to login when
  none live.
- Reaper: releases idle-expired + consent-expired sessions; heartbeats live ones.
- Existing worker + browser-link + api suites stay green.

## Rollout

Rebuild gated on explicit go-ahead. Ships behind a config default (idle window) so it can be tuned or
effectively disabled (idle window = 0 → release-after-scan, today's behavior).
