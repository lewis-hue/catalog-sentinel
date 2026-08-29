const KNOWN_EXTRACTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  // ReleaseFailureReason
  'TIMEOUT',
  'REQUEST_FAILED',
  'PARSE_FAILED',
  'SCHEMA_CHANGED',
  'REAUTH_REQUIRED',
  'NOT_AUTHORIZED',
  'RATE_LIMITED',
  'BUDGET_EXHAUSTED',
  'UNKNOWN',

  // DistroKidCatalogIndexErrorCode
  'INVALID_CATALOG_URL',
  'AUTHENTICATION_REQUIRED',
  'INVALID_RELEASE_LIMIT',
  'RELEASE_IDENTITY_MISSING',
  'RELEASE_IDENTITY_CONFLICT',
  'RELEASE_LIMIT_REACHED',
  'LOAD_BUDGET_EXHAUSTED',
  'AUTHENTICATION_EXPIRED',
  'NO_RECOGNIZABLE_RELEASES',
  'UNSAFE_RELEASE_URL',

  // DistroKid pipeline terminal failure codes
  'PIPELINE_DEADLINE_EXCEEDED',
  'PIPELINE_CONFIGURATION_INVALID',
  'ACCOUNT_LOCK_UNAVAILABLE',
  'ACCOUNT_LOCK_LOST',
  'STAGE_TIMEOUT',
  'CATALOG_INDEX_FAILED',
  'PIPELINE_STAGE_FAILED',
]);

/**
 * Render only reviewed machine codes. Completeness records can outlive the producer version
 * that created them, so malformed, obsolete, or unexpected keys must not become public text.
 */
export function failureReasonSummary(reasons: Record<string, number> | undefined): string {
  const totals = new Map<string, number>();
  for (const [rawReason, rawCount] of Object.entries(reasons ?? {})) {
    if (!Number.isSafeInteger(rawCount) || rawCount <= 0) continue;
    const candidate = rawReason.trim().toUpperCase();
    const code = KNOWN_EXTRACTION_FAILURE_CODES.has(candidate)
      ? candidate
      : 'UNCLASSIFIED_FAILURE';
    totals.set(code, (totals.get(code) ?? 0) + rawCount);
  }
  return [...totals.entries()].map(([code, count]) => `${code} ${count}`).join(', ');
}
