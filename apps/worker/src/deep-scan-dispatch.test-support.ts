import type { TenantContext } from '@sentinel/db';
import { executeDeepScanRun, type DeepScanRunnerDeps } from './deep-scan-runner';
import type { DeepScanDispatcher, DispatchableScan } from './deep-scan-dispatch';

/** Process-local dispatcher used only by isolated integration tests. */
export class TestInlineDeepScanDispatcher implements DeepScanDispatcher {
  constructor(
    private readonly deps: DeepScanRunnerDeps,
    private readonly onError?: (error: unknown) => void,
  ) {}

  async dispatch(ctx: TenantContext, scan: DispatchableScan): Promise<void> {
    void executeDeepScanRun(this.deps, ctx, scan.id).catch((error) => this.onError?.(error));
  }

  async close(): Promise<void> {}
}
