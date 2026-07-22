# Archived DistroKid DOM adapter (test support only)

This document describes the former DOM adapter retained for isolated parser and
fixture tests. It is not wired into the API, production worker, queue contract,
or production image. The only supported DistroKid runtime is the six-stage
network-first Steel pipeline documented in
[distrokid-network-first-extractor.md](distrokid-network-first-extractor.md).

`DistroKidDistributorAdapter` (`@sentinel/scanner`) implements `DistributorScanner`
for deterministic test pages and historical compatibility tests only.

## Extracted fields

Per release: title, artist, release URL, distributor release id (if visible),
UPC, release date, selected stores + delivery status (incl. Audiomack). Per track:
title, track order, track URL, distributor track id (if visible), ISRC, lyrics
status, synced-lyrics status, credits status. Nothing else — no payment, tax,
bank, messages, address, or unrelated account data.

Each data point carries **provenance**: `sourceUrlCategory`, `scannedAt`, and a
`confidence` score. When a field cannot be read confidently, the value is
`null`/`UNKNOWN` — never guessed.

## Resilient locators

The adapter prefers stable, semantic selectors (data-fields, roles, text) over
brittle CSS. Distributor-specific selectors live in the **adapter** (not generic
scanner code). The selectors here match the fixture pages
(`fixtures/distrokid/*.html`); an unrecognized page shape raises `PageShapeError`,
which the worker converts into a `NEEDS_MAINTENANCE` note instead of failing the
whole scan or guessing.

> **TODO(prod):** tune the locators to DistroKid's live "My Music" / release pages
> behind a legal review. Never brute-force hidden endpoints or hammer private APIs.

## Enums

- **Store status:** `SELECTED · NOT_SELECTED · UNKNOWN · DELIVERED · PROCESSING · FAILED · REMOVED · TAKEDOWN · NEEDS_ACTION · CURATED_OR_NOT_GUARANTEED`
- **Lyrics status:** `UNKNOWN · MISSING · SUBMITTED · APPROVED · REJECTED · SYNCED_MISSING · SYNCED_SUBMITTED · NOT_SUPPORTED`
- **Credits status:** `UNKNOWN · MISSING · SUBMITTED · DISPLAYED · NOT_SUPPORTED`

## Issue detection (distributor-side)

`detectDistributorIssues()` flags: `MISSING_ISRC`, `MISSING_UPC`,
`MISSING_PLAIN_LYRICS`, `MISSING_SYNCED_LYRICS`, `MISSING_CREDITS`,
`NOT_SELECTED_FOR_AUDIOMACK`, `AUDIOMACK_DELIVERY_FAILED_OR_UNKNOWN`. Availability
issues that require a DSP comparison (e.g. missing-on-Audiomack) are produced by
the later DSP-comparison layer that consumes this canonical snapshot.

## Fixtures

`fixtures/distrokid/`: `login-required.html`, `login-success.html`,
`catalog-index.html`, `release-detail-1.html` (clean), `release-detail-2.html`
(missing UPC + missing ISRC + Audiomack not selected + missing lyrics/credits, to
exercise issue detection), plus `lyrics-status.html` / `store-status.html`.
