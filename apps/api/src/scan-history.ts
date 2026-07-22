import type { SearchRecord } from '@sentinel/search-store';

export const SCAN_NAME_MAX_LENGTH = 120;

export type ScanNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Normalize and validate a label that will be displayed throughout scan history.
 * Control/format characters are rejected rather than silently hidden in logs or UI.
 */
export function validateScanName(value: unknown): ScanNameValidation {
  if (typeof value !== 'string') return { ok: false, error: 'name must be a string' };
  if (/\p{Cc}|\p{Cf}/u.test(value)) {
    return { ok: false, error: 'name must not contain control or invisible format characters' };
  }
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name) return { ok: false, error: 'name is required' };
  if ([...name].length > SCAN_NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be at most ${SCAN_NAME_MAX_LENGTH} characters` };
  }
  return { ok: true, name };
}

export function isActiveSearch(record: Pick<SearchRecord, 'deepScan' | 'result'>): boolean {
  return record.deepScan?.status === 'idle'
    || record.deepScan?.status === 'queued'
    || record.deepScan?.status === 'running'
    || record.result.warnings.includes('__reading_in_progress__');
}

export function activeSearchStage(record: Pick<SearchRecord, 'deepScan' | 'result'>): string | null {
  if (record.result.warnings.includes('__reading_in_progress__')) return 'reading_distributor_catalog';
  return isActiveSearch(record) ? (record.deepScan?.status ?? 'active') : null;
}
