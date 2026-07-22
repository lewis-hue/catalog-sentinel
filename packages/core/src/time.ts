import type { IsoTimestamp } from './entities';

/**
 * Injectable clock so scans/reports are deterministic in tests. Production code
 * uses {@link systemClock}; tests pass a fixed clock.
 */
export interface Clock {
  now(): Date;
  nowIso(): IsoTimestamp;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export function fixedClock(iso: IsoTimestamp): Clock {
  const d = new Date(iso);
  return {
    now: () => new Date(d),
    nowIso: () => d.toISOString(),
  };
}
