/**
 * Confidence bands (PRD §E). The matching engine emits a raw score in [0,1];
 * these bands turn it into a decision. Fuzzy matches are NEVER silently treated
 * as confirmed — anything below `strong` surfaces a manual-review task.
 */
export const CONFIDENCE_BANDS = ['confirmed', 'strong', 'probable', 'weak', 'no-match'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const CONFIDENCE_THRESHOLDS = {
  confirmed: 0.98,
  strong: 0.9,
  probable: 0.75,
  weak: 0.5,
} as const;

export function classifyConfidence(score: number): ConfidenceBand {
  const s = Math.max(0, Math.min(1, score));
  if (s >= CONFIDENCE_THRESHOLDS.confirmed) return 'confirmed';
  if (s >= CONFIDENCE_THRESHOLDS.strong) return 'strong';
  if (s >= CONFIDENCE_THRESHOLDS.probable) return 'probable';
  if (s >= CONFIDENCE_THRESHOLDS.weak) return 'weak';
  return 'no-match';
}

/** A confirmed/strong band is safe to auto-accept; the rest need human eyes. */
export function requiresManualReview(band: ConfidenceBand): boolean {
  return band !== 'confirmed' && band !== 'strong';
}

export const CONFIDENCE_BAND_LABEL: Record<ConfidenceBand, string> = {
  confirmed: 'Confirmed (exact identifier)',
  strong: 'Strong (metadata)',
  probable: 'Probable — review',
  weak: 'Weak',
  'no-match': 'No match',
};
