/** String-similarity primitives used by the matching engine. All pure. */

/** Classic Levenshtein edit distance (iterative, O(n*m) time, O(n) space). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Normalized edit-distance similarity in [0,1]; 1 = identical. */
export function levenshteinRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

/** Jaccard overlap of token sets in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function sortTokens(s: string): string {
  return s.split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Title similarity robust to both word reordering and typos. Takes the best of
 * a direct edit-distance ratio and a token-sorted edit-distance ratio (the
 * fuzzywuzzy "token sort" approach), so "summer night" vs "summer nights" and
 * "drive night" vs "night drive" both score high.
 */
export function titleSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const direct = levenshteinRatio(a, b);
  const sorted = levenshteinRatio(sortTokens(a), sortTokens(b));
  return Math.max(direct, sorted);
}

/** Overlap coefficient between two sets in [0,1]; 1 when one is a subset. */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}
