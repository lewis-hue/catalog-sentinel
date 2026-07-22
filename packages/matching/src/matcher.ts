import { classifyConfidence, type ConfidenceBand } from '@sentinel/core';
import { titleSimilarity, overlapCoefficient } from './similarity';
import { isCommonTitle } from './normalize';

/**
 * Platform-neutral normalized item fed to the matching engine. Both the
 * distributor "subject" track and each DSP "candidate" are expressed this way,
 * so the engine has no knowledge of any specific platform. Fields are plain
 * arrays (JSON-serializable) and converted to sets internally.
 */
export interface NormalizedItem {
  id: string;
  isrc: string | null;
  upc?: string | null;
  /** Normalized base title (from `parseTitle().base`). */
  base: string;
  versionTags: string[];
  featured: string[];
  artistKeys: string[];
  durationSec?: number | null;
  trackNumber?: number | null;
  /** Platform-native ids/urls already known to belong to this item. */
  externalIds?: string[];
  /** For DSP candidates: which artist profile they were found under. */
  artistProfileId?: string | null;
}

export interface MatchWeights {
  title: number;
  artist: number;
  version: number;
  duration: number;
}

export interface MatchOptions {
  /** Max duration delta (sec) still considered the same recording. */
  sameRecordingToleranceSec?: number;
  weights?: Partial<MatchWeights>;
  /** Confirmed canonical artist profile id — mismatch flags WRONG_ARTIST_PROFILE. */
  canonicalArtistProfileId?: string | null;
}

export interface MatchSignal {
  name: string;
  value: number;
  detail?: string;
}

export interface MatchScore {
  score: number;
  band: ConfidenceBand;
  reasons: string[];
  signals: MatchSignal[];
  artistMismatch: boolean;
  versionMismatch: boolean;
}

const DEFAULT_WEIGHTS: MatchWeights = { title: 0.55, artist: 0.3, version: 0.1, duration: 0.05 };
const METADATA_SCORE_CAP = 0.97; // reserve >=0.98 for identifier matches (PRD §E)

function setEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

function versionScore(a: string[], b: string[]): { value: number; mismatch: boolean } {
  if (a.length === 0 && b.length === 0) return { value: 1, mismatch: false };
  if (setEq(a, b)) return { value: 1, mismatch: false };
  const overlap = overlapCoefficient(new Set(a), new Set(b));
  // A remix vs an original are different recordings — treat divergence as a mismatch.
  return { value: overlap === 0 ? 0 : 0.5, mismatch: true };
}

function durationScore(a: number | null | undefined, b: number | null | undefined, tol: number): number | null {
  if (a == null || b == null) return null; // unknown — neutral, excluded from weighting
  const delta = Math.abs(a - b);
  if (delta <= tol) return 1;
  if (delta <= tol * 3) return 0.5;
  return 0;
}

/**
 * Score how strongly a DSP candidate matches a distributor subject track.
 * Deterministic. Identifier matches short-circuit to the `confirmed` band; a
 * fuzzy metadata match is NEVER promoted to confirmed.
 */
