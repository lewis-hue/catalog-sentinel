/** Issue severity model (PRD §R). Ordered so it can be sorted/compared. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Sort comparator: most severe first. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function isAtLeastSeverity(value: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[value] <= SEVERITY_RANK[threshold];
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};
