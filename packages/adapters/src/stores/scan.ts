import {
  normalizeArtist,
  normalizeIsrc,
  normalizeTitle,
  sameArtist,
  type IsrcLookupProvider,
  type StoreCatalogProvider,
  type StoreTrack,
  type TitleSearchProvider,
} from './types';

/**
 * A track from the artist's DISTRIBUTED catalogue (source of truth: the
 * distributor). We reconcile these against what's actually live on each store.
 */
export interface ReleasedTrackMetadataField {
  value?: string;
  status:
    | 'PRESENT'
    | 'ABSENT_AT_SOURCE'
    | 'NOT_CAPTURED'
    | 'PARSE_FAILED'
    | 'REQUEST_FAILED'
    | 'TIMEOUT'
    | 'REAUTH_REQUIRED'
    | 'NOT_AUTHORIZED'
    | 'UNKNOWN';
  source: 'OFFICIAL_API' | 'NETWORK_JSON' | 'DIRECT_JSON' | 'PAGE_STATE' | 'DOM' | 'CSV_IMPORT';
  capturedAt: string;
  parserVersion: string;
}

export type ReleasedTrackMetadata = Partial<Record<
  'isrc' | 'upc' | 'artworkUrl' | 'label' | 'releaseDate' | 'uploadDate',
  ReleasedTrackMetadataField
>>;

export interface ReleasedTrack {
  title: string;
  primaryArtist: string;
  /** Structured credits supplied by the distributor; never inferred from title free text. */
  featuredArtists?: string[];
  isrc: string | null;
  releaseTitle?: string | null;
  artworkUrl?: string | null;
  /** Release-level metadata from the distributor catalogue (optional). */
  upc?: string | null;
  label?: string | null;
  releaseDate?: string | null;
  uploadDate?: string | null;
  /** Distributor field evidence carried unchanged through platform-presence scans. */
  metadata?: ReleasedTrackMetadata;
}

export type PresenceStatus =
  | 'live' // present on the store under the correct artist
  | 'not-live' // distributed but not found on the store
  | 'wrong-profile' // present, but under a DIFFERENT artist profile
  | 'unverifiable'; // store has no way to check (no API)

export interface StorePresence {
  store: string;
  status: PresenceStatus;
  matchedBy: 'isrc' | 'title-artist' | null;
  /** For wrong-profile: the artist the ISRC is actually credited to on the store. */
  foundArtist?: string | null;
  url?: string | null;
  /** 0–1 confidence in this verdict (ISRC=1.0, title=0.8, web-hit=0.75, unverifiable=0.3). */
  confidence: number;
  /** True when confidence is below the trust threshold → surface for manual review. */
  needsManualReview: boolean;
  /** "artist title" — lets the UI build a manual-verify search link for this track. */
  reviewQuery?: string | null;
}

/** Below this confidence, a verdict is surfaced for manual human verification. */
export const MANUAL_REVIEW_THRESHOLD = 0.6;

export interface TrackScanResult {
  track: ReleasedTrack;
  perStore: StorePresence[];
}

export interface StoreScanReport {
  expectedArtist: string;
  stores: string[];
  results: TrackScanResult[];
  /** Provider completeness/degradation evidence. A capped catalogue is never silent. */
  warnings: string[];
  summary: { total: number; live: number; notLive: number; wrongProfile: number; unverifiable: number; needsReview: number };
}

/** A store the scan can query. */
export interface ScannableStore {
  catalog: StoreCatalogProvider;
  /** Confirmation-only providers cannot enumerate an artist catalogue. */
  catalogMode?: 'enumerable' | 'confirm-only';
  /** Artist-agnostic ISRC lookup (for exact live + wrong-profile detection). */
  isrc?: IsrcLookupProvider;
  /** Title+artist search — confirms existence on stores without ISRC search. */
  title?: TitleSearchProvider;
  /** `catalog` means title lookup only re-reads the same catalogue; never do that per track. */
  titleSearchMode?: 'query' | 'catalog';
  /**
   * Web-search / no-API stores: we can positively CONFIRM presence but cannot prove
   * absence (a search miss might just be a miss). So a miss is reported as
   * `unverifiable`, never a false `not-live`. Keeps positive claims near-100% precise.
   */
  confirmOnly?: boolean;
}

