/**
 * @sentinel/matching — deterministic, confidence-scored cross-platform matching.
 * No I/O, no platform coupling: callers normalize items via `toNormalizedItem`
 * then run `matchAgainstCatalog`.
 */
export * from './normalize';
export * from './similarity';
export * from './matcher';
export * from './build';
