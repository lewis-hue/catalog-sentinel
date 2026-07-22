import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { InMemoryDistributorLinkRepository, type LinkConsent } from '@sentinel/db';
import { InMemoryAuditLogger } from '@sentinel/security';
import { buildApp } from './app';
import { DistributorConnect, InMemoryConnectSessionRegistry } from './distributor-connect';
import { DistributorLinkService } from './distributor-link';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
const TENANT = 'tenant-a';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];
let app: FastifyInstance;
let repo: InMemoryDistributorLinkRepository;
let service: DistributorLinkService;
let audit: InMemoryAuditLogger;
let cancelByConsent: ReturnType<typeof vi.spyOn>;

async function bearer(sub: string, roles: string[]): Promise<{ authorization: string }> {
  const jwt = await new SignJWT({ tenant_id: TENANT, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { authorization: `Bearer ${jwt}` };
}

function aliceConsent(id = 'alice-consent'): LinkConsent {
  return {
    id,
    tenantId: TENANT,
    artistWorkspaceId: 'workspace-alice',
    grantedByUserId: 'alice',
    grantedAt: new Date().toISOString(),
    distributor: 'distrokid',
    scope: 'distributor:read-catalog',
    provider: 'steel',
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    revokedAt: null,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  repo = new InMemoryDistributorLinkRepository();
  audit = new InMemoryAuditLogger();
  service = new DistributorLinkService(audit, {
    repo,
    env: { NODE_ENV: 'test', BROWSER_LINK_PROVIDER: 'steel' },
  });
  await repo.consents.put({ tenantId: TENANT }, aliceConsent());
  cancelByConsent = vi.spyOn(DistributorConnect.prototype, 'cancelByConsent').mockResolvedValue(1);
  app = buildApp({
    distributorLink: service,
    auditLogger: audit,
    connectSessionRegistry: new InMemoryConnectSessionRegistry(),
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
  cancelByConsent.mockRestore();
}, 30_000);

describe('same-tenant consent subject isolation', () => {
  it('binds every consent assertion to the exact granting subject', async () => {
    await expect(service.assertReadConsent(
      { tenantId: TENANT },
      'alice-consent',
      { distributor: 'distrokid', provider: 'steel', actorUserId: 'bob' },
    )).rejects.toThrow(/not bound/i);
    await expect(service.assertReadConsent(
      { tenantId: TENANT },
      'alice-consent',
      { distributor: 'distrokid', provider: 'steel', actorUserId: 'alice' },
    )).resolves.toMatchObject({ grantedByUserId: 'alice', artistWorkspaceId: 'workspace-alice' });
  });

  it('starts Steel with the validated consent workspace and server principal, never an artist-derived id', async () => {
    const assertConsent = vi.spyOn(service, 'assertReadConsent').mockResolvedValue({
      ...aliceConsent(), provider: 'steel',
    });
    const start = vi.spyOn(DistributorConnect.prototype, 'start').mockResolvedValue({
      connectId: 'connect-owned',
      loginUrl: 'https://viewer.example/session',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      embedded: true,
      provider: 'steel',
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/connect',
        headers: await bearer('alice', ['artist_manager']),
        payload: { distributor: 'distrokid', artists: ['Artist Name Is Not Authority'], consentId: 'alice-consent' },
      });
      expect(response.statusCode).toBe(200);
      expect(assertConsent).toHaveBeenCalledWith(
        { tenantId: TENANT },
        'alice-consent',
        expect.objectContaining({ actorUserId: 'alice', provider: 'steel' }),
      );
      expect(start).toHaveBeenCalledWith('distrokid', ['Artist Name Is Not Authority'], {
        tenantId: TENANT,
        ownerUserId: 'alice',
        consentId: 'alice-consent',
        artistWorkspaceId: 'workspace-alice',
      });
    } finally {
      start.mockRestore();
      assertConsent.mockRestore();
    }
  });

  it('returns the same 404 for Bob and a missing grant without terminating Alice\'s session', async () => {
    const bob = await bearer('bob', ['artist_manager']);
    const denied = await app.inject({ method: 'POST', url: '/api/consent/alice-consent/revoke', headers: bob });
    const missing = await app.inject({ method: 'POST', url: '/api/consent/missing-consent/revoke', headers: bob });

    expect(denied.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(denied.json()).toEqual(missing.json());
    expect(cancelByConsent).not.toHaveBeenCalled();
    expect((await repo.consents.get({ tenantId: TENANT }, 'alice-consent'))?.revokedAt).toBeNull();
  });

  it('allows an exact tenant admin safety revocation and audits the real actor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/consent/alice-consent/revoke',
      headers: await bearer('tenant-admin', ['tenant_admin']),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revoked: true, cleanupPending: false, sessionsTerminated: 1 });
    expect(cancelByConsent).toHaveBeenCalledWith('alice-consent', TENANT);
    expect((await repo.consents.get({ tenantId: TENANT }, 'alice-consent'))?.revokedAt).toBeTruthy();
    expect(await audit.list()).toContainEqual(expect.objectContaining({
      actorUserId: 'tenant-admin', action: 'consent.revoked', targetId: 'alice-consent',
    }));
  });
});
