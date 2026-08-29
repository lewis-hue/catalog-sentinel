import type { TenantContext } from '@sentinel/db';
import { createQueues, type DeepScanJobPayload, type QueueBundle } from './bullmq';

/** Minimal handle to a persisted, QUEUED scan needed to route it. */
export interface DispatchableScan {
  id: string;
  artistWorkspaceId: string;
  distributorConnectionId: string;
}

export interface DeepScanDispatcher {
  /**
   * Hand off an already-persisted, QUEUED scan for execution. Returns promptly -
   * it does NOT wait for the scan to finish (callers poll the scan row).
   */
  dispatch(ctx: TenantContext, scan: DispatchableScan): Promise<void>;
  close(): Promise<void>;
}

/**
 * Enqueues the scan onto the Redis `deep-scan` BullMQ queue; a separate worker
 * process consumes it and runs it against the SHARED database. This is the
 * production "celery-style" handoff, heavy scans never run in the API request
 * path. `jobId = scan.id` makes the enqueue idempotent (a scan can't be double-run).
 *
 * The worker attaches to the durable Steel session referenced by the queued job.
 */
export class BullMqDeepScanDispatcher implements DeepScanDispatcher {
  private constructor(private readonly bundle: QueueBundle) {}

  static fromRedisUrl(redisUrl: string): BullMqDeepScanDispatcher {
    return new BullMqDeepScanDispatcher(createQueues(redisUrl));
  }

  static fromBundle(bundle: QueueBundle): BullMqDeepScanDispatcher {
    return new BullMqDeepScanDispatcher(bundle);
  }

  async dispatch(ctx: TenantContext, scan: DispatchableScan): Promise<void> {
    const payload: DeepScanJobPayload = {
      tenantId: ctx.tenantId,
      artistWorkspaceId: scan.artistWorkspaceId,
      deepScanRunId: scan.id,
      distributorConnectionId: scan.distributorConnectionId,
    };
    await this.bundle.queues['deep-scan'].add('runDistributorDeepScan', payload, { jobId: scan.id });
  }

  async close(): Promise<void> {
    await this.bundle.close();
  }
}
