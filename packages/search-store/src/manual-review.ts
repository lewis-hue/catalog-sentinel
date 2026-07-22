import type { CatalogTrackLike, PerStoreLike, SearchRecord } from './search-store';

/**
 * First-class manual-review queue. Low-confidence / unverifiable presence cells (a web
 * search couldn't confirm a platform, so we NEVER assert present/missing) become review
 * tasks. A human confirms present / missing / wrong-profile / dismiss, and the decision
 * is written back to the presence matrix (the scan record) as an authoritative,
 * confidence-1.0 result. Items are DERIVED from the record — no duplicated state.
 */
export type ManualReviewDecision = 'CONFIRMED_PRESENT' | 'CONFIRMED_MISSING' | 'WRONG_PROFILE' | 'DISMISSED';
export const MANUAL_REVIEW_DECISIONS: ManualReviewDecision[] = ['CONFIRMED_PRESENT', 'CONFIRMED_MISSING', 'WRONG_PROFILE', 'DISMISSED'];

export interface ManualReviewItem {
  id: string; // opaque, encodes (trackIndex, platform)
  scanId: string;
  platform: string;
  trackIndex: number;
  trackTitle: string;
  album: string | null;
  isrc: string | null;
  status: string;
  confidence: number;
  reason: string;
  /** The search to run to verify manually. */
  query: string | null;
  candidateUrl: string | null;
  resolved: boolean;
  reviewDecision?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
}

export function encodeItemId(trackIndex: number, platform: string): string {
  return Buffer.from(`${trackIndex}::${platform}`).toString('base64url');
}
export function decodeItemId(itemId: string): { trackIndex: number; platform: string } | null {
  try {
    const [idx, ...rest] = Buffer.from(itemId, 'base64url').toString('utf8').split('::');
    const trackIndex = Number(idx);
    const platform = rest.join('::');
    if (!Number.isInteger(trackIndex) || !platform) return null;
    return { trackIndex, platform };
  } catch {
    return null;
  }
}

function reasonFor(p: PerStoreLike): string {
  if (p.reviewDecision) return `Resolved: ${p.reviewDecision}`;
  if (p.status === 'unverifiable') return 'Web search could not confirm presence on this platform (no official API / weak index) — verify manually.';
  return `Low confidence (${p.confidence.toFixed(2)}) — verify manually.`;
}

/** Every cell needing review (open first), across the whole catalogue. */
export function deriveManualReviewItems(rec: SearchRecord, opts: { includeResolved?: boolean } = {}): ManualReviewItem[] {
  const items: ManualReviewItem[] = [];
  rec.result.tracks.forEach((t: CatalogTrackLike, i) => {
    for (const p of t.perStore) {
      const resolved = Boolean(p.reviewDecision);
      if (!p.needsManualReview && !resolved) continue;
      if (resolved && !opts.includeResolved) continue;
      items.push({
        id: encodeItemId(i, p.store),
        scanId: rec.id,
        platform: p.store,
        trackIndex: i,
        trackTitle: t.title,
        album: t.album,
        isrc: t.isrc,
        status: p.status,
        confidence: p.confidence,
        reason: reasonFor(p),
        query: p.reviewQuery ?? (t.isrc ? `${rec.artist} ${t.title}` : `${rec.artist} ${t.title}`),
        candidateUrl: p.url ?? null,
        resolved,
        reviewDecision: p.reviewDecision,
        reviewedBy: p.reviewedBy,
        reviewedAt: p.reviewedAt,
        reviewNotes: p.reviewNotes,
      });
    }
  });
  // Open items first.
  return items.sort((a, b) => Number(a.resolved) - Number(b.resolved));
}

const DECISION_STATUS: Record<ManualReviewDecision, string | null> = {
  CONFIRMED_PRESENT: 'live',
  CONFIRMED_MISSING: 'not-live',
  WRONG_PROFILE: 'wrong-profile',
  DISMISSED: null, // keep current status; just clear the review flag
};

/**
 * Apply a human decision to one cell and write it back to the presence matrix as an
 * authoritative result (confidence 1.0, review flag cleared) + recompute the summary.
 */
export function applyManualReviewDecision(
  rec: SearchRecord,
  itemId: string,
  decision: ManualReviewDecision,
  opts: { reviewedBy?: string; notes?: string; at: string },
): SearchRecord | null {
  const target = decodeItemId(itemId);
  if (!target) return null;
  let matched = false;
  const tracks = rec.result.tracks.map((t, i) => {
    if (i !== target.trackIndex) return t;
    return {
      ...t,
      perStore: t.perStore.map((p) => {
        if (p.store !== target.platform) return p;
        matched = true;
        const nextStatus = DECISION_STATUS[decision] ?? p.status;
        return {
          ...p,
          status: nextStatus,
          confidence: decision === 'DISMISSED' ? p.confidence : 1,
          needsManualReview: false,
          reviewDecision: decision,
          reviewedBy: opts.reviewedBy ?? 'user',
          reviewedAt: opts.at,
          reviewNotes: opts.notes,
        };
      }),
    };
  });
  if (!matched) return null;
  const flat = tracks.flatMap((t) => t.perStore);
  return {
    ...rec,
    result: {
      ...rec.result,
      tracks,
      summary: {
        tracks: tracks.length,
        live: flat.filter((p) => p.status === 'live').length,
        notLive: flat.filter((p) => p.status === 'not-live').length,
        wrongProfile: flat.filter((p) => p.status === 'wrong-profile').length,
        needsReview: flat.filter((p) => p.needsManualReview).length,
      },
    },
  };
}
