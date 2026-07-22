import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect } from 'vitest';
import { RecordingTelemetry } from '@sentinel/core';
import { EnvelopeEncryptor } from '@sentinel/security';
import { TestBrowserLinkProvider } from '../../../packages/browser-link/src/browser-link.test-support';
import { DistroKidDistributorAdapter } from '@sentinel/scanner';
import {
  InMemoryDistributorLinkRepository,
  type LinkConnection,
  type LinkConsent,
  type LinkDeepScan,
  type LinkStateRef,
  type TenantContext,
} from '@sentinel/db';
import { executeDeepScanRun } from './deep-scan-runner';

const T: TenantContext = { tenantId: 'tenant-otel-1' };

describe('executeDeepScanRun — telemetry instrumentation', () => {
  it('emits started/completed counters, a duration histogram, and an ok span', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    const encryptor = new EnvelopeEncryptor();
    const fixturesBaseUrl = pathToFileURL(resolve(process.cwd(), 'fixtures/distrokid')).href;
    const provider = new TestBrowserLinkProvider({ encryptor, fixturesBaseUrl });
    const scanner = new DistroKidDistributorAdapter();

    // Seed the run context the way confirmLogin would.
    const session = await provider.createSession({ tenantId: T.tenantId, artistWorkspaceId: 'aw1', distributor: 'distrokid', targetLoginUrl: 'https://distrokid.com/signin', ttlMinutes: 20 });
    const persisted = await provider.persistState!(session.sessionId, { kind: 'PLAYWRIGHT_STORAGE_STATE', ttlHours: 24 });
    const consent: LinkConsent = { id: 'c1', tenantId: T.tenantId, artistWorkspaceId: 'aw1', scope: 'distributor:read-catalog', provider: 'steel', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null };
    const stateRef: LinkStateRef = { id: 'sr1', tenantId: T.tenantId, kind: persisted.kind, encryptedRef: persisted.encryptedRef, expiresAt: persisted.expiresAt, revokedAt: null };
    const conn: LinkConnection = { id: 'conn1', tenantId: T.tenantId, artistWorkspaceId: 'aw1', distributor: 'distrokid', status: 'CONNECTED', connectionMode: 'CLOUD_BROWSER', browserStateRefId: stateRef.id, revokedAt: null };
    const scan: LinkDeepScan = { id: 'scan1', tenantId: T.tenantId, artistWorkspaceId: 'aw1', distributorConnectionId: conn.id, consentId: consent.id, status: 'QUEUED', progressPercent: 0, currentStep: 'queued', releasesFound: 0, tracksFound: 0, warningsCount: 0, events: [], snapshotId: null, issues: [], snapshot: null };
    await repo.consents.put(T, consent);
    await repo.stateRefs.put(T, stateRef);
    await repo.connections.put(T, conn);
    await repo.scans.put(T, scan);

    let clock = 1000;
    const telemetry = new RecordingTelemetry();
    const summary = await executeDeepScanRun(
      { repo, provider, scanner, minDelayMs: 5, telemetry, nowMs: () => (clock += 250) },
      T,
      scan.id,
    );

    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(summary.status);

    const span = telemetry.spans.find((s) => s.name === 'deep_scan.run');
    expect(span).toBeTruthy();
    expect(span!.status).toBe('ok');
    expect(span!.attrs['tenant.id']).toBe(T.tenantId);
    expect(span!.attrs.distributor).toBe('distrokid');

    expect(telemetry.counters.some((c) => c.name === 'deep_scan.started')).toBe(true);
    expect(telemetry.counters.some((c) => c.name === 'deep_scan.completed')).toBe(true);
    expect(telemetry.counters.some((c) => c.name === 'deep_scan.failed')).toBe(false);

    const dur = telemetry.histograms.find((h) => h.name === 'deep_scan.duration_ms');
    expect(dur).toBeTruthy();
    expect(dur!.value).toBeGreaterThan(0);
  }, 25000);
});
