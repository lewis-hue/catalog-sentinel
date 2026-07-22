# DistroKid metadata — live test report

> Historical, authorized development evidence. It is not a current end-to-end
> acceptance run for the Steel-only production image. See
> [production-acceptance.md](production-acceptance.md).
> Counts, migration totals, and implementation gaps in this report are a
> 2026-07-22 snapshot. The reconciled current state is recorded in
> [production-evaluation-2026-07-22.md](production-evaluation-2026-07-22.md).

Status of the network-first extractor against the acceptance criteria.
Customer data is redacted throughout; identifiers below are the account owner's own catalog.

## 1. Root cause

**The extractor treated DOM rendering as the point at which data was available.** DistroKid's
dashboard is a client-routed SPA that reloads its whole app per album and hydrates the release
JSON asynchronously — so the page could be "loaded" while ISRC/UPC/artwork were still in flight,
or while the component never mounted.

Evidence from live scans of a real authorized account (98 releases / ~107 tracks):

| Configuration | Result |
|---|---|
| `domcontentloaded`, 20s, 4 tabs | 96/98 releases `page.goto: Timeout 20000ms exceeded` |
| `domcontentloaded`, 60s, 3 tabs | 75/98 still timed out **at 60s** → the event itself hangs |
| `commit` + wait-for-rendered-identifiers, 2 tabs, 30s | navigation fixed (3 errors) but only **46/107 tracks** had ISRC |
| `Navigation … interrupted by another navigation to <same url>` | proves per-album client-side re-routing |

Tuning timeouts/concurrency could not fix it: the signal was wrong, not slow.

## 2. Endpoint candidates discovered

**Pending a live discovery run on the authorized account.** The discovery service is implemented
and wired; it records ranked, sanitized candidates automatically:

```
GET /api/admin/distributor-scans/:scanId/endpoint-candidates
```

Each candidate carries: fingerprint, method, host, masked path (`/api/album/{uuid}`), query KEY
names, GraphQL `operationName`, schema KEY names, schema hash, score, rank, observations,
distinct-payload count, release-id correlation. **No values, cookies, headers, tokens or bodies.**

Scan logs also print, per scan:
```
metadata source — network-first N, DOM fallback N
catalog JSON endpoints (sanitized) → GET distrokid.com/api/… x<N>
coverage: releases N · UPC x/N · artwork x/N · tracks M · ISRC y/M
```

## 3. One endpoint or several?

**Not yet determined for the live account** — and the implementation deliberately does not assume.
`endpoint-bundle.ts` supports separate profiles per role (`catalogIndex`, `releaseDetails`,
`trackIdentifiers`, `artwork`, `storeDeliveryStatus`, `lyricsStatus`, `creditsStatus`), infers the
role from schema shape, and merges partial payloads. The split-endpoint case is covered by an
integration test (details endpoint + separate identifiers endpoint → merged release).

## 4. Parser versions

`distrokid-parser-v1` (Zod). Registry tries newest-first; total failure ⇒ `SCHEMA_CHANGED`
+ `SOURCE_SCHEMA_CHANGED` alert + endpoint `DEGRADED`. v1 is retained permanently for rollback.

## 5. Coverage — before / after

| | Before (DOM-first, live) | After (network-first) |
|---|---|---|
| Releases attempted | 98/98 | 100% by contract (unresolved ⇒ `PARTIAL_RETRYABLE`) |
| Track ISRC | **46/107 (43%)** | **1200/1200 in the current load fixture**; live pending |
| Release UPC | conflated with ISRC | reported separately |
| Artwork | not captured | release-level, reported separately |
| Failure vs absence | indistinguishable (`null`) | `NOT_CAPTURED` ≠ `ABSENT_AT_SOURCE` |
| Retry granularity | whole catalogue | failed releases only |

**Live re-verification is still required** to publish real after-numbers.

## 6. Failed releases and reasons

Live: pending. Every release now ends with a terminal outcome carrying a reason
(`TIMEOUT · REQUEST_FAILED · PARSE_FAILED · SCHEMA_CHANGED · REAUTH_REQUIRED · NOT_AUTHORIZED ·
RATE_LIMITED · BUDGET_EXHAUSTED · UNKNOWN`) — no release is silently skipped.

## 7. Tests run

The then-current working tree was validated on 2026-07-22. The counts below are
historical and have been superseded; they do not describe the 13-migration
2026-07-23 tree and do not replace the missing authorized Steel→DistroKid run.