export const DEFAULT_STORE_CATALOG_MAX_TRACKS = 20_000;
export const HARD_STORE_CATALOG_MAX_TRACKS = 100_000;
export const DEFAULT_STORE_SCAN_MAX_ARTISTS = 5_000;
export const HARD_STORE_SCAN_MAX_ARTISTS = 20_000;

interface PreparedArtistCatalog {
  requestedArtist: string;
  complete: boolean;
  titleIndex: Map<string, StoreTrack>;
  isrcIndex: Map<string, StoreTrack>;
  warnings: string[];
}

interface PreparedStoreCatalog {
  store: string;
  isrc?: IsrcLookupProvider;
  title?: TitleSearchProvider;
  titleSearchMode: 'query' | 'catalog';
  confirmOnly: boolean;
  catalogs: PreparedArtistCatalog[];
}

/**
 * Immutable catalogue indexes shared by every checkpoint chunk in one scan. The
 * upstream artist catalogue is fetched exactly once per (store, artist) pair.
 */
export interface PreparedStorePresence {
  expectedArtistKey: string;
  artistKeys: ReadonlySet<string>;
  storeNames: readonly string[];
  stores: PreparedStoreCatalog[];
  warnings: readonly string[];
}

export interface PrepareStorePresenceInput {
  expectedArtist: string;
  expectedArtists?: string[];
  releasedTracks: ReleasedTrack[];
  stores: ScannableStore[];
  /** Per-artist safety ceiling. Reaching it is reported as incomplete, never success. */
  catalogMaxTracks?: number;
  /** Number of different providers prefetched concurrently; artists stay serial per provider. */
  catalogFetchConcurrency?: number;
  /** Explicit label-roster bound. Exceeding it fails rather than dropping artists. */
  maxDistinctArtists?: number;
}

