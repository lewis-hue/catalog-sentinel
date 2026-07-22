import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvelopeEncryptor } from '@sentinel/security';
import { TestBrowserLinkProvider } from '../../../packages/browser-link/src/browser-link.test-support';
import { DistroKidDistributorAdapter } from '@sentinel/scanner';
import { runDeepScanJob, type ConsentSnapshot } from './deep-scan-job';

const fixturesBaseUrl = pathToFileURL(resolve(process.cwd(), 'fixtures/distrokid')).href;
const encryptor = new EnvelopeEncryptor(Buffer.alloc(32, 4).toString('base64'));
const provider = new TestBrowserLinkProvider({ fixturesBaseUrl, encryptor });
const nowIso = () => '2026-07-07T00:00:00.000Z';
const nowMs = Date.parse('2026-07-07T00:00:00.000Z');

const validConsent: ConsentSnapshot = { scope: 'distributor:read', expiresAt: '2026-08-01T00:00:00.000Z', revokedAt: null };

afterAll(async () => {
  await provider.dispose();
}, 30_000);

async function stateRef() {
  const { sessionId } = await provider.createSession({
    tenantId: 't1',
    artistWorkspaceId: 'aw1',
    distributor: 'distrokid',
    targetLoginUrl: 'https://distrokid.com/signin',
    ttlMinutes: 20,
  });
  return provider.persistState(sessionId, { kind: 'PLAYWRIGHT_STORAGE_STATE', ttlHours: 24 });
}

const baseConfig = {
  tenantId: 't1',
  artistWorkspaceId: 'aw1',
  distributor: 'distrokid' as const,
  snapshotId: 'snap1',
  minDelayMs: 0,
  nowIso,
};

describe('runDeepScanJob (worker)', () => {
  it('resumes browser state, scans the fixture catalog, and stores a snapshot + issues', async () => {
    const res = await runDeepScanJob({
      provider,
      scanner: new DistroKidDistributorAdapter(nowIso),
      consent: validConsent,
      stateRef: await stateRef(),
      config: baseConfig,
      nowMs,
    });
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(res.status);
    expect(res.result?.tracks).toHaveLength(4);
    expect(res.result?.releases).toHaveLength(2);
    expect(res.result?.issues.some((i) => i.code === 'NOT_SELECTED_FOR_AUDIOMACK')).toBe(true);
  });

  it('BLOCKS the scan when consent is revoked', async () => {
    const res = await runDeepScanJob({
      provider,
      scanner: new DistroKidDistributorAdapter(nowIso),
      consent: { ...validConsent, revokedAt: '2026-07-06T00:00:00.000Z' },
      stateRef: await stateRef(),
      config: baseConfig,
      nowMs,
    });
    expect(res.status).toBe('BLOCKED_CONSENT');
    expect(res.result).toBeNull();
  });

  it('BLOCKS the scan when the browser state is expired', async () => {
    const expired = { ...(await stateRef()), expiresAt: '2026-07-06T00:00:00.000Z' };
    const res = await runDeepScanJob({
      provider,
      scanner: new DistroKidDistributorAdapter(nowIso),
      consent: validConsent,
      stateRef: expired,
      config: baseConfig,
      nowMs,
    });
    expect(res.status).toBe('BLOCKED_STATE_EXPIRED');
  });
});
