import {
  DeezerStoreProvider,
  ItunesStoreProvider,
  createStoreScanTargets,
  scanStorePresence,
  normalizeIsrc,
  normalizeTitle,
  type ReleasedTrack,
  type StoreTrack,
} from '@sentinel/adapters';
import type { CatalogDistributorExtractionLike, CatalogTrackMetadataLike } from '@sentinel/search-store';

export interface CatalogScanTrackStore {
  store: string;
  status: string;
  foundArtist: string | null;
  url: string | null;
  confidence: number;
  needsManualReview: boolean;
  reviewQuery: string | null;
  reviewDecision?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}
export interface CatalogScanTrack {
  title: string;
  primaryArtist: string | null;
  featuredArtists?: string[];
  album: string | null;
  isrc: string | null;
  artworkUrl: string | null;
  perStore: CatalogScanTrackStore[];
  /** Release-level distributor metadata (present when scanned from a connected/imported catalogue). */
  label?: string | null;
  upc?: string | null;
  releaseDate?: string | null;
  uploadDate?: string | null;
  metadata?: CatalogTrackMetadataLike;
}
export interface CatalogScanResult {
  artist: string;
  stores: string[];
  profiles: Array<{ store: string; name: string; url: string }>;
  tracks: CatalogScanTrack[];
  summary: { tracks: number; live: number; notLive: number; wrongProfile: number; needsReview: number };
  generatedAt: string;
  warnings: string[];
  note: string;
  distributorExtraction?: CatalogDistributorExtractionLike;
}

/**
 * Run the store-presence scan for an artist against REAL store APIs and shape it
 * for the catalogue UI. Until the distributor login supplies the authoritative
 * released set, the released set is the UNION of the stores' own catalogues (real
 * data, with cover art + ISRCs); the scan then flags per-store LIVE / NOT-LIVE /
 * WRONG-PROFILE. Cross-store gaps and wrong-profile placements are already real.
 */
export async function runCatalogScan(artist: string, opts: { limit?: number; fast?: boolean } = {}): Promise<CatalogScanResult> {
  const deezer = new DeezerStoreProvider();
  const itunes = new ItunesStoreProvider();
  const [dz, it] = await Promise.all([
    deezer.listArtistCatalog(artist, { limit: 200 }).catch(() => null),
    itunes.listArtistCatalog(artist, { limit: 200 }).catch(() => null),
  ]);

  // Unified catalogue: dedupe by ISRC (preferred) or normalized title; keep the
  // richest record (prefer one that has an ISRC and cover art).
  const byKey = new Map<string, StoreTrack>();
  const keyOf = (t: StoreTrack): string => normalizeIsrc(t.isrc) ?? (normalizeTitle(t.title) || t.title);
  for (const t of [...(dz?.tracks ?? []), ...(it?.tracks ?? [])]) {
    if (!t.title) continue;
    const k = keyOf(t);
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, t);
    else byKey.set(k, { ...cur, isrc: cur.isrc ?? t.isrc, artworkUrl: cur.artworkUrl ?? t.artworkUrl, album: cur.album ?? t.album });
  }
  // `fast` (the default for the HTTP endpoints): scan Deezer + Apple only, in-memory
  // index compare, whole catalogue in ~1s — NEVER run rate-limited web queries in the
  // request path (that's what the background deep scan is for). Non-fast keeps the old
  // bounded synchronous multi-platform behaviour (used by CLIs / tests).
  const fast = opts.fast ?? false;
  const webActive = !fast && (Boolean(process.env.BRAVE_SEARCH_API_KEY) || Boolean(process.env.SEARXNG_URL) || /^(1|true|yes|on)$/i.test(process.env.ENABLE_WEB_SEARCH_STORES ?? ''));
  const limit = opts.limit ?? (webActive ? Number(process.env.CATALOG_SCAN_WEB_LIMIT || 8) : 150);
  const unified = [...byKey.values()].slice(0, limit);
  const released: ReleasedTrack[] = unified.map((t) => ({ title: t.title, primaryArtist: artist, isrc: t.isrc }));

  const report = await scanStorePresence({
    expectedArtist: artist,
    releasedTracks: released,
    stores: createStoreScanTargets(process.env, fast ? { includeWebSearch: false } : {}),
    quick: fast,
  });

  const tracks: CatalogScanTrack[] = report.results.map((r, i) => ({
    title: r.track.title,
    primaryArtist: r.track.primaryArtist ?? artist,
    album: unified[i]?.album ?? null,
    isrc: r.track.isrc,
    artworkUrl: unified[i]?.artworkUrl ?? null,
    perStore: r.perStore.map((p) => ({ store: p.store, status: p.status, foundArtist: p.foundArtist ?? null, url: p.url ?? null, confidence: p.confidence, needsManualReview: p.needsManualReview, reviewQuery: p.reviewQuery ?? null })),
  }));

  const profiles = [
    dz?.artist ? { store: 'Deezer', name: dz.artist.name, url: dz.artist.url } : null,
    it?.artist ? { store: 'Apple Music', name: it.artist.name, url: it.artist.url } : null,
  ].filter((p): p is { store: string; name: string; url: string } => p !== null);

  return {
    artist,
    stores: report.stores,
    profiles,
    tracks,
    summary: { tracks: tracks.length, live: report.summary.live, notLive: report.summary.notLive, wrongProfile: report.summary.wrongProfile, needsReview: report.summary.needsReview },
    generatedAt: new Date().toISOString(),
    warnings: [...(dz?.warnings ?? []), ...(it?.warnings ?? [])],
    note: fast
      ? 'Fast pass across Deezer + Apple (whole catalogue). The other platforms fill in from the background deep scan.'
      : webActive
        ? `Web-search stores are rate-limited, so this synchronous scan covers the first ${limit} tracks across all platforms.`
        : 'Released set from live store catalogues (Deezer + Apple). Connect your distributor to make it authoritative.',
  };
}

