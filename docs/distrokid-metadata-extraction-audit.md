# DistroKid metadata extraction — audit

> Historical diagnostic evidence, not current production certification. Release
> evidence must be rerun against the immutable production image under the process
> in [production-acceptance.md](production-acceptance.md).

Audit of the extraction path before the network-first rewrite. Evidence is from live scans of a
real, user-authorized DistroKid account (98 releases / ~107 tracks).

## Root cause

**The extractor used DOM rendering as the point at which data was considered available.**

DistroKid's dashboard is a client-routed SPA. Navigating to `/dashboard/album/?albumuuid=…`
reloads the whole app, which then fetches the release JSON asynchronously. The page can load,
reload, or look visually complete while the JSON carrying ISRC / UPC / artwork / tracks is still
in flight — or while the component that would render it never mounts. Waiting on the DOM is
waiting on the wrong signal, so metadata was silently lost at scale.

### Evidence trail

| Change | Result | What it proved |
|---|---|---|
| `domcontentloaded`, 20s timeout, 4 tabs | 96/98 releases `page.goto: Timeout 20000ms exceeded` | Not merely "slow" |
| `domcontentloaded`, 60s timeout, 3 tabs | 75/98 still timed out at 60s | `domcontentloaded` **hangs** (blocking script never settles); more timeout can't fix it |
| `commit` + wait-for-rendered-UPC/ISRC, 2 tabs, 30s | Navigation fixed (3 errors), but only **46/107 tracks** had ISRC | Data exists but isn't rendered in time — DOM is the wrong gate |
| `Navigation … interrupted by another navigation to <same url>` | 3 releases | Confirms client-side routing/re-navigation per album |

Conclusion: no amount of timeout/concurrency tuning makes DOM-first extraction complete. The
authoritative data is the **JSON response the SPA itself fetches**.

## Findings by category

### 1. Fixed sleeps / DOM-readiness as synchronization

| File:line | Code | Verdict |
|---|---|---|
| `packages/browser-assist/src/distrokid-attended.ts:128` | `await page.waitForTimeout(700)` in the My-Music lazy-scroll loop | **Acceptable** — it is a scroll settle inside a `scrollHeight`-change loop with a break condition, not metadata synchronization. Not on the metadata path. |
| `distrokid-attended.ts:530,545,630,657` | `waitForTimeout(1500/900/pollMs)` in historical `BrowserSession` / CSV-download test helpers | **Test support only.** Not imported by the API/production worker or used by `readDistroKidCatalogFromPage`; the former runtime route was removed. |
| `packages/browser-assist/src/audiomack-web.ts:175,185,201` | `waitForTimeout` | Different adapter (Audiomack web verification). Out of scope. |
| `apps/worker/src/queue.ts:73` | `sleep(2 ** attempt * 50)` | **Correct** — exponential retry backoff, not a readiness wait. |

No `waitForLoadState` is used as a metadata-readiness signal anywhere.

**Primary metadata synchronization after this work = `page.waitForResponse` / response events.
No fixed sleep is on the metadata path.**

### 2. DOM-only ISRC/UPC extraction (the defect)

- `distrokid-attended.ts` → `scrapeReleaseDetailInPage()` ran in `page.evaluate` and regex-scraped
  `document.body.innerText` for UPC (`\d{12,13}`) and ISRC (`[A-Z]{2}[A-Z0-9]{3}\d{7}`).
- It was gated on `waitForFunction(() => /upc|isrc/.test(innerText))` — i.e. **DOM render**.
- On timeout it fell through to `toRawRelease(null, row, …)`, keeping only list-level info
  (title/artist) with **no error state distinguishing "absent at source" from "not captured."**

### 3. Partial completion without error state

- Releases that failed produced a `warnings[]` string but were still emitted as normal releases
  with `upc: null`, `isrc: null`. Downstream, a timeout was indistinguishable from a genuinely
  missing identifier → the UI reported "Missing" for data that was merely **not captured**.
- The snapshot had **no completeness contract**: it could return 98 releases with 46/107 ISRCs and
  be treated as success.

### 4. Identifier modeling

- `ReleasedTrack` flattened release-level `upc` onto every track, and coverage was logged as a
  single combined `"46 with ISRC, 47 with UPC"` over tracks — hiding which extraction failed.
- **UPC and artwork are release-level; ISRC is track-level.**

### 5. Steel / Playwright / CDP attachment

- `packages/browser-link/src/cloud-live-provider.ts` — Steel Cloud session via `POST /v1/sessions`,
  `chromium.connectOverCDP(websocketUrl + apiKey)`. CDP is available, so
  `context.newCDPSession(page)` is possible for a response-body fallback.
- `preparePageForEvaluate` injects the esbuild `__name` shim (string init script). Extra tabs
  created by the reader must get the same shim per-page (context-level `addInitScript` did not
  reliably propagate over Steel's CDP).

### 6. Jobs / checkpoints / storage

- `apps/worker/src/catalogue-read{,-queue}.ts` — a single `catalogue-read` job read the **entire**
  catalogue in one unit of work. A failure anywhere meant re-reading everything; **no per-release
  checkpoint, no retry-failed-only, no resume**.
- `search-store.ts` (`InMemory` / `Redis` / `Postgres` / `Tiered`) persists a whole `SearchRecord`
  per save; there was no per-release idempotency key.

### 7. Network capture (pre-existing)

- A discovery listener existed in `distributor-connect.ts` but was **manual**: it logged endpoint
  URLs for a human to read, then a human would hard-code the endpoint. Not a production mechanism.

## Required corrections (implemented)

1. Network-first extraction hierarchy; DOM demoted to fallback (#5 in the hierarchy).
2. Discovery mode separated from production extraction; candidates ranked automatically.
3. Context-level response capture; CDP `getResponseBody` fallback.
4. Endpoint registry + bundles (never assume one endpoint).
5. Schema-versioned Zod parsers; drift → `DEGRADED` + alert, never silent partial data.
6. Correct identifier modeling + separate coverage metrics.
7. Field-level status (`NOT_CAPTURED` ≠ `ABSENT_AT_SOURCE`).
8. Release-chunked, resumable BullMQ pipeline with retry-failed-only.
9. Completeness reconciliation; no snapshot marked complete with an unresolved release.
10. Sanitized capture: no cookies/headers/tokens/values/bodies in logs.

See `docs/distrokid-network-first-extractor.md` for the resulting design.
