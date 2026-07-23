import type { DistributorEndpointProfile, EndpointRegistry, EndpointRole } from './endpoint-registry';
import type { RankedCandidate } from './network-discovery';
import type { CanonicalDistributorRelease, CanonicalDistributorTrack, MetadataField } from './metadata-model';

/**
 * Endpoint BUNDLE.
 *
 * Never assume one endpoint returns every field. A dashboard may serve:
 *  - one REST release-details endpoint, or
 *  - a GraphQL endpoint with several operations, or
 *  - separate endpoints for tracks / identifiers / artwork, or
 *  - a details response plus a second async request that carries the ISRCs, or
 *  - different shapes for singles vs albums.
 *
 * The bundle holds one profile per role and merges whatever each contributes.
 */
export interface DistroKidEndpointBundle {
  catalogIndex?: DistributorEndpointProfile;
  releaseDetails?: DistributorEndpointProfile;
  trackIdentifiers?: DistributorEndpointProfile;
  artwork?: DistributorEndpointProfile;
  storeDeliveryStatus?: DistributorEndpointProfile;
  lyricsStatus?: DistributorEndpointProfile;
  creditsStatus?: DistributorEndpointProfile;
}

export const ENDPOINT_ROLES: EndpointRole[] = [
  'catalogIndex',
  'releaseDetails',
  'trackIdentifiers',
  'artwork',
  'storeDeliveryStatus',
  'lyricsStatus',
  'creditsStatus',
];

/** Load the current best profile for every role. */
export async function loadEndpointBundle(registry: EndpointRegistry): Promise<DistroKidEndpointBundle> {
  const bundle: DistroKidEndpointBundle = {};
  for (const role of ENDPOINT_ROLES) {
    const p = await registry.activeFor(role);
    if (p) bundle[role] = p;
  }
  return bundle;
}

/**
 * Infer a candidate's ROLE from its schema shape. Discovery is automatic, so we must be able to
 * say "this response carries the ISRCs" vs "this one only carries artwork" without a human.
 */
export function inferRole(candidate: RankedCandidate): EndpointRole {
  const keys = new Set(candidate.schemaKeys);
  const has = (...k: string[]): boolean => k.some((x) => keys.has(x));

  const hasTracksArray = has('tracks', 'tracklist');
  const hasIsrc = has('isrc');
  const hasUpc = has('upc', 'barcode', 'ean');
  const hasArt = has('artwork', 'artworkurl', 'coverart', 'coverurl', 'cover');

  // A catalog index lists many releases and carries release ids but not per-track identifiers.
  if (!hasIsrc && !hasUpc && has('releases', 'albums', 'releaseid', 'albumid') && candidate.distinctPayloads <= 1) return 'catalogIndex';
  // Release details: the release identifiers (+ usually its track list).
  if (hasUpc || (hasTracksArray && hasIsrc)) return 'releaseDetails';
  // Identifiers only: ISRCs without release-level UPC.
  if (hasIsrc) return 'trackIdentifiers';
  if (hasArt) return 'artwork';
  if (has('deliverystatus', 'stores', 'storedelivery')) return 'storeDeliveryStatus';
  if (has('lyrics', 'lyricsstatus')) return 'lyricsStatus';
  if (has('credits', 'creditsstatus')) return 'creditsStatus';
  return 'releaseDetails';
}

/**
 * Merge partial release metadata contributed by different endpoints in the bundle.
 * Later sources fill gaps but never overwrite an already-PRESENT field.
 */
export function mergePartial<T extends Record<string, unknown>>(base: T, extra: Partial<T>): T {
  // Clone arrays on both sides. Endpoint responses are retained for diagnostics/retries, so a
  // later projection must not mutate a parsed payload by sharing its array instance.
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  );
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    const cur = out[k];
    const curEmpty = cur === undefined || cur === null
      || (typeof cur === 'string' && cur.trim() === '')
      || (Array.isArray(cur) && cur.length === 0);
    if (curEmpty) out[k] = Array.isArray(v) ? [...v] : v;
  }
  return out as T;
}