/**
 * Scan an AUTHORITATIVE released catalogue (from the distributor login) against the
 * music platforms. Same store scan as above, but the released set is the artist's
 * real distributor catalogue — so a NOT-LIVE result means genuinely distributed but
 * missing, which is exactly what the support report needs.
 */
export async function scanReleasedCatalog(artist: string, released: ReleasedTrack[], artists?: string[]): Promise<CatalogScanResult> {
  // If the distributor read returned nothing, don't spin the store scan — return an
  // explicit empty result so the UI can say "read 0 tracks" (a selector-tuning signal)
  // rather than showing a blank scan.
  if (released.length === 0) {
    return {
      artist, stores: [], profiles: [], tracks: [],
      summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
      generatedAt: new Date().toISOString(),
      warnings: ['No releases were read from the distributor page.'],
      note: 'Connected to your distributor, but no releases were read from the catalogue page. This usually means the page layout needs a selector update — the page was captured for tuning.',
    };
  }
  // Fast stores only (Deezer + Apple) so the WHOLE catalogue scans in seconds. The slow
  // Brave web-search platforms (Audiomack, Spotify, etc. — 1 query/sec) run as a
  // separate background deep scan; a synchronous full-catalogue Brave pass would take
  // many minutes and time the request out.
  // Quick, index-only compare so a large distributor catalogue (hundreds of tracks)
  // scans in seconds without per-track network calls timing the request out. The
  // thorough per-track pass (wrong-profile + web platforms) is the deep scan.
  const report = await scanStorePresence({ expectedArtist: artist, expectedArtists: artists, releasedTracks: released, stores: createStoreScanTargets(process.env, { includeWebSearch: false }), quick: true });
  const tracks: CatalogScanTrack[] = report.results.map((r) => ({
    title: r.track.title,
    primaryArtist: r.track.primaryArtist ?? null,
    ...(r.track.featuredArtists ? { featuredArtists: [...r.track.featuredArtists] } : {}),
    album: r.track.releaseTitle ?? null,
    isrc: r.track.isrc,
    artworkUrl: r.track.artworkUrl ?? null,
    label: r.track.label ?? null,
    upc: r.track.upc ?? null,
    releaseDate: r.track.releaseDate ?? null,
    uploadDate: r.track.uploadDate ?? null,
    metadata: r.track.metadata,
    perStore: r.perStore.map((p) => ({ store: p.store, status: p.status, foundArtist: p.foundArtist ?? null, url: p.url ?? null, confidence: p.confidence, needsManualReview: p.needsManualReview, reviewQuery: p.reviewQuery ?? null })),
  }));
  await enrichArtworkByIsrc(tracks);
  return {
    artist,
    stores: report.stores,
    profiles: [],
    tracks,
    summary: { tracks: tracks.length, live: report.summary.live, notLive: report.summary.notLive, wrongProfile: report.summary.wrongProfile, needsReview: report.summary.needsReview },
    generatedAt: new Date().toISOString(),
    warnings: [...report.warnings],
    note: `Read ${released.length} release(s) from your connected distributor account and compared against your ${report.stores.join(' + ')} catalogue${report.stores.length === 1 ? '' : 's'} (fast index compare). A deep pass adds wrong-profile detection and the web-verified platforms (Audiomack, Spotify, YouTube, …).`,
  };
}

/** Bump a store CDN cover URL to a high-res square variant (Deezer/Apple/imgix-style sizing). */
function hiResArt(url: string): string {
  return url
    .replace(/\/\d{2,4}x\d{2,4}(bb|cc)?\.(jpg|jpeg|png|webp)/i, '/1000x1000$1.$2')
    .replace(/(\/|-)\d{2,4}x\d{2,4}([.\-/])/g, '$11000x1000$2');
}

/**
 * Fill in EXACT cover art for tracks still missing it, via Deezer's public ISRC lookup
 * (`GET /track/isrc:{isrc}` → the exact recording's album cover). ISRC is a global fingerprint,
 * so this finds the cover even when the track isn't under a name-searchable artist profile.
 * Bounded + concurrency-limited so it never hammers Deezer or stalls a huge catalogue.
 */
async function enrichArtworkByIsrc(tracks: CatalogScanTrack[]): Promise<void> {
  const targets = tracks.filter((t) => !t.artworkUrl && t.isrc).slice(0, Number(process.env.CATALOG_ART_LOOKUP_LIMIT || 800));
  if (!targets.length) return;
  const deezer = new DeezerStoreProvider();
  let i = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = i++;
      if (idx >= targets.length) return;
      const t = targets[idx]!;
      try {
        const r = await deezer.lookupIsrc(t.isrc!);
        if (r.found && r.artworkUrl) t.artworkUrl = hiResArt(r.artworkUrl);
      } catch { /* leave art null → UI placeholder */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, () => worker()));
}
