export const SEARCH_HISTORY_NEXT_CURSOR_HEADER = 'x-sentinel-next-cursor';

/** Preserve server ordering while suppressing duplicate rows across page boundaries/retries. */
export function mergeHistoryRows<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const seen = new Set(current.map((row) => row.id));
  const merged = [...current];
  for (const row of incoming) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}