export interface ScanStorePresenceInput extends PrepareStorePresenceInput {
  /** Reuse a full-scan prefetch across checkpoint chunks. */
  prepared?: PreparedStorePresence;
  /** Index-only mode: no supplemental per-track API/search calls. */
  quick?: boolean;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return resolved;
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function requestedArtists(input: PrepareStorePresenceInput): string[] {
  const maxArtists = boundedInteger(input.maxDistinctArtists, DEFAULT_STORE_SCAN_MAX_ARTISTS, 1, HARD_STORE_SCAN_MAX_ARTISTS, 'maxDistinctArtists');
  const artistSet = new Map<string, string>();
  for (const value of [input.expectedArtist, ...(input.expectedArtists ?? []), ...input.releasedTracks.map((track) => track.primaryArtist)]) {
    const name = (value ?? '').trim();
    if (!name) continue;
    const key = normalizeArtist(name);
    if (!key || artistSet.has(key)) continue;
    if (artistSet.size >= maxArtists) {
      throw new Error(`Store scan contains more than the configured ${maxArtists} distinct artists; no artist was dropped.`);
    }
    artistSet.set(key, name);
  }
  if (artistSet.size === 0) throw new Error('Store scan requires at least one non-empty artist identity.');
  return [...artistSet.values()];
}

/** Fetch and index every required store catalogue once, with bounded provider concurrency. */
export async function prepareStorePresence(input: PrepareStorePresenceInput): Promise<PreparedStorePresence> {
  const artists = requestedArtists(input);
  const catalogMaxTracks = boundedInteger(
    input.catalogMaxTracks,
    DEFAULT_STORE_CATALOG_MAX_TRACKS,
    1,
    HARD_STORE_CATALOG_MAX_TRACKS,
    'catalogMaxTracks',
  );
  const concurrency = boundedInteger(input.catalogFetchConcurrency, 2, 1, 16, 'catalogFetchConcurrency');

  // Different providers may run concurrently. Requests for different artists on the
  // same provider remain serial so one scan cannot burst through a provider rate limit.
  const stores = await mapWithConcurrency(input.stores, concurrency, async (store): Promise<PreparedStoreCatalog> => {
    const catalogs: PreparedArtistCatalog[] = [];
    for (const [artistIndex, requestedArtist] of artists.entries()) {
      let catalog: Awaited<ReturnType<StoreCatalogProvider['listArtistCatalog']>> | null = null;
      if (store.catalogMode !== 'confirm-only') {
        try {
          catalog = await store.catalog.listArtistCatalog(requestedArtist, { limit: catalogMaxTracks });
        } catch {
          // The public report records the failed scope without leaking transport secrets.
        }
      }
      const titleIndex = new Map<string, StoreTrack>();
      const isrcIndex = new Map<string, StoreTrack>();
      for (const track of catalog?.tracks ?? []) {
        if (track.primaryArtist?.trim() && !sameArtist(track.primaryArtist, requestedArtist)) continue;
        const title = normalizeTitle(track.title);
        if (title) titleIndex.set(title, track);
        const isrc = normalizeIsrc(track.isrc);
        if (isrc) isrcIndex.set(isrc, track);
      }
      const warnings = store.catalogMode === 'confirm-only'
        ? (artistIndex === 0 ? [`${store.catalog.store} does not expose a complete artist catalogue; individual confirmations are required.`] : [])
        : catalog
          ? [...catalog.warnings]
          : [`${store.catalog.store} catalogue request failed for "${requestedArtist}"; absence cannot be verified.`];
      const degradedWarning = warnings.some((warning) =>
        /credential|premium|token|unauthor|forbidden|quota|rate.?limit|request failed|not configured|timed?.?out|truncat|incomplete|partial|capped|limit/i.test(warning),
      );
      const identityVerified = Boolean(catalog?.artist && sameArtist(catalog.artist.name, requestedArtist));
      const complete = catalog !== null && identityVerified && catalog.pagination.complete === true && !degradedWarning;
      if (catalog && catalog.tracks.length > catalogMaxTracks) {
        throw new Error(`${store.catalog.store} violated the configured catalogue maximum.`);
      }
      catalogs.push({ requestedArtist, complete, titleIndex, isrcIndex, warnings });
    }
    return {
      store: store.catalog.store,
      isrc: store.isrc,
      title: store.title,
      titleSearchMode: store.titleSearchMode ?? 'query',
      confirmOnly: store.confirmOnly ?? false,
      catalogs,
    };
  });

  const allWarnings = [...new Set(stores.flatMap((store) => store.catalogs.flatMap((catalog) =>
    catalog.warnings.map((warning) => `[${store.store} / ${catalog.requestedArtist}] ${warning}`),
  )))];
  const warnings = allWarnings.length <= 250
    ? allWarnings
    : [...allWarnings.slice(0, 250), `[Store scan] ${allWarnings.length - 250} additional provider warnings were summarized; every affected result remains unverifiable.`];
  return {
    expectedArtistKey: normalizeArtist(input.expectedArtist),
    artistKeys: new Set(artists.map(normalizeArtist)),
    storeNames: stores.map((store) => store.store),
    stores,
    warnings,
  };
}

/**
 * Reconcile a distributed catalogue against what's live on each store.
 *
 * Per released track, per store:
 *  1. ISRC lookup (when the store supports it): the ISRC is a global fingerprint.
 *     - found under the expected artist        → LIVE (isrc)
 *     - found under a DIFFERENT artist          → WRONG-PROFILE (reports which)
 *  2. Otherwise, match by normalized title within the artist's store catalogue:
 *     - matched                                 → LIVE (title-artist)
 *     - not matched                             → NOT-LIVE
 */
export async function scanStorePresence(input: {
  expectedArtist: string;
  /**
   * All artist names the catalogue may span (a label with many artists under one
   * distributor account — DistroKid Ultimate allows 5–100). When omitted, the set is
   * derived from the released tracks' own primaryArtist values. Each artist's store
   * catalogue is prefetched independently. Results remain scoped to the track's own
   * artist credit; a sibling label artist must not satisfy that track's presence.
   */
  expectedArtists?: string[];
  releasedTracks: ReleasedTrack[];
  stores: ScannableStore[];
  /**
   * Quick mode: match ONLY against each store's pre-fetched catalogue index (title +
   * ISRC) — no per-track network calls. For catalogue-LIST stores the index IS the
   * artist's full catalogue, so a miss is an accurate 'not-live'. Skips the per-track
   * ISRC lookup (wrong-profile) and title search, which are O(tracks) network calls and
   * too slow for a large catalogue synchronously — those run in the deep pass. Scales to
   * hundreds of tracks in ~seconds (just the one catalogue fetch per store).
   */
  quick?: boolean;
  prepared?: PreparedStorePresence;
  catalogMaxTracks?: number;
  catalogFetchConcurrency?: number;
  maxDistinctArtists?: number;
}): Promise<StoreScanReport> {
  const { expectedArtist, releasedTracks, quick = false } = input;

  // The set of artists this catalogue spans: the explicit list (label's declared artists),
  // plus every distinct primaryArtist on the released tracks, plus the primary expectedArtist.
  // Deduped (case-insensitive) and capped so a huge label roster can't explode the prefetch.
  const prepared = input.prepared ?? await prepareStorePresence(input);
  const requestedStoreNames = input.stores.map((store) => store.catalog.store);
  if (prepared.expectedArtistKey !== normalizeArtist(expectedArtist)
      || requestedStoreNames.length !== prepared.storeNames.length
      || requestedStoreNames.some((store, index) => store !== prepared.storeNames[index])) {
    throw new Error('Prepared store catalogue does not match this scan request.');
  }
  const missingArtist = releasedTracks
    .map((track) => normalizeArtist(track.primaryArtist || expectedArtist))
    .find((artist) => artist && !prepared.artistKeys.has(artist));
  if (missingArtist) throw new Error('Prepared store catalogue does not cover every track artist.');

  const perStoreCatalog = prepared.stores;

  const results: TrackScanResult[] = [];
  for (const track of releasedTracks) {
    const perStore: StorePresence[] = [];
    const trackIsrc = normalizeIsrc(track.isrc);
    const trackTitleNorm = normalizeTitle(track.title);
    const reviewQuery = `${track.primaryArtist || expectedArtist} ${track.title}`.trim();

    // Attach confidence + manual-review flag consistently to every verdict.
    const mk = (
      store: string,
      status: PresenceStatus,
      matchedBy: StorePresence['matchedBy'],
      confidence: number,
      extra: { foundArtist?: string | null; url?: string | null } = {},
    ): StorePresence => ({
      store,
      status,
      matchedBy,
      confidence,
      needsManualReview: confidence < MANUAL_REVIEW_THRESHOLD,
      reviewQuery: confidence < MANUAL_REVIEW_THRESHOLD ? reviewQuery : null,
      ...extra,
    });

    for (const store of perStoreCatalog) {
      const scopedArtist = track.primaryArtist?.trim() || expectedArtist;
      const scopedCatalogs = store.catalogs.filter((catalog) => sameArtist(catalog.requestedArtist, scopedArtist));
      const scopedComplete = scopedCatalogs.length > 0 && scopedCatalogs.every((catalog) => catalog.complete);
      const catalogIsrcHit = trackIsrc
        ? scopedCatalogs.map((catalog) => catalog.isrcIndex.get(trackIsrc)).find((hit): hit is StoreTrack => Boolean(hit))
        : undefined;
      const catalogTitleHit = trackTitleNorm
        ? scopedCatalogs.map((catalog) => catalog.titleIndex.get(trackTitleNorm)).find((hit): hit is StoreTrack => Boolean(hit))
        : undefined;
      let supplementalDegraded = false;

      // 1) ISRC present in the artist's own store catalogue (no network) — strongest signal.
      if (catalogIsrcHit) {
        perStore.push(mk(store.store, 'live', 'isrc', 1.0, { url: catalogIsrcHit.url }));
        continue;
      }
      // 2) Title match within the artist's store catalogue (no network).
      if (catalogTitleHit) {
        perStore.push(mk(store.store, 'live', 'title-artist', 0.8, { url: catalogTitleHit.url }));
        continue;
      }
      // Quick mode stops here — index-only, no per-track network. A miss on a
      // catalogue-list store is an accurate not-live; wrong-profile + web confirmation
      // are deferred to the deep pass.
      if (quick) {
        perStore.push(store.confirmOnly || !scopedComplete
          ? mk(store.store, 'unverifiable', null, 0.3)
          : mk(store.store, 'not-live', null, 0.8));
        continue;
      }
      // 3) Gap on this store → if it exposes ISRC lookup, check whether the ISRC is
      //    live under a DIFFERENT artist (wrong-profile). Network call, gaps only.
      if (trackIsrc && store.isrc) {
        const lk = await store.isrc.lookupIsrc(trackIsrc).catch(() => null);
        // A failed exact lookup is not a negative result. Preserve that degraded
        // state unless a later positive check succeeds.
        if (!lk) {
          supplementalDegraded = true;
        } else if (lk.found) {
          // Only the track's own credit (including explicit collaboration members)
          // satisfies artist scope. A sibling artist elsewhere in the roster does not.
          if (sameArtist(lk.artist, scopedArtist)) {
            perStore.push(mk(store.store, 'live', 'isrc', 0.95, { url: lk.url }));
          } else {
            perStore.push(mk(store.store, 'wrong-profile', 'isrc', 0.9, { foundArtist: lk.artist, url: lk.url }));
          }
          continue;
        }
      }

      // 4) Still a gap → confirm by an artist+title SEARCH (this is how stores
      //    without ISRC search are checked, and it clears false gaps on ISRC stores
      //    whose catalogue listing simply didn't surface the track). A web-search hit
      //    is verified on-page but slightly less certain than an API match.
      if (store.title && store.titleSearchMode === 'query' && (trackTitleNorm || track.title)) {
        const found = await store.title.searchTitle(track.primaryArtist || expectedArtist, track.title).catch(() => null);
        if (!found) {
          supplementalDegraded = true;
        } else if (found.found) {
          perStore.push(mk(store.store, 'live', 'title-artist', store.confirmOnly ? 0.75 : 0.85, { url: found.url }));
          continue;
        }
      }

      // A miss proves absence only when this exact artist catalogue explicitly
      // reached the end. Partial/capped/degraded catalogues remain unknown.
      perStore.push(
        store.confirmOnly || !scopedComplete || supplementalDegraded
          ? mk(store.store, 'unverifiable', null, 0.3)
          : mk(store.store, 'not-live', null, 0.8),
      );
    }
    results.push({ track, perStore });
  }

  const flat = results.flatMap((r) => r.perStore);
  return {
    expectedArtist,
    stores: perStoreCatalog.map((s) => s.store),
    results,
    warnings: [...prepared.warnings],
    summary: {
      total: flat.length,
      live: flat.filter((p) => p.status === 'live').length,
      notLive: flat.filter((p) => p.status === 'not-live').length,
      wrongProfile: flat.filter((p) => p.status === 'wrong-profile').length,
      unverifiable: flat.filter((p) => p.status === 'unverifiable').length,
      needsReview: flat.filter((p) => p.needsManualReview).length,
    },
  };
}