const cloneField = <T>(field: MetadataField<T>): MetadataField<T> => ({ ...field });
const evidenceRank = (field: MetadataField<unknown>): number =>
  field.status === 'PRESENT' ? 3 : field.status === 'ABSENT_AT_SOURCE' ? 2 : 1;
const strongerEvidence = <T>(current: MetadataField<T>, alternative: MetadataField<T>): MetadataField<T> =>
  evidenceRank(alternative) > evidenceRank(current) ? cloneField(alternative) : cloneField(current);
const cloneTrack = (track: CanonicalDistributorTrack): CanonicalDistributorTrack => ({
  ...track,
  isrc: cloneField(track.isrc),
});

/**
 * Merge two correlated endpoint-bundle members without sharing mutable arrays/track objects.
 * Details endpoints may carry titles/credits while identifier endpoints carry ISRCs, so neither
 * response is assumed to be complete on its own.
 */
export function mergeCanonicalRelease(
  base: CanonicalDistributorRelease,
  extra: CanonicalDistributorRelease,
): CanonicalDistributorRelease {
  const merged: CanonicalDistributorRelease = {
    ...base,
    upc: cloneField(base.upc),
    artworkUrl: cloneField(base.artworkUrl),
    releaseDate: cloneField(base.releaseDate),
    ...(base.uploadDate ? { uploadDate: cloneField(base.uploadDate) } : {}),
    ...(base.label ? { label: cloneField(base.label) } : {}),
    ...(base.featuredArtists ? { featuredArtists: [...base.featuredArtists] } : {}),
    tracks: base.tracks.map(cloneTrack),
  };

  if (!merged.title.trim() && extra.title.trim()) merged.title = extra.title;
  if (!merged.primaryArtist?.trim() && extra.primaryArtist?.trim()) merged.primaryArtist = extra.primaryArtist;
  if ((!merged.featuredArtists || merged.featuredArtists.length === 0) && extra.featuredArtists?.length) {
    merged.featuredArtists = [...extra.featuredArtists];
  }

  for (const key of ['upc', 'artworkUrl', 'releaseDate', 'label', 'uploadDate'] as const) {
    const current = merged[key];
    const alternative = extra[key];
    if (!alternative) continue;
    if (!current) merged[key] = cloneField(alternative);
    else merged[key] = strongerEvidence(current, alternative);
  }

  if (merged.tracks.length === 0 && extra.tracks.length > 0) {
    merged.tracks = extra.tracks.map(cloneTrack);
    return merged;
  }

  // Backfill identifiers/details by track number, then exact normalized parser title. A sibling
  // response that cannot be correlated to a current row is never appended by guesswork.
  merged.tracks = merged.tracks.map((track) => {
    const alternative = extra.tracks.find((candidate) =>
      (!!track.distributorTrackId && candidate.distributorTrackId === track.distributorTrackId)
      || (track.trackNumber !== undefined && candidate.trackNumber === track.trackNumber)
      || (!!track.title && !!candidate.title && candidate.title === track.title),
    );
    if (!alternative) return track;
    return {
      ...track,
      ...(!track.distributorTrackId && alternative.distributorTrackId
        ? { distributorTrackId: alternative.distributorTrackId }
        : {}),
      ...(!track.title.trim() && alternative.title.trim() ? { title: alternative.title } : {}),
      ...(track.trackNumber === undefined && alternative.trackNumber !== undefined
        ? { trackNumber: alternative.trackNumber }
        : {}),
      ...(track.durationSec === undefined && alternative.durationSec !== undefined
        ? { durationSec: alternative.durationSec }
        : {}),
      isrc: strongerEvidence(track.isrc, alternative.isrc),
    };
  });

  return merged;
}
