import { z } from 'zod';
import {
  absentAtSource, notCaptured, present,
  type CanonicalDistributorRelease, type CanonicalDistributorTrack, type MetadataSource,
} from './metadata-model';

/**
 * DistroKid release parser — version 1.
 *
 * Validate with a schema rather than indexing arbitrary JSON paths all over the codebase. When
 * the payload doesn't match, we throw `SchemaMismatchError` and the caller marks the endpoint
 * DEGRADED + alerts — we never guess, and never emit silently-partial data.
 *
 * The payload shape is not contracted to us, so v1 is deliberately permissive about WHERE the
 * release object sits (it locates it), but STRICT about the fields it then extracts.
 */

export const PARSER_VERSION = 'distrokid-parser-v1';

export class SchemaMismatchError extends Error {
  constructor(message: string, readonly parserVersion: string = PARSER_VERSION) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i;
const UPC_RE = /^\d{12,14}$/;

/** Accept string|number ids; normalize to string. */
const IdSchema = z.union([z.string(), z.number()]).transform((v) => String(v));
const NullableStr = z.string().nullish();

const TrackSchemaV1 = z.object({
  id: IdSchema.optional(),
  trackId: IdSchema.optional(),
  uuid: IdSchema.optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  isrc: NullableStr,
  trackNumber: z.number().nullish(),
  position: z.number().nullish(),
  durationSec: z.number().nullish(),
  duration: z.number().nullish(),
}).passthrough();

/**
 * A featured-artist credit is accepted only when the source exposes a real array of artist
 * values. We intentionally do not split a free-text string such as "A feat. B" because commas,
 * ampersands and "feat" can all be part of an artist's actual name. The object variants below
 * are the structured shapes this parser version knows how to read; an unknown object shape is
 * schema drift, not something to guess at.
 */
const FeaturedArtistSchemaV1 = z.union([
  z.string(),
  z.object({ name: z.string() }),
  z.object({ artistName: z.string() }),
  z.object({ artist: z.object({ name: z.string() }) }),
]);
const FeaturedArtistsSchemaV1 = z.array(FeaturedArtistSchemaV1);

const ReleaseSchemaV1 = z.object({
  id: IdSchema.optional(),
  releaseId: IdSchema.optional(),
  albumId: IdSchema.optional(),
  albumUuid: IdSchema.optional(),
  uuid: IdSchema.optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  upc: NullableStr,
  barcode: NullableStr,
  ean: NullableStr,
  artworkUrl: NullableStr,
  coverArt: NullableStr,
  coverUrl: NullableStr,
  cover: NullableStr,
  artwork: NullableStr,
  releaseDate: NullableStr,
  uploadDate: NullableStr,
  createdAt: NullableStr,
  label: NullableStr,
  artist: NullableStr,
  artistName: NullableStr,
  primaryArtist: NullableStr,
  featuredArtists: FeaturedArtistsSchemaV1.optional(),
  featured_artists: FeaturedArtistsSchemaV1.optional(),
  tracks: z.array(TrackSchemaV1).optional(),
  trackList: z.array(TrackSchemaV1).optional(),
}).passthrough();

type RawRelease = z.infer<typeof ReleaseSchemaV1>;

/**
 * Locate the release object inside an arbitrary envelope (`{data:{release:{…}}}`,
 * `{album:{…}}`, a bare object, …). Returns the first object that looks like a release:
 * has a track array, or a release-level identifier.
 */
export function locateReleaseObject(payload: unknown, depth = 0): unknown | undefined {
  if (depth > 8 || payload === null || typeof payload !== 'object') return undefined;
  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 50)) {
      const hit = locateReleaseObject(item, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  const o = payload as Record<string, unknown>;
  const hasTracks = Array.isArray(o['tracks']) || Array.isArray(o['trackList']);
  const hasReleaseId = ['upc', 'barcode', 'ean', 'albumUuid', 'releaseId', 'albumId'].some((k) => o[k] !== undefined && o[k] !== null);
  if (hasTracks || hasReleaseId) return o;
  for (const v of Object.values(o)) {
    const hit = locateReleaseObject(v, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

const firstStr = (...vals: Array<unknown>): string | undefined => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};

const hasOwnAny = (value: object, keys: readonly string[]): boolean =>
  keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));

type RawFeaturedArtist = z.infer<typeof FeaturedArtistSchemaV1>;

/** Trim and case-insensitively deduplicate structured artist credits, preserving first spelling. */
function normalizeFeaturedArtists(values: readonly RawFeaturedArtist[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const candidate = typeof value === 'string'
      ? value
      : 'name' in value
        ? value.name
        : 'artistName' in value
          ? value.artistName
          : value.artist.name;
    const name = candidate.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(name);
  }
  return normalized;
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
};

/**
 * Parse a payload into the canonical release model.
 * @throws SchemaMismatchError when no release object is present or validation fails.
 */
export function parseDistroKidReleaseV1(payload: unknown, source: MetadataSource = 'NETWORK_JSON'): CanonicalDistributorRelease {
  const raw = locateReleaseObject(payload);
  if (raw === undefined) throw new SchemaMismatchError('no release object found in payload');

  const result = ReleaseSchemaV1.safeParse(raw);
  if (!result.success) throw new SchemaMismatchError(`release failed schema validation: ${result.error.issues.slice(0, 3).map((i) => i.path.join('.') || '(root)').join(', ')}`);
  const r: RawRelease = result.data;

  const distributorReleaseId = firstStr(r.id, r.releaseId, r.albumId, r.albumUuid, r.uuid);
  const title = firstStr(r.title, r.name);
  const rawTracksEarly = r.tracks ?? r.trackList ?? [];
  // A bundle member may be identifiers-ONLY (`{tracks:[{isrc,…}]}`) with no release id or title.
  // That's still useful data to merge, so only reject a payload with no identity at all.
  if (!distributorReleaseId && !title && rawTracksEarly.length === 0) {
    throw new SchemaMismatchError('release has no id, title, or tracks');
  }

  const upcRaw = firstStr(r.upc, r.barcode, r.ean);
  const upcWasSupplied = hasOwnAny(r, ['upc', 'barcode', 'ean']);
  const upcValid = upcRaw && UPC_RE.test(upcRaw) ? upcRaw : undefined;
  const artRaw = firstStr(r.artworkUrl, r.coverArt, r.coverUrl, r.cover, r.artwork);
  const artworkWasSupplied = hasOwnAny(r, ['artworkUrl', 'coverArt', 'coverUrl', 'cover', 'artwork']);
  const artValid = artRaw && isHttpUrl(artRaw) ? artRaw : undefined;
  const dateRaw = firstStr(r.releaseDate);
  const releaseDateWasSupplied = hasOwnAny(r, ['releaseDate']);
  const uploadRaw = firstStr(r.uploadDate, r.createdAt);
  const uploadDateWasSupplied = hasOwnAny(r, ['uploadDate', 'createdAt']);
  const labelRaw = firstStr(r.label);
  const labelWasSupplied = hasOwnAny(r, ['label']);
  const artistRaw = firstStr(r.primaryArtist, r.artistName, r.artist);
  const featuredArtists = normalizeFeaturedArtists([
    ...(r.featuredArtists ?? []),
    ...(r.featured_artists ?? []),
  ]);

  const rawTracks = rawTracksEarly;
  const tracks: CanonicalDistributorTrack[] = rawTracks.map((t, i) => {
    const tTitle = firstStr(t.title, t.name);
    const isrcRaw = firstStr(t.isrc);
    const isrcWasSupplied = hasOwnAny(t, ['isrc']);
    const isrcValid = isrcRaw && ISRC_RE.test(isrcRaw) ? isrcRaw.toUpperCase() : undefined;
    const trackId = firstStr(t.id, t.trackId, t.uuid);
    // Identifier-only bundle members are valid (ISRC is itself an identity), but a completely
    // blank row is not a track. Accepting `{}` here used to emit a completed track with an empty
    // title and an absent ISRC, making truncated/schema-drifted responses look authoritative.
    if (!trackId && !tTitle && !isrcValid) {
      throw new SchemaMismatchError(`track ${i + 1} has no id, title, or valid ISRC`);
    }
    const num = t.trackNumber ?? t.position ?? i + 1;
    const dur = t.durationSec ?? t.duration ?? undefined;
    return {
      ...(trackId ? { distributorTrackId: trackId } : {}),
      title: tTitle ?? '',
      // A missing value is a source gap. A supplied-but-malformed value is our parse failure and
      // must remain retryable; collapsing both to ABSENT_AT_SOURCE would falsely blame the source.
      isrc: isrcValid
        ? present(isrcValid, source, PARSER_VERSION)
        : isrcRaw
          ? notCaptured<string>('PARSE_FAILED', source, PARSER_VERSION)
          : isrcWasSupplied
            ? absentAtSource<string>(source, PARSER_VERSION)
            : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
      ...(typeof num === 'number' ? { trackNumber: num } : {}),
      ...(typeof dur === 'number' ? { durationSec: dur } : {}),
    };
  });

  return {
    distributorReleaseId: distributorReleaseId ?? title ?? 'unknown',
    title: title ?? '',
    ...(artistRaw ? { primaryArtist: artistRaw } : {}),
    ...(featuredArtists.length ? { featuredArtists } : {}),
    upc: upcValid
      ? present(upcValid, source, PARSER_VERSION)
      : upcRaw
        ? notCaptured<string>('PARSE_FAILED', source, PARSER_VERSION)
        : upcWasSupplied
          ? absentAtSource<string>(source, PARSER_VERSION)
          : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
    artworkUrl: artValid
      ? present(artValid, source, PARSER_VERSION)
      : artRaw
        ? notCaptured<string>('PARSE_FAILED', source, PARSER_VERSION)
        : artworkWasSupplied
          ? absentAtSource<string>(source, PARSER_VERSION)
          : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
    releaseDate: dateRaw
      ? present(dateRaw, source, PARSER_VERSION)
      : releaseDateWasSupplied
        ? absentAtSource<string>(source, PARSER_VERSION)
        : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
    uploadDate: uploadRaw
      ? present(uploadRaw, source, PARSER_VERSION)
      : uploadDateWasSupplied
        ? absentAtSource<string>(source, PARSER_VERSION)
        : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
    label: labelRaw
      ? present(labelRaw, source, PARSER_VERSION)
      : labelWasSupplied
        ? absentAtSource<string>(source, PARSER_VERSION)
        : notCaptured<string>('NOT_CAPTURED', source, PARSER_VERSION),
    tracks,
  };
}
