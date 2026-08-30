import type { FastifyInstance } from 'fastify';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySearchStore, type CatalogResultLike, type SearchRecord } from '@sentinel/search-store';
import { buildApp } from './app';
import { createAppTestServices } from './app.test-support';
import { SEARCH_HISTORY_NEXT_CURSOR_HEADER } from './tenant-scoped-search-store';

const ISSUER = 'https://identity.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

let privateKey: KeyPair['privateKey'];
let publicKey: KeyPair['publicKey'];
let app: FastifyInstance;
const store = new InMemorySearchStore();

const result: CatalogResultLike = {
  artist: 'History fixture',
  stores: [],
  profiles: [],
  tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: '2026-07-22T00:00:00.000Z',
  warnings: [],
  note: '',
};

// The subject is the only scope key. A tenant claim, if present, is ignored.
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

async function addRows(
  template: SearchRecord,
  userId: string,
  prefix: string,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index++) {
    await store.put({
      ...template,
      id: `search_${prefix}_${String(index).padStart(3, '0')}`,
      userId,
      artist: `${prefix}-${index}`,
      createdAt: '2026-07-22T12:00:00.000Z',
    });
  }
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  const template = await store.save({ artist: 'Fixture', distributor: 'distrokid' }, result, [], { userId: 'fixture' });
  await store.delete(template.id, 'fixture');
  await addRows(template, 'alice', 'alice', 225);
  await addRows(template, 'bob', 'bob', 3);
  await addRows(template, 'carol', 'carol', 2);

  app = buildApp({
    ...createAppTestServices(),
    searchStore: store,
    authConfig: { enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: publicKey },
  });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
});

async function collectAll(headers: { authorization: string }, limit: number): Promise<Array<{ id: string; artist: string }>> {
  const rows: Array<{ id: string; artist: string }> = [];
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const response = await app.inject({ method: 'GET', url: `/api/searches?${query}`, headers });
    expect(response.statusCode).toBe(200);
    rows.push(...response.json().searches as Array<{ id: string; artist: string }>);
    cursor = response.headers[SEARCH_HISTORY_NEXT_CURSOR_HEADER] as string | undefined;
  } while (cursor);
  return rows;
}

describe('per-user search history pagination', () => {
  it('defaults to 50 and traverses all 225 equal-timestamp Alice rows exactly once', async () => {
    const headers = await bearer('alice');
    const first = await app.inject({ method: 'GET', url: '/api/searches', headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().searches).toHaveLength(50);
    expect(first.headers[SEARCH_HISTORY_NEXT_CURSOR_HEADER]).toEqual(expect.any(String));
    expect(first.json().searches[0].id).toBe('search_alice_224');

    const all = await collectAll(headers, 37);
    expect(all).toHaveLength(225);
    expect(new Set(all.map((row) => row.id)).size).toBe(225);
    expect(all[0]?.id).toBe('search_alice_224');
    expect(all.at(-1)?.id).toBe('search_alice_000');
    expect(all.every((row) => row.artist.startsWith('alice-'))).toBe(true);
  });

  it('keeps every other user out of Alice pages, including after page 200', async () => {
    const bob = await collectAll(await bearer('bob'), 2);
    const carol = await collectAll(await bearer('carol'), 1);
    expect(bob.map((row) => row.id)).toEqual(['search_bob_002', 'search_bob_001', 'search_bob_000']);
    expect(carol.map((row) => row.id)).toEqual(['search_carol_001', 'search_carol_000']);
  });

  it('rejects malformed, tampered, cross-principal cursors and invalid page sizes with 400', async () => {
    const aliceHeaders = await bearer('alice');
    const first = await app.inject({ method: 'GET', url: '/api/searches?limit=10', headers: aliceHeaders });
    const cursor = first.headers[SEARCH_HISTORY_NEXT_CURSOR_HEADER] as string;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    const bobHeaders = await bearer('bob');
    const urls = [
      '/api/searches?cursor=not-a-cursor',
      `/api/searches?cursor=${encodeURIComponent(tampered)}`,
      '/api/searches?limit=0',
      '/api/searches?limit=101',
      '/api/searches?limit=1.5',
      '/api/searches?limit=10&limit=20',
    ];
    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url, headers: aliceHeaders });
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toEqual({ error: 'invalid search history pagination' });
    }
    // A cursor minted for Alice must not be usable by Bob: the cursor scope is bound to the subject.
    const crossPrincipal = await app.inject({
      method: 'GET', url: `/api/searches?cursor=${encodeURIComponent(cursor)}`, headers: bobHeaders,
    });
    expect(crossPrincipal.statusCode).toBe(400);
  });
});
