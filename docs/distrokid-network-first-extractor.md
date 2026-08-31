# DistroKid network-first extractor

> **The rule:** rendered DOM completion is *not* metadata availability. The authoritative data is
> the JSON response the SPA itself fetches. Never make DOM extraction the primary mechanism.

See `docs/distrokid-metadata-extraction-audit.md` for the root-cause analysis this replaces.

## Status - read this before trusting anything below

A claim like "the adapter *is* network-first" can be true of a library while the running product
still does something else. So each capability is labelled by how far it has actually got:

| Stage | Meaning |
|---|---|
| **LIB** | implemented + unit-tested in isolation |
| **FIXTURE** | proven against a real browser / fixture integration test |
| **WIRED** | constructed and started by the running app (a real scan reaches it) |
| **INFRA** | verified against real Redis/Postgres/Steel in the deployed topology |
| **LIVE** | verified on an authorized real account, with published coverage |

A capability is only **WIRED** if a real application request reaches it. "The workers are running"
is not wiring - the pipeline had six live consumers and *no producer* for an entire review cycle,
and every test passed throughout, because the tests dispatched to the stage handlers directly and
never enqueued anything.

| Capability | Status |
|---|---|
| Network-first capture, scoring, sanitized fingerprints | LIB · FIXTURE · **WIRED** (in-process reader + pipeline) |
| Versioned Zod parser + drift → DEGRADED/alert | LIB · FIXTURE · **WIRED** |
| Identifier modeling (UPC/artwork release-level, ISRC track-level) | LIB · FIXTURE · **WIRED**; UPC dropped from `DistributorTrack` in the schema |
| Field-level status (`NOT_CAPTURED` ≠ `ABSENT_AT_SOURCE`) | LIB · FIXTURE · **WIRED**; **persisted** to `DistributorReleaseOutcome`/`DistributorTrackOutcome` |
| Six-stage release-chunked pipeline | LIB · FIXTURE · **WIRED end-to-end** - API producer (`@sentinel/queue-client`) → real Redis → six workers, proven by `pipeline-e2e.integration.test.ts` |
| API → pipeline producer | **WIRED**. Login confirmation always enqueues `distrokid-catalog-index`; no alternate catalogue reader exists |
| Durable checkpoints and recovery authority | **WIRED** to PostgreSQL with Redis as disposable orchestration/cache state; an application-envelope-encrypted recovery record and 15-second sweep reconstruct BullMQ work after API/worker/CDP/Redis loss while the original Steel lease and immutable deadline remain valid |
| Durable outcomes (system of record) | **INFRA** - verified against real Postgres: idempotent, transactional, failures persisted with reason codes |
| Endpoint-profile–constrained matching | **WIRED** - production matches ACTIVE profiles + correlates the release id; heuristic only during discovery/drift |
| Endpoint registry / candidates | **INFRA** - `PostgresEndpointRegistryStore` + `PostgresCandidateStore`, tenant-isolated, verified against real Postgres |
| CDP fallback | LIB · **WIRED**; POST/GraphQL identity fixed. Not yet fixture-tested |
| Gated direct reader | LIB · FIXTURE · WIRED, **OFF** (2 flags + per-run policy) |
| Legacy/inline catalogue readers | **REMOVED** from the runtime and configuration surface |
| Redis-flush → PostgreSQL recovery | **VERIFIED** in the Docker-backed suite at 1,100 releases with exact counts and no duplicates; live Steel reconnect remains pending, and no recovery is promised after lease expiry |
| Live coverage numbers | **NOT measured** - see the live-test report |

### Two defects the real-Redis end-to-end test caught immediately

Both were invisible to 390 passing tests, because a fake queue has no BullMQ semantics:

1. **Every job id contained `:`** - BullMQ rejects those outright (`Custom Id cannot contain :`).
   Every enqueue would have thrown. The pipeline could never have run a single job in production.
2. **A lock-deferred chunk re-enqueued under the in-flight job's id**, so BullMQ discarded it as a
   duplicate and the chunk vanished silently. With one-chunk-at-a-time per account, that stranded
   every chunk after the first: any catalogue over 20 releases would hang at "reading…" forever.

The lesson is in the test now, not just in this doc: a queue test that dispatches its own handlers
proves nothing about the queue.

Everything below describes the design as implemented; consult the table above for how far each
part is actually proven.

## Extraction hierarchy

| # | Tier | Status | Where |
|---|---|---|---|
| 1 | Official / approved distributor API | not available for DistroKid | - |
| 2 | **Observed authenticated JSON response** | **DEFAULT** | `network-discovery.ts` → `extractor.ts` |
| 3 | Authenticated request replay | **gated** (feature + legal flags, default OFF) | `direct-reader.ts` |
| 4 | Embedded page / hydration state | fallback | `ExtractorOptions.readPageState` |
| 5 | DOM extraction w/ event-based waits | fallback only | `ExtractorOptions.readDom` |
| 6 | User-uploaded CSV / export | separate path | `/api/distributor-imports/csv` |

