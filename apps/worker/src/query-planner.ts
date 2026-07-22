import { normalizeTitle } from '@sentinel/adapters';

/**
 * Deep-scan QUERY PLANNER — keeps large catalogues from exploding into
 * tracks × platforms × engines searches. The plan:
 *   1. Bounds the track set to a per-scan budget.
 *   2. Skips tracks already confirmed everywhere (official APIs first).
 *   3. Deduplicates by normalized (artist, title): the WebPresenceResolver runs ONE
 *      broad query per unique song (cached), so 1,000 tracks with 200 duplicate
 *      titles cost ~800 broad queries, not 1,000 × platforms.
 *   4. Chunks the work so results are checkpointed and memory stays bounded.
 *
 * For 1,000 tracks × 10 platforms the search-call estimate is O(uniqueSongs × platforms)
 * in the WORST case (every broad query misses every platform and needs a follow-up), and
 * far less in practice — never O(tracks × platforms × engines).
 */
export interface PlannerTrack {
  title: string;
  primaryArtist: string;
  isrc: string | null;
}

export interface DeepScanPlanInput {
  tracks: PlannerTrack[];
  /** Web platforms to verify (those without an official API / key). */
  platforms: string[];
  /** Track indices already fully resolved (skip — no web verification needed). */
  confirmedTrackIndices?: ReadonlySet<number>;
  /** Hard cap on tracks per scan (DEEP_SCAN_MAX_TRACKS_PER_SCAN). */
  maxTracks?: number;
  /** Tracks per chunk (DEEP_SCAN_TRACK_CHUNK_SIZE) — checkpoint boundary. */
  chunkSize?: number;
}

export interface DeepScanPlan {
  totalTracks: number;
  platforms: string[];
  /** Track indices (into the ORIGINAL array) that will be web-verified, in chunks. */
  chunks: number[][];
  tracksToVerify: number;
  /** Distinct (artist,title) songs → the number of broad search queries actually run. */
  uniqueQueries: number;
  /** Worst-case upstream search calls (broad + one follow-up per platform per unique song). */
  estimatedSearchCalls: number;
  skippedOverBudget: number;
  skippedConfirmed: number;
}

export function planDeepScan(input: DeepScanPlanInput): DeepScanPlan {
  const maxTracks = Math.max(0, input.maxTracks ?? 5000);
  const chunkSize = Math.max(1, input.chunkSize ?? 25);
  const confirmed = input.confirmedTrackIndices ?? new Set<number>();

  const boundedCount = Math.min(input.tracks.length, maxTracks);
  const skippedOverBudget = input.tracks.length - boundedCount;

  const toVerify: number[] = [];
  const uniqueKeys = new Set<string>();
  let skippedConfirmed = 0;
  for (let i = 0; i < boundedCount; i++) {
    if (confirmed.has(i)) { skippedConfirmed++; continue; }
    toVerify.push(i);
    const t = input.tracks[i]!;
    uniqueKeys.add(`${normalizeTitle(t.primaryArtist)}|${normalizeTitle(t.title)}`);
  }

  const chunks: number[][] = [];
  for (let i = 0; i < toVerify.length; i += chunkSize) chunks.push(toVerify.slice(i, i + chunkSize));

  const uniqueQueries = uniqueKeys.size;
  const estimatedSearchCalls = uniqueQueries * (1 + input.platforms.length);

  return {
    totalTracks: input.tracks.length,
    platforms: input.platforms,
    chunks,
    tracksToVerify: toVerify.length,
    uniqueQueries,
    estimatedSearchCalls,
    skippedOverBudget,
    skippedConfirmed,
  };
}
