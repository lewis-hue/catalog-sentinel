import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySearchStore } from '@sentinel/search-store';
import { InMemoryMembershipStore } from '@sentinel/db';
import { buildApp } from './app';
import { createAppTestServices } from './app.test-support';
import type { CatalogScanResult } from './catalog-scan';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let privateKey: KeyPair['privateKey'];
let app: FastifyInstance;

function scan(artist = 'A'): CatalogScanResult {
  return {
    artist, stores: [], profiles: [], tracks: [],
    summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
    generatedAt: '2026-08-29T00:00:00.000Z', warnings: [], note: 'x',
  };
}

/** A bearer for a subject; include an email to assert a verified address (needed to accept invites). */
async function bearer(sub: string, opts: { email?: string } = {}): Promise<{ authorization: string }> {
  const claims: Record<string, unknown> = { realm_access: { roles: ['user'] } };
  if (opts.email) {
    claims.email = opts.email;
    claims.email_verified = true;
  }
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { authorization: `Bearer ${token}` };
}

const inTenant = (headers: { authorization: string }, tenantId: string) => ({ ...headers, 'x-sentinel-tenant': tenantId });

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  app = buildApp({
    ...createAppTestServices(),
    searchStore: new InMemorySearchStore(),
    membershipStore: new InMemoryMembershipStore(),
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pair.publicKey },
    runFastCatalogScan: vi.fn(async (a: string) => scan(a)) as never,
    runReleasedCatalogScan: vi.fn(async (a: string) => scan(a)) as never,
    enqueueDeepScan: vi.fn(async () => {}),
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe('tenant + membership routes', () => {
  it('owner creates a shared tenant, invites, member accepts and can act, non-members are blocked', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/tenants', headers: await bearer('alice') });
    expect(create.statusCode).toBe(201);
    const orgId: string = create.json().tenantId;
    expect(orgId).toMatch(/^org_/);

    const inv = await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/invites`,
      headers: inTenant(await bearer('alice'), orgId),
      payload: { email: 'bob@example.com', role: 'admin' },
    });
    expect(inv.statusCode).toBe(201);

    // A non-member cannot act in the org: resolution fails closed with 403.
    const carol = await app.inject({
      method: 'GET',
      url: `/api/tenants/${orgId}/members`,
      headers: inTenant(await bearer('carol'), orgId),
    });
    expect(carol.statusCode).toBe(403);

    // Bob accepts with his verified email (no tenant header, since he is not a member yet).
    const accept = await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/accept`,
      headers: await bearer('bob', { email: 'bob@example.com' }),
    });
    expect(accept.statusCode).toBe(200);

    // Now bob can act in the org and see the roster (alice + bob).
    const roster = await app.inject({
      method: 'GET',
      url: `/api/tenants/${orgId}/members`,
      headers: inTenant(await bearer('bob'), orgId),
    });
    expect(roster.statusCode).toBe(200);
    const memberIds = (roster.json().members as Array<{ userId: string | null }>)
      .map((m) => m.userId)
      .filter((u): u is string => Boolean(u))
      .sort();
    expect(memberIds).toEqual(['alice', 'bob']);

    // The shared tenant appears in bob's tenant list.
    const tenants = await app.inject({ method: 'GET', url: '/api/tenants', headers: await bearer('bob') });
    expect((tenants.json().tenants as Array<{ tenantId: string }>).map((t) => t.tenantId)).toContain(orgId);
  });

  it('enforces tenant RBAC and last-owner protection over HTTP', async () => {
    const orgId: string = (await app.inject({ method: 'POST', url: '/api/tenants', headers: await bearer('owner') })).json().tenantId;

    await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/invites`,
      headers: inTenant(await bearer('owner'), orgId),
      payload: { email: 'vic@example.com', role: 'viewer' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/accept`,
      headers: await bearer('vic', { email: 'vic@example.com' }),
    });

    // A viewer cannot invite.
    const viewerInvite = await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/invites`,
      headers: inTenant(await bearer('vic'), orgId),
      payload: { email: 'x@example.com', role: 'viewer' },
    });
    expect(viewerInvite.statusCode).toBe(403);

    // The last owner cannot be removed.
    const removeOwner = await app.inject({
      method: 'DELETE',
      url: `/api/tenants/${orgId}/members/owner`,
      headers: inTenant(await bearer('owner'), orgId),
    });
    expect(removeOwner.statusCode).toBe(409);

    // Accepting with a non-matching email finds no invite.
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/tenants/${orgId}/accept`,
      headers: await bearer('nobody', { email: 'nobody@example.com' }),
    });
    expect(wrong.statusCode).toBe(404);
  });

  it('bootstraps the personal tenant on first listing and marks it personal', async () => {
    // Listing tenants without a header must not error; it idempotently materializes the caller's
    // personal tenant (tenantId === sub, role owner) so per-user data shows as a tenant of one.
    const res = await app.inject({ method: 'GET', url: '/api/tenants', headers: await bearer('solo') });
    expect(res.statusCode).toBe(200);
    const tenants = res.json().tenants as Array<{ tenantId: string; role: string; personal: boolean }>;
    const personal = tenants.find((t) => t.tenantId === 'solo');
    expect(personal).toMatchObject({ role: 'owner', personal: true });

    // Bootstrap is idempotent: a second landing does not duplicate the personal membership.
    const again = await app.inject({ method: 'GET', url: '/api/tenants', headers: await bearer('solo') });
    expect((again.json().tenants as unknown[]).filter((t) => (t as { tenantId: string }).tenantId === 'solo')).toHaveLength(1);
  });
});
