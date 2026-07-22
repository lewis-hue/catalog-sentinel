export interface ShutdownPhase {
  name: string;
  close: Array<() => Promise<void>>;
}

/** Drain resource owners before the dependencies they use, while still closing peers in parallel. */
export async function runShutdownPhases(
  phases: readonly ShutdownPhase[],
  onFailure?: (phase: string, error: unknown) => void,
): Promise<boolean> {
  let failed = false;
  for (const phase of phases) {
    const results = await Promise.allSettled(phase.close.map((close) => close()));
    for (const result of results) {
      if (result.status === 'rejected') {
        failed = true;
        onFailure?.(phase.name, result.reason);
      }
    }
  }
  return !failed;
}
