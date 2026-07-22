import { describe, it, expect, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvelopeEncryptor } from '@sentinel/security';
import { TestBrowserLinkProvider } from './browser-link.test-support';

const fixturesBaseUrl = pathToFileURL(resolve(process.cwd(), 'fixtures/distrokid')).href;
const encryptor = new EnvelopeEncryptor(Buffer.alloc(32, 7).toString('base64'));
const provider = new TestBrowserLinkProvider({ fixturesBaseUrl, encryptor });

afterAll(async () => {
  await provider.dispose();
}, 30_000);

describe('TestBrowserLinkProvider', () => {
  it('creates a session with an ENCRYPTED provider ref (never plaintext to callers)', async () => {
    const res = await provider.createSession({
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      targetLoginUrl: 'https://distrokid.com/signin',
      ttlMinutes: 20,
    });
    expect(res.sessionId).toMatch(/^test_sess_/);
    expect(res.status).toBe('CREATED');
    expect(res.providerSessionRef).not.toContain('test-provider-session');
    expect(await encryptor.decrypt(res.providerSessionRef)).toContain('test-provider-session');
  });

  it('reports a safe logged-in hint and a user access URL, then serves fixtures', async () => {
    const { sessionId } = await provider.createSession({
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      targetLoginUrl: 'https://distrokid.com/signin',
      ttlMinutes: 20,
    });
    const status = await provider.getSessionStatus(sessionId);
    expect(status.loggedInHint).toBe(true);

    const access = await provider.createUserAccessUrl(sessionId, { ttlMinutes: 20 });
    // Same-origin HTTP path to the simulated sign-in page (renders in the iframe).
    expect(access.url).toBe(`https://viewer.test.invalid/session/${sessionId}`);

    const conn = await provider.attachAutomation(sessionId);
    const page = await conn.newPage();
    await page.goto(`${conn.baseUrl}/catalog-index.html`, { waitUntil: 'domcontentloaded' });
    expect(await page.getByRole('heading', { name: 'My Music' }).isVisible()).toBe(true);
    const releaseLinks = await page.locator('a.release-link').count();
    expect(releaseLinks).toBe(2);
    await page.close();
    await conn.close();
  }, 30_000);

  it('persists an encrypted, TTL-bounded state ref and terminates', async () => {
    const { sessionId } = await provider.createSession({
      tenantId: 't1',
      artistWorkspaceId: 'aw1',
      distributor: 'distrokid',
      targetLoginUrl: 'https://distrokid.com/signin',
      ttlMinutes: 20,
    });
    const ref = await provider.persistState(sessionId, { kind: 'PLAYWRIGHT_STORAGE_STATE', ttlHours: 24 });
    expect(ref.kind).toBe('PLAYWRIGHT_STORAGE_STATE');
    expect(ref.encryptedRef.startsWith('v1.')).toBe(true);
    expect(new Date(ref.expiresAt).getTime()).toBeGreaterThan(Date.now());
    await provider.terminateSession(sessionId);
    await expect(provider.getSessionStatus(sessionId)).rejects.toThrow();
  });
});