Browser ingestion stays separate from platform scanning/matching (`@sentinel/browser-assist`
extracts; `@sentinel/adapters` + the presence deep-scan match).

## Two modes

### Discovery mode (`NetworkFirstExtractor.discover(sample)`)
Runs over 5–10 releases. Installs **BrowserContext**-level response listeners *before* the first
navigation (context-level covers secondary pages, frames and service-worker-served requests),
captures same-origin JSON only, scores it, detects GraphQL operations, fingerprints the endpoint,
and emits an **automatically ranked** candidate report. Candidates feed the registry, so no one
reads raw logs after a dashboard change.

Admin surface: `GET /api/admin/distributor-scans/:scanId/endpoint-candidates` (sanitized only).

### Production mode (`NetworkFirstExtractor.extractRelease(ref)`)
Installs the waiter, navigates, then **waits for the metadata response** - not for a component.
Parses via the versioned registry, merges endpoint bundles, and returns a **terminal outcome**.

```ts
const ex = new NetworkFirstExtractor(page, { origin: 'distrokid.com', distributor: 'DISTROKID' }, { parsers: new ParserRegistry(), registry });
await ex.install(allowedReleaseIds);      // BEFORE any navigation
const outcome = await ex.extractRelease({ releaseId, dashboardUrl });
```

**No fixed sleeps are used for metadata synchronization.** The only bounded waits are
event-driven (`waitForCatalogResponse`, `waitForDifferentEndpoint`, `waitForFunction`).

## Candidate scoring (`candidate-scoring.ts`)

Rewards `isrc`/`upc` (10), `barcode` (8), `tracks`/`artwork` (5), release/track ids (4), title/artist (2).
Penalizes analytics, feature-flags, notifications, profile/billing shapes - so a config blob can't
outrank the real endpoint. `MIN_CATALOG_SCORE = 10` (≈ one strong identifier signal).

