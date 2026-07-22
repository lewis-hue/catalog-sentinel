import { GovernanceValidationError } from './governance-types';
import {
  RETENTION_RESOURCE_KINDS,
  RetentionWorker,
  type RetentionAdapter,
  type RetentionSchedulerRepository,
} from './retention';
import {
  TenantErasureOrchestrator,
  type TenantErasureAdapter,
  type TenantErasureRepository,
} from './tenant-erasure';
import type { AuditChainAnchorPublisher } from './audit-chain';

export interface GovernanceMaintenanceResult {
  retentionRunsScheduled: number;
  retentionRunsClaimed: number;
  retentionRunsCompleted: number;
  retentionRunsCheckpointed: number;
  retentionRunsRetried: number;
  erasuresClaimed: number;
  erasuresCompleted: number;
  erasuresCheckpointed: number;
  erasuresRetried: number;
  auditAnchorsPublished: number;
  auditLegalHoldsPurged: number;
}

export interface GovernanceMaintenanceOptions {
  now?: string;
  retentionCadenceMs?: number;
  leaseMs?: number;
  batchLimit?: number;
  anchorLimit?: number;
  auditPurgeLimit?: number;
}

/** Capability exposed by the finite audit-hold adapter after controlled expiry. */
export interface ExpiredAuditHoldPurger {
  purgeExpired(now?: string, limit?: number): Promise<number>;
}

/**
 * Process-level composition for the scheduler/worker. Construction fails unless every supported
 * retention resource and every mandatory erasure resource has one concrete adapter. There are no
 * no-op adapters: an unavailable Keycloak, backup, object-store, or observability integration must
 * prevent startup rather than produce a false deletion receipt.
 */
export class ProductionGovernanceMaintenanceService {
  private readonly retentionWorker: RetentionWorker;
  private readonly erasureOrchestrator: TenantErasureOrchestrator;

  constructor(
    private readonly retentionRepository: RetentionSchedulerRepository,
    erasureRepository: TenantErasureRepository,
    private readonly anchorPublisher: AuditChainAnchorPublisher,
    retentionAdapters: readonly RetentionAdapter[],
    erasureAdapters: readonly TenantErasureAdapter[],
    private readonly auditHoldPurger: ExpiredAuditHoldPurger,
  ) {
    const retentionKinds = new Set(retentionAdapters.map((adapter) => adapter.resourceKind));
    const missingRetention = RETENTION_RESOURCE_KINDS.filter((kind) => !retentionKinds.has(kind));
    if (retentionKinds.size !== retentionAdapters.length || missingRetention.length > 0) {
      throw new GovernanceValidationError(
        `Production retention adapter inventory is incomplete or duplicated (missing=${missingRetention.join(',') || 'none'}).`,
      );
    }
    this.retentionWorker = new RetentionWorker(retentionRepository, retentionAdapters);
    this.erasureOrchestrator = new TenantErasureOrchestrator(erasureRepository, erasureAdapters);
    this.erasureRepository = erasureRepository;
  }

  private readonly erasureRepository: TenantErasureRepository;

  async runCycle(options: GovernanceMaintenanceOptions = {}): Promise<GovernanceMaintenanceResult> {
    const now = options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new GovernanceValidationError('Governance maintenance now must be an ISO timestamp.');
    const cadenceMs = this.integer(options.retentionCadenceMs ?? 86_400_000, 60_000, 31 * 86_400_000, 'retentionCadenceMs');
    const leaseMs = this.integer(options.leaseMs ?? 60_000, 5_000, 15 * 60_000, 'leaseMs');
    const batchLimit = this.integer(options.batchLimit ?? 25, 1, 100, 'batchLimit');
    const anchorLimit = this.integer(options.anchorLimit ?? 100, 1, 1_000, 'anchorLimit');
    const auditPurgeLimit = this.integer(options.auditPurgeLimit ?? batchLimit, 1, 100, 'auditPurgeLimit');

    const scheduled = await this.retentionRepository.scheduleDue(now.toISOString(), cadenceMs, batchLimit);
    const retentionClaims = await this.retentionRepository.claimRuns({ limit: batchLimit, leaseMs });
    let retentionRunsCompleted = 0;
    let retentionRunsCheckpointed = 0;
    let retentionRunsRetried = 0;
    for (const claim of retentionClaims) {
      const outcome = await this.retentionWorker.process(claim);
      if (outcome === 'completed') retentionRunsCompleted += 1;
      else if (outcome === 'checkpointed') retentionRunsCheckpointed += 1;
      else retentionRunsRetried += 1;
    }

    const erasureClaims = await this.erasureRepository.claim({ limit: batchLimit, leaseMs });
    let erasuresCompleted = 0;
    let erasuresCheckpointed = 0;
    let erasuresRetried = 0;
    for (const claim of erasureClaims) {
      const outcome = await this.erasureOrchestrator.processOne(claim, leaseMs);
      if (outcome === 'completed') erasuresCompleted += 1;
      else if (outcome === 'checkpointed') erasuresCheckpointed += 1;
      else erasuresRetried += 1;
    }

    const anchors = await this.anchorPublisher.anchorDue(anchorLimit);
    // Anchors are durably published before an expired audit chain can be purged. The purger itself
    // verifies Object Lock expiry and creates the signed database receipt in the guarded transaction.
    const auditLegalHoldsPurged = await this.auditHoldPurger.purgeExpired(now.toISOString(), auditPurgeLimit);
    return {
      retentionRunsScheduled: scheduled.length,
      retentionRunsClaimed: retentionClaims.length,
      retentionRunsCompleted,
      retentionRunsCheckpointed,
      retentionRunsRetried,
      erasuresClaimed: erasureClaims.length,
      erasuresCompleted,
      erasuresCheckpointed,
      erasuresRetried,
      auditAnchorsPublished: anchors.length,
      auditLegalHoldsPurged,
    };
  }

  private integer(value: number, min: number, max: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new GovernanceValidationError(`${name} must be an integer from ${min} through ${max}.`);
    }
    return value;
  }
}
