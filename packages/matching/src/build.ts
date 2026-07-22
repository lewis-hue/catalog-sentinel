import { normalizeIsrc, normalizeUpc } from '@sentinel/core';
import { parseTitle, normalizeArtistSet } from './normalize';
import type { NormalizedItem } from './matcher';

export interface NormalizedItemInput {
  id: string;
  title: string;
  artistNames: Array<string | null | undefined>;
  isrc?: string | null;
  upc?: string | null;
  durationSec?: number | null;
  trackNumber?: number | null;
  externalIds?: string[];
  artistProfileId?: string | null;
}

/**
 * Build a {@link NormalizedItem} from raw platform fields: parses the title into
 * base + version/featured, folds featured artists into the artist key set, and
 * canonicalizes identifiers. This is the single entry point both the distributor
 * and DSP sides use so their normalization can never drift apart.
 */
export function toNormalizedItem(input: NormalizedItemInput): NormalizedItem {
  const parsed = parseTitle(input.title);
  const artistKeys = normalizeArtistSet([...input.artistNames, ...parsed.featured]);
  return {
    id: input.id,
    isrc: normalizeIsrc(input.isrc),
    upc: normalizeUpc(input.upc),
    base: parsed.base,
    versionTags: parsed.versionTags,
    featured: parsed.featured,
    artistKeys: [...artistKeys],
    durationSec: input.durationSec ?? null,
    trackNumber: input.trackNumber ?? null,
    externalIds: input.externalIds ?? [],
    artistProfileId: input.artistProfileId ?? null,
  };
}