export function scoreMatch(subject: NormalizedItem, candidate: NormalizedItem, opts: MatchOptions = {}): MatchScore {
  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const tol = opts.sameRecordingToleranceSec ?? 15;
  const signals: MatchSignal[] = [];
  const reasons: string[] = [];

  const artistOverlap = overlapCoefficient(new Set(subject.artistKeys), new Set(candidate.artistKeys));
  const artistMismatch = artistOverlap === 0;

  // 1. ISRC exact — strongest possible signal.
  if (subject.isrc && candidate.isrc && subject.isrc === candidate.isrc) {
    signals.push({ name: 'isrc-exact', value: 1 });
    reasons.push('ISRC exact match');
    return { score: 1, band: 'confirmed', reasons, signals, artistMismatch, versionMismatch: false };
  }

  // 2. Known platform id/url overlap — strongest when identifiers are absent.
  const subjIds = new Set(subject.externalIds ?? []);
  const idOverlap = (candidate.externalIds ?? []).some((x) => subjIds.has(x));
  if (idOverlap) {
    signals.push({ name: 'external-id-exact', value: 1 });
    reasons.push('Known platform ID/URL match');
    return { score: 0.99, band: 'confirmed', reasons, signals, artistMismatch, versionMismatch: false };
  }

  // Both carry an ISRC but they differ => declared as DIFFERENT recordings.
  const isrcConflict = !!(subject.isrc && candidate.isrc) && subject.isrc !== candidate.isrc;

  // 3. Metadata scoring.
  const titleSim = titleSimilarity(subject.base, candidate.base);
  const ver = versionScore(subject.versionTags, candidate.versionTags);
  const dur = durationScore(subject.durationSec, candidate.durationSec, tol);

  signals.push({ name: 'title-sim', value: round(titleSim) });
  signals.push({ name: 'artist-overlap', value: round(artistOverlap) });
  signals.push({ name: 'version', value: ver.value });
  if (dur !== null) signals.push({ name: 'duration', value: dur });

  // Weight, dropping the duration term when duration is unknown (renormalize).
  const wSum = weights.title + weights.artist + weights.version + (dur !== null ? weights.duration : 0);
  const raw =
    weights.title * titleSim +
    weights.artist * artistOverlap +
    weights.version * ver.value +
    (dur !== null ? weights.duration * dur : 0);
  let score = wSum === 0 ? 0 : raw / wSum;

  // Penalties / caps.
  if (isrcConflict) {
    score = Math.min(score, 0.4); // conflicting ISRCs => not the same recording
    signals.push({ name: 'isrc-conflict', value: 0 });
    reasons.push('Different ISRCs — distinct recordings');
  }
  if (ver.mismatch) {
    score = Math.min(score, 0.6); // remix/version divergence => different recording
    reasons.push('Version/edit tag mismatch');
  }
  if (artistMismatch) {
    score = Math.min(score, 0.55);
    reasons.push('No artist overlap (possible wrong profile)');
  }
  if (dur === 0) {
    score = Math.min(score, 0.6);
    reasons.push('Duration differs beyond tolerance');
  }
  if (isCommonTitle(subject.base) && !subject.isrc) {
    score *= 0.85;
    signals.push({ name: 'common-title-penalty', value: 0.85 });
    reasons.push('Common/short title penalty');
  }

  score = Math.min(score, METADATA_SCORE_CAP);
  const band = classifyConfidence(score);
  if (reasons.length === 0) reasons.push(`Metadata match (title ${round(titleSim)}, artist ${round(artistOverlap)})`);

  return { score: round(score), band, reasons, signals, artistMismatch, versionMismatch: ver.mismatch };
}

export interface RankedMatch {
  candidate: NormalizedItem;
  score: MatchScore;
}

export interface CatalogMatchResult {
  subject: NormalizedItem;
  best: RankedMatch | null;
  ranked: RankedMatch[];
  decision: 'matched' | 'review' | 'unmatched';
  /** Title+version strongly match a candidate, but under a different artist. */
  wrongProfileSuspected: boolean;
  /** Best candidate sits under a non-canonical artist profile. */
  crossProfile: boolean;
}

/**
 * Match one subject track against a whole DSP candidate catalog, returning the
 * ranked candidates and a decision. Nothing below the `strong` band is treated
 * as a confirmed match — those become manual-review tasks (PRD §E).
 */
export function matchAgainstCatalog(
  subject: NormalizedItem,
  candidates: NormalizedItem[],
  opts: MatchOptions = {},
): CatalogMatchResult {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreMatch(subject, candidate, opts) }))
    .sort((a, b) => b.score.score - a.score.score);

  const best = ranked[0] ?? null;

  let decision: CatalogMatchResult['decision'] = 'unmatched';
  let wrongProfileSuspected = false;
  let crossProfile = false;

  if (best) {
    const { band, artistMismatch, versionMismatch } = best.score;
    const strongTitle = titleSimilarity(subject.base, best.candidate.base) >= 0.9 && !versionMismatch;

    if ((band === 'confirmed' || band === 'strong') && !artistMismatch) {
      decision = 'matched';
      if (
        opts.canonicalArtistProfileId &&
        best.candidate.artistProfileId &&
        best.candidate.artistProfileId !== opts.canonicalArtistProfileId
      ) {
        crossProfile = true;
      }
    } else if (band === 'probable') {
      decision = 'review';
    } else if (artistMismatch && strongTitle) {
      // Track clearly present, but under a different artist — a wrong-profile lead.
      decision = 'review';
      wrongProfileSuspected = true;
    } else {
      decision = 'unmatched';
    }
  }

  return { subject, best, ranked, decision, wrongProfileSuspected, crossProfile };
}

/**
 * Detect ISRCs shared by more than one DISTINCT recording (PRD §F #15). Items
 * that share both ISRC and normalized base title are considered the same
 * recording (legitimate) and are not flagged.
 */
export function detectDuplicateIsrcs(items: NormalizedItem[]): Map<string, NormalizedItem[]> {
  const byIsrc = new Map<string, NormalizedItem[]>();
  for (const it of items) {
    if (!it.isrc) continue;
    const list = byIsrc.get(it.isrc) ?? [];
    list.push(it);
    byIsrc.set(it.isrc, list);
  }
  const dupes = new Map<string, NormalizedItem[]>();
  for (const [isrc, list] of byIsrc) {
    const distinctTitles = new Set(list.map((i) => i.base));
    if (list.length > 1 && distinctTitles.size > 1) dupes.set(isrc, list);
  }
  return dupes;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