Extra ranking signals: a payload that **varies per release** is boosted; one that is **identical
across releases** is demoted (it can't be release data).

## Endpoint registry (`endpoint-registry.ts`)

```
CANDIDATE ──success──> VALIDATING ──3 successes──> ACTIVE
     ▲                                               │ 3 failures / schema drift
     └──────────── RETIRED <── DEGRADED <────────────┘
```
Promotion/demotion is automatic. Schema drift marks `DEGRADED` and raises
`SOURCE_SCHEMA_CHANGED` - it never guesses.

**Durable and tenant-scoped.** The store is `PostgresEndpointRegistryStore`
(`@sentinel/persistence`), keyed `(tenantId, distributor, fingerprint)`. Two properties matter:

- *Durable*, because the registry's entire job is to remember which endpoint works. Memory that
  evaporates on deploy doesn't do that - each restart silently reverted production to
  shape-guessing until it revalidated, and two replicas could disagree about which endpoint was
  ACTIVE, so the same account extracted differently depending on who picked up the chunk.
- *Per-tenant*, because a global registry is a shared mutable surface: one account whose dashboard
  serves an unusual payload could promote a bad profile - or degrade a good one - for everybody.
  Each tenant validates independently. That costs a few extra validation captures and contains the
  blast radius to one account.

Scope is passed explicitly (`RegistryScope`), never held as an ambient "current tenant" - the
composition builds one registry **per job** over the shared store.

## Endpoint bundles (`endpoint-bundle.ts`)

Never assume one endpoint returns everything. Roles: `catalogIndex`, `releaseDetails`,
`trackIdentifiers`, `artwork`, `storeDeliveryStatus`, `lyricsStatus`, `creditsStatus`.
`inferRole()` derives the role from schema shape. When the first response has gaps the extractor
waits (event-driven) for a **sibling endpoint**, then merges - filling gaps without ever
overwriting a `PRESENT` value. Artwork is accepted only from distributor-correlated
`NETWORK_JSON` evidence; the extractor does not substitute DSP artwork or synthesize an image URL.

## Versioned parsers (`parser-v1.ts`, `parser-registry.ts`)

Zod-validated, newest-variant-first. `parseDistroKidReleaseV1` locates the release object inside
an arbitrary envelope, then strictly extracts allowlisted fields and validates identifier formats
(ISRC `^[A-Z]{2}[A-Z0-9]{3}\d{7}$`, UPC `^\d{12,14}$`) - a malformed value is rejected, not trusted.
Add `distrokid-parser-v2` to `PARSER_VARIANTS`; **never delete v1** (rollback is config, not code).

## Identifier modeling (`metadata-model.ts`)

- **UPC → release-level.** **Artwork → release-level.** **ISRC → track-level.**
- The post-scan field audit also covers release date, upload date, and label, plus
  every track ISRC. Explicit `ABSENT_AT_SOURCE` is terminal truthful evidence;
  every extractor-owned gap is retryable.
- Coverage is reported separately - never a combined "ISRC/UPC" number:

```
releases 250 · UPC 249/250 · artwork 250/250 · tracks 1000 · ISRC 998/1000
not-captured: UPC 0, ISRC 0 · absent-at-source: UPC 1, ISRC 2
```

## Field-level status

Every field is a `MetadataField<T>` with `status`, `source`, `capturedAt`, `parserVersion`:

`PRESENT · ABSENT_AT_SOURCE · NOT_CAPTURED · PARSE_FAILED · REQUEST_FAILED · TIMEOUT ·
REAUTH_REQUIRED · NOT_AUTHORIZED · UNKNOWN`

`NOT_CAPTURED` is **never** rendered as "Missing":
> `ISRC: not captured - distributor metadata request timed out`

## Gated direct reader (`direct-reader.ts`)

```bash
ENABLE_DISTROKID_DIRECT_JSON_READER=false
LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED=false
```
Both must be true. Even then it refuses ids not discovered from the connected user's own catalog
(no enumeration), refuses cross-origin/sensitive URLs, enforces `DISTROKID_REQUEST_MIN_DELAY_MS`,
and **halts permanently** on reauth / 403 / 429. Default remains **passive capture**.

## Pipeline (`apps/worker/src/distrokid/`)

```
extractDistroKidCatalogIndex → planDistroKidReleaseChunks → extractDistroKidReleaseChunk (×N)
      → retryFailedDistroKidReleases → reconcileDistroKidSnapshot → finalizeDistroKidSnapshot
```
Chunked by **release** (20), never by track. Idempotent job ids
(`distrokid-release-chunk:tenant:conn:snapshot:idx`), a **distributed lock per connection**
(1 concurrent read per account; concurrent across accounts), checkpoints every 10, exponential
backoff **with full jitter**, batched writes, resume-after-crash, and
**retryable-release-only** processing. A completed release with a field-level
capture failure is retried because track metadata is release-scoped; complete
releases are not reread.

## Completeness (`completeness.ts`)

`COMPLETE · COMPLETE_WITH_SOURCE_GAPS · PARTIAL_RETRYABLE · PARTIAL_REAUTH_REQUIRED ·
FAILED_SCHEMA_CHANGED · FAILED`

A snapshot is **never** COMPLETE while any indexed release lacks a terminal result, or while any
gap is *our* failure rather than a source gap. Reconciliation audits UPC, artwork
URL, release date, upload date, label, and each ISRC, merges stronger retry
evidence without dropping verified tracks/fields, and never marks the result
`COMPLETE` until all retryable gaps close. Exhausted work remains explicitly
partial or failed.

## Security & privacy (`redaction.ts`)

Same-origin allowlist; denylist for bank/tax/payment/auth/session routes (never even read); 8 MB
body cap; **values are never retained** - only endpoint shape (method/host/masked path/query KEY
names/operationName), schema KEY names, hashes, sizes. Sensitive key names are masked. Errors are
reduced to a category. Raw debug is opt-in + TTL'd + sample-capped:

```bash
ENABLE_DISTRIBUTOR_NETWORK_DEBUG=false
DISTRIBUTOR_NETWORK_DEBUG_TTL_MINUTES=30
DISTRIBUTOR_NETWORK_DEBUG_SAMPLE_LIMIT=5
```

## Observability (`metrics.ts`)

Releases expected/attempted/completed/failed; tracks extracted; ISRC/UPC/artwork coverage;
endpoint success rate; parser version; schema-drift count; response-timeout count; avg release
duration; Steel reconnects. Logs carry `tenantId, connectionId, scanId, releaseId,
endpointFingerprint (truncated hash), parserVersion, outcome, elapsedMs` - never bodies or secrets.

## Tuning

| Env | Default | Purpose |
|---|---|---|
| `CATALOG_READ_CONCURRENCY` | 2 | tabs per account (SPA is heavy) |
| `CATALOG_READ_GOTO_TIMEOUT_MS` | 30000 | navigation (`commit`) |
| `CATALOG_READ_WAIT_UNTIL` | `commit` | never wait on the hanging `domcontentloaded` |
| `CATALOG_READ_CONTENT_TIMEOUT_MS` | 30000 | metadata **response** wait |
| `CATALOG_READ_MAX_DURATION_MS` | 600000 | overall read budget |
| Catalogue extraction | fixed | Network-first six-stage pipeline; release-chunked, durable, in-lease resumable, and retryable-release-only |