| Suite | Count | Covers |
|---|---|---|
| Default repository run | **82 files / 665 passed / 43 environment-gated skipped** | Parser, network capture, six-stage pipeline logic, metadata truthfulness, principal isolation, consent/session lifecycle, history management, and UI behavior without external services |
| Disposable Redis/PostgreSQL run | **88 files / 707 passed / 1 skipped** | Fresh application of all 8 migrations, real BullMQ/Redis dispatch, PostgreSQL persistence, recovery, principal isolation, and pagination; only the credentialed live Audiomack test skipped |
| Catalogue load fixtures | **300 releases / 1,200 tracks** | Worker restart, timeout, malformed response, bounded memory, no duplicates, truthful completeness, all six BullMQ stages, and transactional persistence |
| Deep-scan load script | **1,200 tracks passed** | Chunking/call reduction and bounded local resource behavior on the non-browser deep-scan path |

### Scale-test matrix

| Requirement | Status |
|---|---|
| >1,000 tracks | ✅ 300 releases × 4 = 1,200 |
| ≥200 releases | ✅ 300 |
| worker restart mid-extraction | ✅ resumes, skips done chunks, no duplicates |
| one simulated endpoint timeout | ✅ retried alone → COMPLETE |
| one simulated malformed response | ✅ `FAILED_SCHEMA_CHANGED`, others unaffected |
| parser schema-change fixture | ✅ alert, not corrupt output |
| bounded memory | ✅ ≤1 chunk (20 releases) in flight |
| Steel reconnect | ⚠️ provider-level reconnect exists; **not yet exercised in the load test** |
| Redis flush → Postgres recovery | ⚠️ `TieredSearchStore` recovery verified previously; **not re-run for this pipeline** |

## 8. Remaining legal-review items

- **Direct authenticated JSON reader** — implemented, **disabled**. Requires
  `ENABLE_DISTROKID_DIRECT_JSON_READER` **and** `LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED`.
  Before enabling: endpoint observed during normal user-authorized navigation; access limited to
  the connected user's own catalog (enforced in code); rate limits preserved (enforced); legal /
  contractual approval or partnership; explicit user consent.
- **Artwork storage** — we persist the source URL only. Copying images to our own object storage
  needs an ownership/retention decision.

## 9. Credentials / session data

**Confirmed: no credentials or raw session data are logged or persisted.**
- No password/2FA collection anywhere; login is attended by the user in their own session.
- Capture reads only same-origin `xhr`/`fetch` JSON; bank/tax/payment/auth/session paths are
  denylisted and never read.
- Persisted/logged: endpoint SHAPE, schema KEY names, hashes, sizes, scores, ids. **Never**
  cookies, authorization headers, tokens, query/POST values, or response bodies.
- Sensitive key names are masked (`{redacted}`); errors reduce to a category.
- Asserted by tests (`no raw secrets in logs`, `candidates contain no values`, sensitive-route and
  analytics exclusion, `redactPayloadShape`).

## 10. Honest gaps

### The two bugs that mattered most were found by ONE test

A second audit found the pipeline's six workers were started but **nothing enqueued to them** —
the API still enqueued the older `catalogue-read` job. A consumer with no producer. It passed
every test because the tests called the stage functions directly and never touched a queue.

Writing the missing test (`pipeline-e2e.integration.test.ts`: real producer → real Redis → real
BullMQ → real workers) failed on its **first run** and exposed two defects that would each have
broken every production scan:

| Defect | Consequence |
|---|---|
| Job ids were colon-joined | BullMQ **rejects** ids containing `:`. Every enqueue would have thrown. **Zero jobs could ever have run.** |
| A lock-deferred chunk re-enqueued under the in-flight job's id | BullMQ silently discards the duplicate. With one chunk at a time per account, **every chunk after the first vanished** — any catalogue over 20 releases hangs at "reading…" forever, with no error anywhere. |

Both are fixed and pinned by tests. The lesson generalizes: **a queue test that dispatches its own
handlers proves nothing about the queue.** 390 green tests did not.

### Still open

1. **Live coverage numbers are not measured** — a scan on the authorized account is required to
   fill §2, §3, §5 and §6 with real values. Everything there is still "pending", not "achieved".
   This is the remaining extractor-coverage item that requires authorized account
   access; it is not the only production blocker. Legal/privacy approval, current
   Steel acceptance, identity/workspace controls, retention/erasure, KMS, supply
   chain, IaC, and HA/DR gates are tracked separately in production acceptance.

   The procedure is now a script rather than an improvised session, so the run is reproducible and
   the numbers are checkable:

   ```bash
   # 1. Connect the distributor and run a scan in the UI (attended login, your own browser).
   # 2. Read the results back — READ-ONLY; it cannot start or modify a scan:
   npm run live:coverage -- --scan <searchId> --out docs/live-coverage-<date>.md
   ```

   It reports the endpoint candidates actually observed, REST vs GraphQL, single vs bundle, and
   ISRC/UPC/artwork coverage **each separately** — the questions this report has been carrying as
   unanswered.

