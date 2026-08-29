/**
 * Store-presence layer: "is this artist's music actually live on store X?"
 *
 * Honesty is enforced by the type system. Every store falls into one of:
 *  - `api`                 → checked against the store's REAL public/official API.
 *  - `distributor-reported`→ no store API; we surface what the DISTRIBUTOR says it
 *                            delivered (from the attended distributor scrape).
 *  - `unverifiable`        → no public API and no reliable signal; reported as such.
 * We never fabricate presence for a store we cannot actually query.
 */
export type StoreCheckMethod = 'api' | 'distributor-reported' | 'unverifiable';

/** One track as it appears on a store (real data from the store's API). */
export interface StoreTrack {
  title: string;
  primaryArtist: string;
  album: string | null;
  isrc: string | null;
  url: string | null;
  releaseDate: string | null;
  artworkUrl: string | null;
}

/** Artist-agnostic ISRC lookup, the basis for wrong-profile detection. */
export interface IsrcLookupResult {
  found: boolean;
  artist: string | null;
  title: string | null;
  url: string | null;
  artworkUrl: string | null;
}
export interface IsrcLookupProvider {
  readonly store: string;
  /** Look up a track by ISRC regardless of artist (returns whoever it's under). */
  lookupIsrc(isrc: string): Promise<IsrcLookupResult>;
}

/** Artist-scoped title search, confirms a song exists on a store without ISRC. */
export interface TitleSearchResult {
  found: boolean;
  url: string | null;
}
export interface TitleSearchProvider {
  readonly store: string;
  /** Search the store for `title` by `artist`; found only on a title+artist match. */
  searchTitle(artist: string, title: string): Promise<TitleSearchResult>;
}

/** Normalize an artist identity without the title-specific remix/version rules. */
export function normalizeArtist(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Do two credits refer to the same artist?
 *
 * Matching is exact after normalization, except that an explicitly-delimited
 * collaboration credit ("A & B", "A feat. B", etc.) may match either member.
 * Arbitrary substring matching is deliberately avoided: a label-mate or an artist
 * with a prefix/suffix name must not make another artist's catalogue look live.
 */
export function sameArtist(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const aa = artistCredits(a);
  const bb = artistCredits(b);
  return aa.some((name) => bb.includes(name));
}

/** Does `found` match ANY of the candidate artist names? Used for multi-artist (label)
 *  catalogues, where a track is "wrong-profile" only if it matches none of the roster. */
export function artistMatchesAny(found: string | null | undefined, candidates: Array<string | null | undefined>): boolean {
  return candidates.some((c) => sameArtist(found, c));
}

function artistCredits(value: string): string[] {
  const names = [
    value,
    ...value.split(/\s*(?:&|,|;|\/|\b(?:feat(?:uring)?|ft|with|x)\.?\b)\s*/i),
  ]
    .map(normalizeArtist)
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Completeness of one artist-scoped catalogue read.
 *
 * `complete: true` is an explicit assertion that the provider reached the end of
 * the upstream artist catalogue. `fetched` counts upstream entries examined before
 * normalization/filtering; `total` is null when the API does not expose it.
 */
export interface StoreCatalogPagination {
  total: number | null;
  fetched: number;
  complete: boolean;
}

/** A store's view of an artist's catalog, from its real API. */
export interface StoreArtistCatalog {
  store: string;
  method: StoreCheckMethod;
  artist: { id: string; name: string; url: string } | null;
  tracks: StoreTrack[];
  pagination: StoreCatalogPagination;
  warnings: string[];
}

/** A provider that reads a store's REAL API. */
export interface StoreCatalogProvider {
  readonly store: string;
  readonly method: 'api';
  /** True if the provider needs an API key/credential that isn't configured. */
  readonly needsCredential: boolean;
  /** List what this store actually has for the artist (real API call). */
  listArtistCatalog(artistName: string, opts?: { limit?: number }): Promise<StoreArtistCatalog>;
}

/** Shared provider safety bound. Callers can request large catalogues without any
 * adapter silently substituting a small legacy cap. Reaching this bound must set
 * `pagination.complete=false` and emit a warning. */
export const STORE_PROVIDER_HARD_MAX_TRACKS = 100_000;

export function normalizeStoreCatalogLimit(value: number | undefined, fallback = 20_000): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > STORE_PROVIDER_HARD_MAX_TRACKS) {
    throw new Error(`catalog limit must be an integer between 1 and ${STORE_PROVIDER_HARD_MAX_TRACKS}.`);
  }
  return resolved;
}

/** Injectable fetch so providers are unit-testable without the network. Supports
 *  method/body for token exchanges (Spotify); GET-only providers just pass a URL. */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|featuring|prod|remix|version|edit|radio|extended|original mix)\b.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeIsrc(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v) ? v : null;
}
