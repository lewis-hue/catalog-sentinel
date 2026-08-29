import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, type Worker } from 'bullmq';
import { EnvelopeEncryptor, InMemoryAuditLogger } from '@sentinel/security';
import type { BrowserLinkProvider } from '@sentinel/browser-link';
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
import { BullMqDeepScanDispatcher } from './deep-scan-dispatch';
import { executeDeepScanRun } from './deep-scan-runner';
import { startDeepScanWorker, connectionFromUrl, type DeepScanJobPayload } from './bullmq';

/**
 * Redis integration test for the API↔worker deep-scan HANDOFF. GATED behind
 * REDIS_URL so the default unit run needs no Redis. To run it:
 *
 *   docker run -d -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 npx vitest run deep-scan-handoff.integration
 *
 * It proves the real production path: a QUEUED scan is enqueued to Redis (via
 * BullMqDeepScanDispatcher, NOT run in-process), a separate BullMQ worker consumes
 * the job and runs it via executeDeepScanRun against the SHARED repository, and the
 * finished results land back where the API would read them.
 *
 * The mock provider keeps session state in memory, so this test shares ONE provider
 * instance between the enqueue side and the worker's runner (in production a real
 * provider + Postgres make this genuinely cross-process).
 */
const REDIS_URL = process.env.REDIS_URL;
const T1: TenantContext = { tenantId: 'tenant-handoff-1' };

describe.skipIf(!REDIS_URL)('deep-scan API↔worker handoff over Redis', () => {
  let worker: Worker;
  let dispatcher: BullMqDeepScanDispatcher;
  let repo: InMemoryDistributorLinkRepository;
  let provider: BrowserLinkProvider;
  let cleanupQueue: Queue;

  beforeAll(async () => {
    cleanupQueue = new Queue('deep-scan', { connection: connectionFromUrl(REDIS_URL!) });
    await cleanupQueue.obliterate({ force: true }).catch(() => undefined);

    const audit = new InMemoryAuditLogger();
    repo = new InMemoryDistributorLinkRepository();
    const encryptor = new EnvelopeEncryptor(process.env.ENCRYPTION_MASTER_KEY);
    const fixturesBaseUrl = pathToFileURL(resolve(process.cwd(), 'fixtures/distrokid')).href;
    provider = new TestBrowserLinkProvider({ encryptor, fixturesBaseUrl });
    const scanner = new DistroKidDistributorAdapter();

    dispatcher = BullMqDeepScanDispatcher.fromRedisUrl(REDIS_URL!);

    // The worker: consumes from Redis and runs against the SAME repo + provider.
    worker = startDeepScanWorker(REDIS_URL!, {
      minDelayMs: 5,
      processDeepScan: async (payload: DeepScanJobPayload) => {
        const s = await executeDeepScanRun({ repo, provider, scanner, minDelayMs: 5, audit }, { tenantId: payload.tenantId }, payload.deepScanRunId);
        return { status: s.status, releases: s.releasesFound, tracks: s.tracksFound };
      },
    });
  }, 30000);

  afterAll(async () => {
    await worker?.close();
    await dispatcher?.close();
    await cleanupQueue?.obliterate({ force: true }).catch(() => undefined);
    await cleanupQueue?.close();
  });

  it('enqueues on the producer side and completes on the worker side, sharing state', async () => {
    // Seed the run context exactly as the API would after an attended login.
    const session = await provider.createSession({
      tenantId: T1.tenantId,
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      targetLoginUrl: 'https://distrokid.com/signin',
      ttlMinutes: 20,
    });
    const persisted = await provider.persistState!(session.sessionId, { kind: 'PLAYWRIGHT_STORAGE_STATE', ttlHours: 24 });

    const now = Date.now();
    const consent: LinkConsent = {
      id: 'consent-h1',
      tenantId: T1.tenantId,
      artistWorkspaceId: 'aw1',
      scope: 'distributor:read-catalog',
      provider: 'steel',
      expiresAt: new Date(now + 3_600_000).toISOString(),
      revokedAt: null,
    };
    const stateRef: LinkStateRef = {
      id: 'bstate-h1',
      tenantId: T1.tenantId,
      kind: persisted.kind,
      encryptedRef: persisted.encryptedRef,
      expiresAt: persisted.expiresAt,
      revokedAt: null,
    };
    const connection: LinkConnection = {
      id: 'dconn-h1',
      tenantId: T1.tenantId,
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      status: 'CONNECTED',
      connectionMode: 'CLOUD_BROWSER',
      browserStateRefId: stateRef.id,
      revokedAt: null,
    };
    const scan: LinkDeepScan = {
      id: 'dscan-h1',
      tenantId: T1.tenantId,
      artistWorkspaceId: 'aw1',
      distributorConnectionId: connection.id,
      consentId: consent.id,
      status: 'QUEUED',
      progressPercent: 0,
      currentStep: 'queued',
      releasesFound: 0,
      tracksFound: 0,
      warningsCount: 0,
      events: [],
      snapshotId: null,
      issues: [],
      snapshot: null,
    };
    await repo.consents.put(T1, consent);
    await repo.stateRefs.put(T1, stateRef);
    await repo.connections.put(T1, connection);
    await repo.scans.put(T1, scan);

    // Producer side: enqueue to Redis (does NOT run the scan here).
    await dispatcher.dispatch(T1, { id: scan.id, artistWorkspaceId: 'aw1', distributorConnectionId: connection.id });
    expect((await repo.scans.get(T1, scan.id))?.status).toBe('QUEUED');

    // Poll the shared repo until the worker finishes the job.
    const deadline = Date.now() + 20000;
    let final = await repo.scans.get(T1, scan.id);
    while (Date.now() < deadline) {
      final = await repo.scans.get(T1, scan.id);
      if (final && ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(final?.status);
    expect(final?.tracksFound).toBe(4);
  }, 30000);
});
