# Search verification policy

The core integrity rule of Artist Catalog Sentinel:

> **We never present an unverifiable search result as a confirmed fact.**
> A song is only "confirmed missing" from a platform when an authoritative source
> (official API or profile scan) says so — not because a web search didn't find it.

## Evidence hierarchy (strongest → weakest)

1. **Official platform API** — Deezer, Apple/iTunes, Spotify, Audiomack, SoundCloud,
   TIDAL, YouTube (where keys/quota exist). ISRC/UPC exact match = highest confidence.
2. **User-authorized distributor data** — the DistroKid catalogue read over the
   user-attended Steel session (the "expected" set).
3. **Serper web verification** (hosted Google SERP API) — best-effort evidence for platforms
   with no API. Confidence-scored, on-page verified.
4. **Manual review** — a human confirms low-confidence / unverifiable cases.

## Why an empty web result ≠ "missing"

Search engines index some platforms deeply (Spotify, YouTube, Apple) and others barely at
all (Audiomack, TIDAL, Amazon, Boomplay). A miss on a poorly-indexed platform tells us
almost nothing. So:

- **High-index platform + strong query + on-page verification fails** → still only
  *evidence*, leaning toward `unverifiable`/`possible` — not an automatic `not-live`.
- **Low-index platform (Audiomack, TIDAL, Amazon, Boomplay)** → an empty result is
  `unverifiable` → **manual review**. It is **never** reported as `confirmed missing`
  without an official API or profile scan confirming absence.

## Verdicts

Current scan statuses (`live`, `not-live`, `wrong-profile`, `unverifiable`) map onto the
richer target decision set:

| Decision | When |
|---|---|
| `CONFIRMED_PRESENT` | Identifier match or official-API result. |
| `CONFIRMED_MISSING` | Official API / profile scan confirms absence (not a search miss). |
| `PROBABLE_PRESENT` | Strong evidence, 0.80–0.94 confidence. |
| `POSSIBLE_PRESENT` | Weak evidence, 0.60–0.79. |
| `WRONG_ARTIST_PROFILE` | ISRC present under a different artist. |
| `UNVERIFIABLE` | No API, weak/empty search, low index coverage. |
| `MANUAL_REVIEW_REQUIRED` | Confidence < 0.60 or unverifiable on a low-index platform. |
| `SKIPPED_NO_CAPABILITY` | Platform has no API and web verify disabled. |
| `SKIPPED_QUOTA_EXHAUSTED` | e.g. YouTube daily budget spent. |
| `SEARCH_PROVIDER_UNAVAILABLE` | Circuit breaker open / backend down. |

## Confidence scoring (current)

Implemented in `scanStorePresence` (`packages/adapters/src/stores/scan.ts`):

| Signal | Confidence |
|---|---|
| ISRC exact (catalogue index) | 1.00 |
| ISRC lookup, same artist | 0.95 |
| Wrong-profile (ISRC, different artist) | 0.90 |
| Title match (catalogue index) | 0.80 |
| API title-search hit | 0.85 |
| Web-verified title hit | 0.75 |
| API store miss (authoritative) | 0.80 → `not-live` |
| Web/no-API miss | 0.30 → `unverifiable` → **manual review** |

Anything **below 0.60** is flagged `needsManualReview`. A **degraded** store (its
catalogue read errored or reported an auth/quota/credential failure) has its misses
downgraded to `unverifiable` — a broken or rate-limited API can never emit a false
`not-live`.

## No evasion — by policy

We do **not** implement Tor, Privoxy, proxy/IP rotation, stealth browser plugins, CAPTCHA
solving, or any technique whose purpose is to bypass rate limits, bot protection, or
blocking. When a backend is throttled we **back off** (circuit breaker) and defer to
manual review. This is a deliberate compliance posture for selling to distributors and
platforms.
