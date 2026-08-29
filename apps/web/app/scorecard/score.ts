/**
 * Label Health Score (pure).
 *
 * One 0–100 catalogue-health number with a transparent breakdown, computed from data the detection
 * modules already produce: catalogue metadata completeness, store presence, artist identity, and
 * lyric coverage. Components whose check hasn't run are "not assessed" and excluded from the score
 * (the weights re-normalise), so the number is honest about what it has actually measured.
 */

/** Store-lyric verdict per catalogue track (LRCLIB): found | not-found | instrumental | unverifiable | unknown. */
export interface ScoreCatalogueTrack { storeLyricStatus?: string }
export interface ScoreCatalogueRelease { tracks: ScoreCatalogueTrack[] }
export interface ScoreCatalogue {
  releaseCount: number;
  trackCount: number;
  upcPresent: number;
  artworkPresent: number;
  isrcPresent: number;
  /** Progress of the store-lyrics check, lyric coverage is assessed once this is `done`. */
  storeLyricsCheck?: { status: string };
  releases?: ScoreCatalogueRelease[];
}
export interface ScorePerStore { store: string; status: string }
export interface ScoreRecTrack { perStore: ScorePerStore[] }
export interface ScoreRecord {
  deepScan?: { status: string };
  result: { stores: string[]; tracks: ScoreRecTrack[] };
}

export interface ScoreComponent {
  key: 'metadata' | 'store' | 'identity' | 'lyrics';
  label: string;
  /** 0–100, or null when the underlying check has not run. */
  score: number | null;
  weight: number;
  detail: string;
}
export interface HealthScore {
  /** Weighted average of assessed components, 0–100, or null if nothing is assessed yet. */
  overall: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | '-';
  components: ScoreComponent[];
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const gradeOf = (n: number | null): HealthScore['grade'] =>
  n == null ? '-' : n >= 90 ? 'A' : n >= 80 ? 'B' : n >= 70 ? 'C' : n >= 60 ? 'D' : 'F';

export function computeHealth(catalogue: ScoreCatalogue, record: ScoreRecord | null): HealthScore {
  const components: ScoreComponent[] = [];

  // 1) Metadata completeness, always assessable from the scraped catalogue.
  const rc = catalogue.releaseCount || 0;
  const tc = catalogue.trackCount || 0;
  const upcPct = rc ? catalogue.upcPresent / rc : 1;
  const artPct = rc ? catalogue.artworkPresent / rc : 1;
  const isrcPct = tc ? catalogue.isrcPresent / tc : 1;
  components.push({
    key: 'metadata', label: 'Metadata completeness', weight: 30,
    score: Math.round(((upcPct + artPct + isrcPct) / 3) * 100),
    detail: `UPC ${pct(upcPct)} · ISRC ${pct(isrcPct)} · Artwork ${pct(artPct)}`,
  });

  const tracks = record?.result.tracks ?? [];
  const storeAssessed = record?.deepScan?.status === 'done' && (record?.result.stores?.length ?? 0) > 0;

  // 2) Store presence + 3) Artist identity, both from the store check.
  if (storeAssessed) {
    let live = 0;
    let decisive = 0;
    let wrongTracks = 0;
    for (const t of tracks) {
      let trackWrong = false;
      for (const c of t.perStore ?? []) {
        if (c.status === 'live') { live += 1; decisive += 1; }
        else if (c.status === 'not-live') { decisive += 1; }
        else if (c.status === 'wrong-profile') { decisive += 1; trackWrong = true; }
      }
      if (trackWrong) wrongTracks += 1;
    }
    components.push({
      key: 'store', label: 'Store presence', weight: 35,
      score: decisive ? Math.round((live / decisive) * 100) : null,
      detail: decisive ? `${live}/${decisive} store placements live` : 'No decisive store results',
    });
    components.push({
      key: 'identity', label: 'Artist identity', weight: 20,
      score: tracks.length ? Math.round((1 - wrongTracks / tracks.length) * 100) : 100,
      detail: wrongTracks ? `${wrongTracks} track(s) on a wrong profile` : 'All tracks on your profile',
    });
  } else {
    components.push({ key: 'store', label: 'Store presence', weight: 35, score: null, detail: 'Run a store check' });
    components.push({ key: 'identity', label: 'Artist identity', weight: 20, score: null, detail: 'Run a store check' });
  }

  // 4) Lyric coverage, from the LRCLIB store-side check (now on the catalogue, not the record).
  if (catalogue.storeLyricsCheck?.status === 'done') {
    let found = 0;
    let checked = 0;
    for (const rel of catalogue.releases ?? []) {
      for (const t of rel.tracks) {
        // Coverage = of tracks with a definite lyric/no-lyric verdict, how many have lyrics on stores.
        // Instrumental (legitimately no lyrics) and unverifiable/unknown are excluded, not penalised.
        if (t.storeLyricStatus === 'found') { found += 1; checked += 1; }
        else if (t.storeLyricStatus === 'not-found') { checked += 1; }
      }
    }
    components.push({
      key: 'lyrics', label: 'Lyric coverage', weight: 15,
      score: checked ? Math.round((found / checked) * 100) : null,
      detail: checked ? `${found}/${checked} tracks with lyrics on stores` : 'No lyric results',
    });
  } else {
    components.push({ key: 'lyrics', label: 'Lyric coverage', weight: 15, score: null, detail: 'Run a lyric check' });
  }

  const assessed = components.filter((c) => c.score !== null);
  const totalWeight = assessed.reduce((s, c) => s + c.weight, 0);
  const overall = totalWeight
    ? Math.round(assessed.reduce((s, c) => s + (c.score as number) * c.weight, 0) / totalWeight)
    : null;

  return { overall, grade: gradeOf(overall), components };
}
