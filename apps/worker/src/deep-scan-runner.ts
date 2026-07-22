import { getTelemetry, type Telemetry } from '@sentinel/core';
import type { BrowserLinkProvider } from '@sentinel/browser-link';
import type { DistributorScanner, ScanEvent } from '@sentinel/scanner';
import type { DistributorLinkRepository, LinkDeepScan, TenantContext } from '@sentinel/db';
import { runDeepScanJob } from './deep-scan-job';

/** Audit sink so the runner stays decoupled from any concrete logger. */
export interface DeepScanAuditSink {
  log(entry: {
    tenantId: string;
    workspaceId?: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }): void;
}

export interface DeepScanRunnerDeps {
  repo: DistributorLinkRepository;
  provider: BrowserLinkProvider;
  scanner: DistributorScanner;
  /** Rate-limit floor between page fetches (DISTRIBUTOR_SCAN_MIN_DELAY_MS). */
  minDelayMs: number;
  audit?: DeepScanAuditSink;
  /** Telemetry sink; defaults to the process-global one (no-op unless OTel is on). */
  telemetry?: Telemetry;
  /** Injectable clock for duration metrics (defaults to Date.now). */
  nowMs?: () => number;
}

export interface DeepScanRunSummary {
  status: string;
  releasesFound: number;
  tracksFound: number;
}

/**
 * Load the persisted scan/connection/consent/browser-state, run the deep scan, and
 * persist progress + terminal state back to the SAME tenant-scoped repository.
 *
 * This is the single source of truth for a queued deep scan. Production invokes it only from
 * the BullMQ worker; isolated tests may call it through test
 * support. Because the worker reads and writes PostgreSQL, the API can poll the same durable
 * scan record.
 *
 * The whole run is tenant-scoped: every repo call is filtered by `ctx.tenantId`, so
 * a mis-routed job can never touch another tenant's data.
 */
export async function executeDeepScanRun(
  deps: DeepScanRunnerDeps,
  ctx: TenantContext,
  scanId: string,
): Promise<DeepScanRunSummary> {
  const telemetry = deps.telemetry ?? getTelemetry();
  const now = deps.nowMs ?? (() => Date.now());
  const startedAt = now();
  const span = telemetry.startSpan('deep_scan.run', { 'tenant.id': ctx.tenantId, 'deep_scan.id': scanId });
  telemetry.addCounter('deep_scan.started', 1, { 'tenant.id': ctx.tenantId });

  const scan = await deps.repo.scans.get(ctx, scanId);
  if (!scan) { span.recordError(new Error('scan not found')); span.end('error'); throw new Error(`deep scan ${scanId} not found for tenant ${ctx.tenantId}`); }

  const conn = await deps.repo.connections.get(ctx, scan.distributorConnectionId);
  if (!conn) { span.end('error'); throw new Error(`connection ${scan.distributorConnectionId} not found`); }
  const consent = await deps.repo.consents.get(ctx, scan.consentId);
  if (!consent) { span.end('error'); throw new Error(`consent ${scan.consentId} not found`); }
  span.setAttribute('distributor', conn.distributor);
  const stateRef = conn.browserStateRefId ? await deps.repo.stateRefs.get(ctx, conn.browserStateRefId) : null;

  const events: ScanEvent[] = [];
  await deps.repo.scans.update(ctx, scanId, { status: 'RUNNING' });

  const res = await runDeepScanJob({
    provider: deps.provider,
    scanner: deps.scanner,
    consent: { scope: consent.scope, expiresAt: consent.expiresAt, revokedAt: consent.revokedAt },
    stateRef: stateRef
      ? { kind: stateRef.kind as never, encryptedRef: stateRef.encryptedRef, expiresAt: stateRef.expiresAt, revokedAt: stateRef.revokedAt }
      : null,
    config: {
      tenantId: ctx.tenantId,
      artistWorkspaceId: conn.artistWorkspaceId,
      distributor: 'distrokid',
      snapshotId: scanId,
      minDelayMs: deps.minDelayMs,
      onEvent: (e) => {
        events.push(e);
        const patch: Partial<LinkDeepScan> = { events: [...events] };
        if (e.type === 'scan_progress') {
          patch.progressPercent = e.percent;
          patch.currentStep = e.step;
        }
        // Best-effort progress; the terminal write below is awaited.
        void deps.repo.scans.update(ctx, scanId, patch);
      },
    },
  }).catch((err) => ({ status: 'FAILED' as const, result: null, error: err instanceof Error ? err.message : String(err) }));

  const patch: Partial<LinkDeepScan> = { status: res.status, events: [...events] };
  if (res.result) {
    patch.releasesFound = res.result.stats.releasesFound;
    patch.tracksFound = res.result.stats.tracksFound;
    patch.warningsCount = res.result.stats.warningsCount;
    patch.snapshot = res.result.snapshot;
    patch.snapshotId = res.result.snapshot?.id ?? null;
    patch.issues = res.result.issues;
  } else if (res.error) {
    patch.currentStep = res.error;
  }
  await deps.repo.scans.update(ctx, scanId, patch);
  await deps.repo.connections.update(ctx, scan.distributorConnectionId, { status: 'CONNECTED' });
  deps.audit?.log({
    tenantId: ctx.tenantId,
    workspaceId: conn.artistWorkspaceId,
    action: 'deep-scan.finished',
    targetType: 'DeepScanRun',
    targetId: scanId,
    metadata: { status: patch.status, tracks: patch.tracksFound ?? 0 },
  });

  const status = String(patch.status);
  const ok = status === 'COMPLETED' || status === 'COMPLETED_WITH_WARNINGS';
  span.setAttribute('deep_scan.status', status);
  span.setAttribute('deep_scan.tracks', patch.tracksFound ?? 0);
  if (res.error) span.recordError(new Error(res.error));
  span.end(ok ? 'ok' : 'error');
  telemetry.addCounter(ok ? 'deep_scan.completed' : 'deep_scan.failed', 1, { 'tenant.id': ctx.tenantId, status });
  telemetry.recordHistogram('deep_scan.duration_ms', now() - startedAt, { status });

  return { status, releasesFound: patch.releasesFound ?? 0, tracksFound: patch.tracksFound ?? 0 };
}
