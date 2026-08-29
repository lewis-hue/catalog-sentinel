import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { registerAuth, requireAuth, requireRole } from './auth';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

async function token(claims: Record<string, unknown>, audience = AUDIENCE): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function app() {
  const server = Fastify();
  registerAuth(server, { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey });
  server.get('/private', async (request) => ({
    subject: request.auth.sub,
    tenantHeader: request.headers['x-tenant-id'] ?? null,
  }));
  server.get('/interactive', { preHandler: requireAuth() }, async () => ({ ok: true }));
  server.get('/manage', { preHandler: requireRole('platform_admin') }, async () => ({ ok: true }));
  server.get('/health/live', async () => ({ status: 'live' }));
  server.get('/docs', async () => ({ docs: true }));
  server.options('/private', async (_request, reply) => reply.status(204).send());
  await server.ready();
  return server;
}

describe('API authentication hook', () => {
  it('ignores a caller-supplied tenant header and scopes the identity to the verified subject', async () => {
    const server = await app();
    const response = await server.inject({
      method: 'GET',
      url: '/private',
      headers: {
        authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['user'] } })}`,
        'x-tenant-id': 'tenant-b',
      },
    });
    expect(response.statusCode).toBe(200);
    // The subject is the only scope; a signed tenant claim and a caller header are both ignored.
    expect(response.json()).toEqual({ subject: 'user-1', tenantHeader: 'tenant-b' });
    await server.close();
  });

  it('uses the verified subject for a personal account without a tenant claim and rejects a wrong audience', async () => {
    const server = await app();
    const missingTenant = await server.inject({
      method: 'GET', url: '/private', headers: { authorization: `Bearer ${await token({ realm_access: { roles: ['user'] } })}` },
    });
    const wrongAudience = await server.inject({
      method: 'GET', url: '/private', headers: { authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['user'] } }, 'other-api')}` },
    });
    expect(missingTenant.statusCode).toBe(200);
    expect(wrongAudience.statusCode).toBe(401);
    expect(missingTenant.json()).toEqual({ subject: 'user-1', tenantHeader: null });
    expect(wrongAudience.json()).toEqual({ error: 'invalid token' });
    await server.close();
  });

  it('rejects arbitrary roles and keeps service credentials off interactive routes', async () => {
    const server = await app();
    const arbitrary = await server.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['realm-admin'] } })}` },
    });
    const service = await server.inject({
      method: 'GET',
      url: '/interactive',
      headers: { authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['service_worker'] } })}` },
    });
    expect(arbitrary.statusCode).toBe(401);
    expect(arbitrary.json()).toEqual({ error: 'invalid token' });
    expect(service.statusCode).toBe(403);
    expect(service.json()).toEqual({ error: 'interactive user role required' });
    await server.close();
  });

  it('enforces route-specific operator roles', async () => {
    const server = await app();
    const reader = await server.inject({
      method: 'GET',
      url: '/manage',
      headers: { authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['user'] } })}` },
    });
    const operator = await server.inject({
      method: 'GET',
      url: '/manage',
      headers: { authorization: `Bearer ${await token({ tenant_id: 'tenant-a', realm_access: { roles: ['platform_admin'] } })}` },
    });
    expect(reader.statusCode).toBe(403);
    expect(operator.statusCode).toBe(200);
    await server.close();
  });

  it('keeps only liveness/readiness probes public', async () => {
    const server = await app();
    const health = await server.inject({ method: 'GET', url: '/health/live' });
    const docs = await server.inject({ method: 'GET', url: '/docs' });
    const privateRoute = await server.inject({ method: 'GET', url: '/private' });
    expect(health.statusCode).toBe(200);
    expect(docs.statusCode).toBe(401);
    expect(privateRoute.statusCode).toBe(401);
    await server.close();
  });

  it('allows an unauthenticated browser preflight to reach the strict OPTIONS policy', async () => {
    const server = await app();
    const response = await server.inject({ method: 'OPTIONS', url: '/private' });
    expect(response.statusCode).toBe(204);
    await server.close();
  });
});
