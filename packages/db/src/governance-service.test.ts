import { describe, expect, it } from 'vitest';
import type { AuditChainAnchorPublisher } from './audit-chain';
import { ProductionGovernanceMaintenanceService } from './governance-service';
import { RETENTION_RESOURCE_KINDS, type RetentionAdapter, type RetentionSchedulerRepository } from './retention';
import {
  PRODUCTION_TENANT_ERASURE_RESOURCES,
  type TenantErasureAdapter,
  type TenantErasureRepository,
} from './tenant-erasure';

describe('production governance maintenance', () => {
  it('publishes audit anchors before processing durable expired-hold manifests', async () => {
    const order: string[] = [];
    const retentionRepository = {
      async scheduleDue() { return []; },
      async claimRuns() { return []; },
    } as unknown as RetentionSchedulerRepository;
    const erasureRepository = {
      async claim() { return []; },
    } as unknown as TenantErasureRepository;
    const anchorPublisher = {
      async anchorDue() { order.push('anchor'); return []; },
    } as unknown as AuditChainAnchorPublisher;
    const retentionAdapters = RETENTION_RESOURCE_KINDS.map((resourceKind) => ({
      resourceKind,
      async deleteBefore() { return { done: true, deletedCount: 0n, cursor: {} }; },
    })) as RetentionAdapter[];
    const erasureAdapters = PRODUCTION_TENANT_ERASURE_RESOURCES.map((resourceKind) => ({
      resourceKind,
      async erase() { return { done: true, deletedCount: 0n, checkpoint: {} }; },
    })) as TenantErasureAdapter[];
    const purger = {
      async purgeExpired() { order.push('purge'); return 2; },
    };
    const service = new ProductionGovernanceMaintenanceService(
      retentionRepository,
      erasureRepository,
      anchorPublisher,
      retentionAdapters,
      erasureAdapters,
      purger,
    );

    await expect(service.runCycle({ now: '2026-07-23T00:00:00.000Z' })).resolves.toMatchObject({
      auditAnchorsPublished: 0,
      auditLegalHoldsPurged: 2,
    });
    expect(order).toEqual(['anchor', 'purge']);
  });
});
