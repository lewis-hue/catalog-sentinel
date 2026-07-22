import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySearchStore } from '@sentinel/search-store';
import { buildApp } from './app';
import { createAppTestServices } from './app.test-support';
import type { CatalogScanResult } from './catalog-scan';
import { personalArtistWorkspaceId } from './tenant-scoped-search-store';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];
let app: FastifyInstance;
const store = new InMemorySearchStore();

const result = (artist: string): CatalogScanResult => ({
  artist,
  stores: ['Deezer'],
  profiles: [],
  tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: '2026-07-22T00:00:00.000Z',
  warnings: [],
  note: '',
});

async function bearer(sub: string, roles: string[], tenantId = 'tenant-a'): Promise<{ authorization: string }> {
  const jwt = await new SignJWT({ tenant_id: tenantId, realm_access: { roles } })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { authorization: `Bearer ${jwt}` };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  await store.save({
    tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'aw-alice-consent',
    artist: 'Alice Secret', distributor: 'distrokid',
  }, result('Alice Secret'), []);
  await store.save({
    tenantId: 'tenant-a', ownerUserId: 'bob', artistWorkspaceId: 'aw-bob-consent',
    artist: 'Bob Secret', distributor: 'distrokid',
  }, result('Bob Secret'), []);
  await store.save({ tenantId: 'tenant-a', artist: 'Legacy Ownerless', distributor: 'distrokid' }, result('Legacy Ownerless'));

  app = buildApp({
    ...createAppTestServices(),
    searchStore: store,
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
    runFastCatalogScan: vi.fn(async (artist: string) => result(artist)),
    runReleasedCatalogScan: vi.fn(async (artist: string) => result(artist)),
    enqueueDeepScan: vi.fn(async () => {}),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('authenticated scan/history principal isolation', () => {
  it('hides the shared legacy demo/workspace/catalog surface in every authenticated deployment', async () => {
    const headers = await bearer('alice', ['artist_manager']);
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/demo/seed', headers }),
      app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { name: 'Cross-user state' } }),
      app.inject({ method: 'GET', url: '/api/workspaces/ws_lewis_ke_demo', headers }),
      app.inject({ method: 'DELETE', url: '/api/workspaces/ws_lewis_ke_demo', headers }),
      app.inject({ method: 'GET', url: '/api/catalog/releases?workspaceId=ws_lewis_ke_demo', headers }),
      app.inject({ method: 'GET', url: '/api/issues?workspaceId=ws_lewis_ke_demo', headers }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
  });

  it('returns only the caller-owned rows for Alice and Bob within the same tenant', async () => {
    const alice = await app.inject({ method: 'GET', url: '/api/searches', headers: await bearer('alice', ['artist_manager']) });
    const bob = await app.inject({ method: 'GET', url: '/api/searches', headers: await bearer('bob', ['artist_manager']) });

    expect(alice.statusCode).toBe(200);
    expect((alice.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(['Alice Secret']);
    expect((bob.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(['Bob Secret']);
  });

  it('uses indistinguishable 404s for another same-tenant user across read/manage/review routes', async () => {
    const aliceRow = (await store.listForOwner('tenant-a', 'alice'))[0]!;
    const headers = await bearer('bob', ['artist_manager']);
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/api/searches/${aliceRow.id}`, headers }),
      app.inject({ method: 'PATCH', url: `/api/searches/${aliceRow.id}`, headers, payload: { name: 'stolen' } }),
      app.inject({ method: 'DELETE', url: `/api/searches/${aliceRow.id}`, headers }),
      app.inject({ method: 'GET', url: `/api/searches/${aliceRow.id}/manual-review`, headers }),
      app.inject({
        method: 'PATCH',
        url: `/api/searches/${aliceRow.id}/manual-review/not-a-real-item`,
        headers,
        payload: { decision: 'DISMISSED' },
      }),
      app.inject({ method: 'POST', url: `/api/searches/${aliceRow.id}/rescan`, headers, payload: {} }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([404, 404, 404, 404, 404, 404]);
    expect((await store.get(aliceRow.id))?.artist).toBe('Alice Secret');
  });

  it('stamps new writes from the verified subject and ignores a forged workspace body field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/searches',
      headers: await bearer('alice', ['artist_manager']),
      payload: { artist: 'New Alice Artist', distributor: 'distrokid', artistWorkspaceId: 'aw-forged' },
    });
    expect(response.statusCode).toBe(201);
    const saved = await store.get(response.json().id as string);
    expect(saved).toMatchObject({
      ownerUserId: 'alice',
      artistWorkspaceId: personalArtistWorkspaceId('tenant-a', 'alice'),
    });
    expect(saved?.artistWorkspaceId).not.toBe('aw-forged');
  });

  it('stamps saved CSV imports with the verified subject and server-selected workspace', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/distributor-imports/csv',
      headers: await bearer('bob', ['artist_manager']),
      payload: {
        distributor: 'distrokid',
        artistName: 'Bob Import',
        save: true,
        csvText: 'Release Title,Track Title,Artist,ISRC\nRelease,Song,Bob Import,USRC17607839\n',
        artistWorkspaceId: 'aw-forged',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await store.get(response.json().searchId as string)).toMatchObject({
      ownerUserId: 'bob',
      artistWorkspaceId: personalArtistWorkspaceId('tenant-a', 'bob'),
    });
  });

  it('allows a tenant admin to manage its tenant and preserves the source scope on admin rescan', async () => {
    const bobSource = (await store.listForOwner('tenant-a', 'bob')).find((row) => row.artist === 'Bob Secret')!;
    const headers = await bearer('tenant-admin', ['tenant_admin']);
    const list = await app.inject({ method: 'GET', url: '/api/searches', headers });
    expect(list.statusCode).toBe(200);
    expect((list.json().searches as Array<{ artist: string }>).map((row) => row.artist)).toEqual(
      expect.arrayContaining(['Alice Secret', 'Bob Secret', 'Legacy Ownerless']),
    );

    const rescan = await app.inject({ method: 'POST', url: `/api/searches/${bobSource.id}/rescan`, headers, payload: {} });
    expect(rescan.statusCode).toBe(201);
    expect(await store.get(rescan.json().id as string)).toMatchObject({
      ownerUserId: 'bob', artistWorkspaceId: 'aw-bob-consent', sourceSearchId: bobSource.id,
    });
  });

  it('does not grant a platform-admin-only token implicit customer catalogue access', async () => {
    const headers = await bearer('platform-operator', ['platform_admin']);
    const list = await app.inject({ method: 'GET', url: '/api/searches', headers });
    const create = await app.inject({ method: 'POST', url: '/api/searches', headers, payload: { artist: 'Customer Data' } });
    const csv = await app.inject({
      method: 'POST', url: '/api/distributor-imports/csv', headers,
      payload: { csvText: 'Release Title,Track Title,Artist\nR,T,A\n' },
    });
    expect(list.statusCode).toBe(403);
    expect(create.statusCode).toBe(403);
    expect(csv.statusCode).toBe(403);
    expect(list.json()).toEqual({ error: 'customer scan access requires a customer role' });
  });
});