2. **Steel reconnect** is not exercised (the load test is a fast in-memory simulation, not the
   deployed topology).
3. **Parser v1 is the only variant** — correct today, but the live payload shape should be pinned
   into a v2 fixture once discovery reports the real endpoint.
4. **Resolved after this historical run:** the legacy DOM/single-job runtime
   route and its configuration selector were removed. The production path is the
   six-stage network-first pipeline.
5. **CI has not run on a real PR yet** — the workflow is verified locally (the exact command,
   including the skip-detector, was executed against real Redis + Postgres), but it has not
   executed on GitHub's runners.
6. **Session handles still travel in job payloads.** `steelSessionId` is a handle rather than a
   credential, but an encrypted, revocable reference resolved server-side would be better than
   putting a provider-native id where queue-inspection tooling can read it.

### The API no longer imports the worker

`apps/api` depended on `@sentinel/worker` for the search store, three queue producers and a
deep-scan dispatcher — so an HTTP server transitively pulled in Playwright, a browser runtime and
a scan executor it never used. The shared parts now live in packages:

| Package | What moved | Why it isn't in an app |
|---|---|---|
| `@sentinel/contracts` | job payloads, queue names, idempotent job ids, metadata model, storage ports | both apps must agree on the wire format; neither should own it |
| `@sentinel/queue-client` | DistroKid / presence / catalogue-read / deep-scan **producers** | enqueuing is not executing — the API needs only this half |
| `@sentinel/search-store` | in-memory / Redis / Postgres / tiered stores + manual-review | both the API (serves records) and the workers (write results) need it |
| `@sentinel/persistence` | durable Postgres stores for outcomes, endpoint profiles, candidates | a database layer must not transitively import a browser |

Two behaviours the API genuinely could not keep — **executing** a deep scan in-process — are now
injected by a composition root (`AppDeps.runDeepScanInline`, `DistributorLinkService`'s
`dispatcher`). An API that cannot execute a scan is the point, not a limitation: it enqueues and
serves state.

An ESLint boundary rule (`@typescript-eslint/no-restricted-imports`, `allowTypeImports: false`)
fails the build if `apps/api` imports the worker again. **Verified in both directions** — it fires
on a value import AND a type-only import, and passes on the clean tree. Tests may still import
both halves: composing the system under test is a test's job.

### Durable persistence — verified against a real database

The historical disposable infrastructure run applied the **8 migrations that
existed on 2026-07-22** to a fresh PostgreSQL database, exercised real
Redis/BullMQ, and completed **88 test files / 707 passing tests**. These counts
are retained only as historical evidence. The current release gate requires all
13 migrations and the aggregate results recorded in
[production-acceptance.md](production-acceptance.md). The historical run asserted:

| Property | Why it is tested with real SQL |
|---|---|
| Idempotent finalize | Three redelivered finalizes leave **one** snapshot and two releases — not three copies of a catalogue. A wrong `ON CONFLICT` target is invisible to a typechecker. |
| Transactional | A mid-write failure rolls back completely: no snapshot claiming COMPLETE over half a catalogue. |
| Failures persisted | A `FAILED` release is a **row with a reason code**, not an omission. The free-text detail is *not* stored (it can quote response content) — asserted. |
| `ABSENT_AT_SOURCE` ≠ `TIMEOUT` | Both store `upc = NULL`; only the status says which is our failure and therefore retryable. |
| Tenant isolation | Same fingerprint under two tenants → two rows with independent status. One tenant cannot read or overwrite another's profile. |
| Schema enforces the allowlist | `information_schema` is queried to prove **no raw/payload/body column exists** on any catalog table, and that `DistributorTrackOutcome` has **no `upc`** — the model is checked, not just the code. |

The current infrastructure run includes the **300-release/1,200-track**
transactional persistence fixture, all six producer-to-worker BullMQ stages, and
deterministic Redis/PostgreSQL traversal of **205 history records**. The only skip
is the live Audiomack test, which needs an authorized account.

`scripts/assert-infra-tests-ran.mjs` was itself verified in both directions: it **fails** the build
when the suites skip, and passes when they run. A guard that never fires is not a guard.

### Fixed in response to the audits

