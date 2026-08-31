# DistroKid album-page parser - design

**Date:** 2026-08-08
**Status:** Approved (design), pending implementation
**Author:** pairing session

## Problem

Live authorized scans finalize `FAILED` with every release `TIMEOUT` (observed: `search_9a891907…`, 5/5 TIMEOUT). Root cause was traced end-to-end (code → worker logs → Redis/BullMQ → Postgres), **not guessed**:

- Attended Steel login succeeds; the catalog **index** reads the correct release count (5) over the authenticated session.
- Persisted per-release refs are valid, distinct album URLs: `https://distrokid.com/dashboard/album/?albumuuid=…`.
- During per-release navigation, **zero** JSON responses are captured (`DistributorEndpointCandidate = 0`, `DistributorEndpointProfile = 0`). DistroKid's album page renders track/ISRC/UPC/artwork as **server-side HTML**, not via an AJAX/JSON endpoint.
- `NetworkFirstExtractor.tryLowerTiers()` supports Tier-4 (`readPageState`, embedded JSON) and Tier-5 (`readDom`, DOM) fallbacks, but the DistroKid composition constructs the extractor **without wiring either callback** (`apps/worker/src/distrokid/composition.ts` ~L372). So when no JSON response exists, `tryLowerTiers()` returns `null` → `TIMEOUT`.

**Ruled out** (with evidence): anti-bot/Cloudflare/CAPTCHA (index read succeeded); session expiration (session alive; index read seconds earlier); the read-only guard (fix confirmed live in the running bundle; 0 blocks this scan).

## Non-goals / posture

- **Authorized-session-only** is retained. No residential proxy rotation, no stealth fingerprint plugins, no storing raw cookies/auth tokens. Session cookies remain inside Steel; workers re-attach by opaque session id.
- Out of scope for this spec (separate follow-ups): parallel/paced chunk extraction, long-scan session keepalive, ISRC→store (Spotify/Apple/MusicBrainz) enrichment.

## Design

### Phase 1 - Ground-truth capture *(1 rebuild + 1 attended scan)*

Diagnostic gated behind `DISTROKID_ALBUM_CAPTURE_DIR` (unset = no capture; default off). For the first 1–2 releases only, after the album page fully loads, write to a mounted host scratch dir:

- rendered `page.content()` (real markup),
- inline `<script>` JSON blobs (reveals embedded-JSON vs. pure-DOM),
- a manifest of every response's **sanitized-URL + content-type + status** (bodies **not** written) - definitively proves whether any JSON endpoint exists.

To avoid a wasted round-trip, this build also carries a **best-effort** parser inferred from the working catalog-index DOM scraper; if it already works we get 5/5 in this same scan, otherwise the capture shows exactly how to fix it.

**Compliance for the capture:** album/release pages only (never billing/tax/payment/banking/address/account-security/profile pages); local gitignored dev artifact; no external egress; personal/token fields redacted before any committed fixture is derived; capture writes to a file, never to structured logs.

### Phase 2 - DistroKid album-page reader *(write freely; rebuild only to test)*

New isolated module `packages/browser-assist/src/distrokid/album-page.ts` exporting:

- `readDistroKidAlbumPageState(page)` - Tier-4, returns embedded JSON state if present (parsed via existing `parsers.parse(state, 'PAGE_STATE')`).
- `readDistroKidAlbumDom(page)` - Tier-5, returns a `CanonicalDistributorRelease` (tracks[title, ISRC], UPC, artwork) scraped from the DOM.

Wire both into the extractor opts at `composition.ts` (the `NetworkFirstExtractor` construction). Reuse DOM patterns from `distrokid-attended.ts`'s catalog-index scraper. Unit-tested against the redacted fixture from Phase 1.

### Phase 3 - Live verify *(1 rebuild + 1 attended scan)*

Confirm 5/5 `COMPLETED` with real tracks/ISRC/UPC/artwork persisted (`DistributorReleaseOutcome` / `DistributorTrack`).

## Interfaces / boundaries

- The reader module is pure (page in → `CanonicalDistributorRelease`/state out), independently testable without Steel.
- The capture harness is a separate, env-gated concern that does not alter the default extraction path when disabled.
- `tryLowerTiers()` seam is unchanged; we only supply the two callbacks it already expects.

## Testing

- Unit tests for `album-page.ts` against a redacted/synthetic fixture (no live browser).
- Existing browser-assist suite must stay green.
- Live acceptance: one attended scan → 5/5 COMPLETED with non-empty tracks + ISRC coverage.

## Rollout

Two rebuilds total (Phase 1 capture, Phase 3 verify), **each gated on explicit go-ahead** (build-deploy gating). Writing Phase 2 code needs no rebuild until we test.

## Risks

- DistroKid markup may differ from the catalog-index patterns → mitigated by capturing ground truth first (Phase 1).
- Embedded JSON may carry CSRF/session values → redact before deriving fixtures; never persist raw capture to the repo.
- Track-count mismatch guard in `complete()` will fail a release if extracted count ≠ `expectedTrackCount` → the reader must extract all track rows, verified against the fixture.
