import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySearchStore } from '@sentinel/search-store';
import { buildApp } from './app';
import { createAppTestServices } from './app.test-support';
import type { CatalogScanResult } from './catalog-scan';

/**
 * Per-user isolation of the whole search surface, exercised through the real Fastify app with two
 * distinct authenticated subjects. The security guarantee is that a user reaches ONLY records where
 * `record.userId === req.auth.sub`; a foreign or missing record must be 404/422/409 (never 200 with
 * another user's data, never 500), and another user's history must never appear in a list.
 */

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];
let app: FastifyInstance;
let store: InMemorySearchStore;

function result(artist = 'Alice Artist'): CatalogScanResult {
  return {
    artist,
    stores: ['Deezer'],
    profiles: [],
    tracks: [{
      title: 'Track One', primaryArtist: artist, album: 'Release One', isrc: 'QZABC1234567',
      artworkUrl: null, perStore: [{
        store: 'Deezer', status: 'live', foundArtist: artist, url: null,
        confidence: 1, needsManualReview: false, reviewQuery: null,
      }],
    }],
    summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 0 },
    generatedAt: '2026-08-29T00:00:00.000Z',
    warnings: [],
    note: 'fast baseline',
  };
}

// A bearer for a given subject. The subject is the ONLY scope key the API honors.
async function bearer(sub: string): Promise<{ authorization: string }> {
  const token = await new SignJWT({ realm_access: { roles: ['user'] } })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { authorization: `Bearer ${token}` };
}

async function createSearchAs(sub: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/searches',
    headers: await bearer(sub),
    payload: { artist: 'Alice Artist', distributor: 'distrokid' },
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().id as string };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  store = new InMemorySearchStore();
  app = buildApp({
    ...createAppTestServices(),
    searchStore: store,
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
    runFastCatalogScan: vi.fn(async (artist: string) => result(artist)) as never,
    runReleasedCatalogScan: vi.fn(async (artist: string) => result(artist)) as never,
    enqueueDeepScan: vi.fn(async () => {}),
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe('per-user search isolation', () => {
  it('stamps the creating subject as the owner and shows it only to that subject', async () => {
    const { id } = await createSearchAs('alice');
    expect((await store.get(id))?.userId).toBe('alice');

    const aliceRead = await app.inject({ method: 'GET', url: `/api/searches/${id}`, headers: await bearer('alice') });
    expect(aliceRead.statusCode).toBe(200);
    expect(aliceRead.json().id).toBe(id);

    const aliceList = await app.inject({ method: 'GET', url: '/api/searches', headers: await bearer('alice') });
    expect(aliceList.json().searches.map((s: { id: string }) => s.id)).toContain(id);
  });

  it('Bob cannot read, list, update, delete, rescan, store-check, or lyric-check Alice\'s search', async () => {
    const aliceId = (await createSearchAs('alice')).id;
    const bob = await bearer('bob');
    const cases: Array<readonly ['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['GET', `/api/searches/${aliceId}`],
      ['GET', `/api/searches/${aliceId}/catalogue`],
      ['GET', `/api/searches/${aliceId}/manual-review`],
      ['PATCH', `/api/searches/${aliceId}`],
      ['DELETE', `/api/searches/${aliceId}`],
      ['POST', `/api/searches/${aliceId}/rescan`],
      ['POST', `/api/searches/${aliceId}/store-check`],
      ['POST', `/api/searches/${aliceId}/lyrics-check`],
      ['POST', `/api/searches/${aliceId}/track-marks`],
    ];
    for (const [method, url] of cases) {
      const res = await app.inject({ method, url, headers: bob, payload: { name: 'stolen', marks: [] } });
      // Never 200 with Alice's data, never 500. Ownership fails closed to 404 (or a validation/conflict).
      expect([404, 409, 422], `${method} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
    }

    // And Bob's history never contains Alice's record.
    const list = await app.inject({ method: 'GET', url: '/api/searches', headers: bob });
    expect(list.statusCode).toBe(200);
    expect(list.json().searches ?? []).toHaveLength(0);

    // Alice's record is untouched by every one of Bob's attempts.
    expect((await store.get(aliceId))?.userId).toBe('alice');
  });

  it('a rejected empty subject can never be treated as an owner', async () => {
    // Alice owns a record; a token with an empty subject is refused at verification, so no request
    // can present an empty `sub` and be scoped to ownerless rows.
    const emptySub = new SignJWT({ realm_access: { roles: ['user'] } })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('')
      .setIssuedAt()
      .setExpirationTime('5m');
    const token = await emptySub.sign(privateKey);
    const res = await app.inject({
      method: 'GET', url: '/api/searches', headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