| Finding | Fix |
|---|---|
| **Retry reconciliation deduplicated away (P0)** | `pass` on the job + in `jobIds.reconcile`/`finalize`; per-pass chunk tracking. It was also a default function param the queue could never supply, so every reconcile thought it was pass 1 and retried forever — a loop masked only by the id collision that dropped it |
| **Steel session lost on retry (P0)** | `refOf()` carries the handle through every hop, so a stage cannot drop it by omission |
| **API imported the worker (P1)** | `search-store` + `queue-client` packages; inline execution injected, not imported; ESLint boundary rule verified to fire on value AND type-only imports |
| **Temporal attribution sold as correlation (P1)** | Correlation derives from the REQUEST (path/query/GraphQL/body) matched against known ids in memory; only the CATEGORY is stored |
| **Stale tracks orphaned (P1)** | Authoritative finalize deletes tracks not in the incoming set, and all of them when a release becomes a failure |
| **Endpoint profile fields dropped (P1)** | `schemaKeys`/`schemaDriftCount` persisted; `candidateScore` given its own column (it was overloading `validationCount`); `endpointFingerprint` written |
| **Pipeline was opt-in (P1)** | It is the default; `inprocess` is REFUSED in production; `/api/catalogue/engine` reports what actually runs |
| **Lock renewal tied to checkpoint cadence (P1)** | Heartbeat on a timer at ⅓ TTL; `LockLostError` aborts rather than continuing unlocked |
| **Cross-tenant reads (P1)** | `SearchRecord` gained `tenantId`; `TenantScopedSearchStore` binds it once; 404 not 403 so ids aren't an enumeration oracle |
| **Infra tests unreachable from the host** | `npm run test:infra` — loopback-only throwaway Redis/Postgres, migrate, run, tear down |
| **Nothing enqueued the pipeline (P0)** | `@sentinel/queue-client` producer; API now always enqueues `CatalogIndexJob` on login confirmation |
| **Registries process-local (P1)** | `PostgresEndpointRegistryStore` + `PostgresCandidateStore` in `@sentinel/persistence`; tenant-scoped, upsert-on-natural-key, 16 tests against real Postgres |
| **Infrastructure tests always skipped (P1)** | CI provisions Redis + Postgres; the 2 previously-skipped suites now run; `assert-infra-tests-ran.mjs` fails the build if any gated suite skips |
| **Job ids broke BullMQ (P0, found by the new test)** | Sanitized segments + deterministic short hash; `:` impossible; pinned by `job-ids.test.ts` |
| **Deferred chunks silently dropped (P0, found by the new test)** | `deferAttempt` participates in the job id + jittered delay; capped by `MAX_CHUNK_DEFERS` and fails loudly |
| **Finalized outcomes not persisted (P0)** | `DistributorExtractionSnapshot` / `ReleaseOutcome` / `TrackOutcome` + migration + transactional, idempotent `outcome-repository.ts` |
| **Pipeline startup failure swallowed (P0)** | No try/catch: if composition fails, the worker fails to start rather than reporting healthy with a dead pipeline |
| Pipeline never started (P0, first audit) | Composition root + `startDistroKidPipelineWorkers` in `main.ts` |
| Checkpoints not durable (P0, first audit) | `RedisSnapshotStore`; in-memory fallback logs a loud warning |
| Candidate store process-global + mutable `beginScan` (P0) | `{tenantId, scanId}` passed explicitly per write; reads tenant-scoped; cap off-by-one fixed |
| Endpoint profiles didn't constrain capture (P1) | ACTIVE-profile matching + release correlation; heuristic only during discovery/drift (7 tests) |
| API imported the worker app to queue (P1) | `@sentinel/contracts` + `@sentinel/queue-client`; contracts depend on nothing |
| Prisma identifier/provenance model wrong (P1) | Migration drops `DistributorTrack.upc` and both `rawSourceJson` columns; adds field status/source/parser version |
| Two engines coexisting (P1) | **Resolved after this report:** the legacy runtime engine and selector were removed |
| CI never ran lint; infra tests always skipped (P1) | Lint added (root **and** web); Redis + Postgres services; `assert-infra-tests-ran.mjs` fails the build if a gated suite skipped |
| `npm audit`/gitleaks swallowed failures | `\|\| true` and `continue-on-error` removed |
| Test timeouts read as flaky | Cause was pool oversubscription; bounded in `vitest.config.ts` rather than inflating timeouts |
| Next.js optional-dep warnings | OTel/AWS marked external (server) / `false` (client); build is warning-free |
| Direct reader ran BEFORE passive capture (P1) | Passive always first; replay needs 2 flags **and** a per-run policy (default `never`) |
| CDP fingerprinted everything as GET (P1) | `requestWillBeSent` captures real method + GraphQL operation/variable KEY names |
