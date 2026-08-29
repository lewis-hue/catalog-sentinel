/**
 * Candidate scoring: how "catalog-like" is a JSON payload?
 *
 * Discovery must not dump every JSON request into a log for a human to read. It ranks
 * candidates automatically so production can pick an endpoint without manual steps.
 *
 * Scoring works on KEY NAMES ONLY, never values (values may be sensitive).
 */
import { isSensitiveKey } from './redaction';

/** Reward genuine catalog signals. ISRC/UPC are the strongest. */
export const CATALOG_FIELD_WEIGHTS: Record<string, number> = {
  isrc: 10,
  upc: 10,
  barcode: 8,
  ean: 6,
  tracks: 5,
  tracklist: 5,
  artwork: 5,
  artworkurl: 5,
  coverart: 5,
  coverurl: 5,
  cover: 4,
  release: 4,
  releaseid: 4,
  releaseuuid: 4,
  albumuuid: 4,
  albumid: 4,
  trackid: 4,
  trackuuid: 4,
  releasedate: 3,
  title: 2,
  artist: 2,
  artistname: 2,
  label: 2,
};

/**
 * Penalize payloads that are clearly NOT catalog data. Without this, a big analytics or
 * feature-flag blob can accumulate incidental points and outrank the real release endpoint.
 */
export const NON_CATALOG_PENALTIES: Record<string, number> = {
  // analytics / telemetry
  event: -6, events: -6, pageview: -6, analytics: -8, telemetry: -8, ga: -4, gtm: -4, sessionid: -4,
  // feature flags / config
  featureflags: -8, flags: -6, config: -5, experiment: -6, variant: -4, ab: -3,
  // notifications
  notifications: -6, notification: -6, unread: -4, banner: -4, toast: -4,
  // profile / billing / money (also denylisted by path, this is defence in depth)
  billing: -10, invoice: -10, payment: -10, payout: -10, bank: -10, tax: -10, card: -10,
  subscription: -6, plan: -4, profile: -5, useremail: -8, email: -6, phone: -6, address: -6,
};

/** Minimum score to treat a payload as release metadata (≈ one strong signal). */
export const MIN_CATALOG_SCORE = 10;

/** Normalize a key the way schema collection does (lowercase, alphanumeric only). */
export const normalizeKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Collect normalized KEY NAMES (never values) to a bounded depth/breadth.
 * Sensitive key names are recorded as `{redacted}` so we don't even echo them.
 */
export function collectKeys(value: unknown, maxDepth: number, depth = 0, output = new Set<string>()): string[] {
  if (depth > maxDepth || value === null || value === undefined || output.size > 500) return [...output];
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 15)) collectKeys(item, maxDepth, depth + 1, output);
    return [...output];
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output.add(isSensitiveKey(key) ? '{redacted}' : normalizeKey(key));
      collectKeys(nested, maxDepth, depth + 1, output);
    }
  }
  return [...output];
}

/** Score a payload's schema. Rewards catalog fields, penalizes analytics/config/billing shapes. */
export function scoreCatalogPayload(keys: string[]): number {
  const raw = keys.reduce((score, key) => score + (CATALOG_FIELD_WEIGHTS[key] ?? 0) + (NON_CATALOG_PENALTIES[key] ?? 0), 0);
  return Math.max(0, raw);
}

/** Does the payload carry at least one STRONG identifier signal (isrc/upc/barcode)? */
export function hasStrongCatalogSignal(keys: string[]): boolean {
  return keys.some((k) => k === 'isrc' || k === 'upc' || k === 'barcode');
}

/**
 * Extra confidence signals gathered across a discovery run:
 *  - a response whose payload CHANGES between releases is release-specific (good)
 *  - a response identical across releases is config/nav (bad)
 */
export interface VariabilityObservation {
  fingerprint: string;
  /** Distinct payload hashes seen for this endpoint across different releases. */
  distinctPayloads: number;
  /** How many releases this endpoint was observed for. */
  observations: number;
}

/**
 * Final candidate rank: base schema score, boosted when the endpoint varies per release and
 * penalized when it never varies (a static config blob can't be release metadata).
 */
export function rankCandidate(baseScore: number, v: VariabilityObservation): number {
  if (v.observations < 2) return baseScore;
  const varies = v.distinctPayloads > 1;
  const ratio = v.distinctPayloads / v.observations;
  if (!varies) return Math.max(0, baseScore - 8); // identical across releases → not release data
  return baseScore + Math.round(6 * Math.min(1, ratio)); // varies predictably → release-specific
}
