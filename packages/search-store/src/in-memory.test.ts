import { describe, it, expect } from 'vitest';
import { InMemorySearchStore, type CatalogResultLike, type SearchRecord } from './search-store';

const result = (artist = 'Lewis KE'): CatalogResultLike => ({
  artist,
  stores: [],
  profiles: [],
  tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: new Date().toISOString(),
  warnings: [],
  note: '',
});

const input = (artist: string) => ({ artist, distributor: 'distrokid' });

/** Full record for direct `put`, so ordering tests control `createdAt` instead of racing the clock. */
const record = (overrides: Partial<SearchRecord> & Pick<SearchRecord, 'id' | 'userId' | 'createdAt'>): SearchRecord => ({
  revision: 1,
  artist: 'Lewis KE',
  distributor: 'distrokid',
  platforms: [],
  song: null,
  result: result(),
  ...overrides,
});

describe('InMemorySearchStore', () => {
  it('save() stamps the record with the owner passed to it, and defaults to an empty userId when none is given', async () => {
    const store = new InMemorySearchStore();
    const owned = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    expect(owned.userId).toBe('alice');

    const unowned = await store.save(input('No Owner'), result('No Owner'));
    expect(unowned.userId).toBe('');
  });

  it('get() is unscoped: it finds a record by id regardless of owner, for the worker path', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    expect((await store.get(saved.id))?.userId).toBe('alice');
    expect(await store.get('search_does_not_exist')).toBeNull();
  });

  it('listForUser()/pageForUser() return only that user\'s records, newest first', async () => {
    const store = new InMemorySearchStore();
    await store.put(record({ id: 'search_alice_older', userId: 'alice', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.put(record({ id: 'search_alice_newer', userId: 'alice', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.put(record({ id: 'search_bob_only', userId: 'bob', createdAt: '2026-01-03T00:00:00.000Z' }));

    const aliceList = await store.listForUser('alice');
    expect(aliceList.map((r) => r.id)).toEqual(['search_alice_newer', 'search_alice_older']);
    expect(aliceList.every((r) => r.userId === 'alice')).toBe(true);

    const bobList = await store.listForUser('bob');
    expect(bobList.map((r) => r.id)).toEqual(['search_bob_only']);

    const strangerList = await store.listForUser('carol');
    expect(strangerList).toHaveLength(0);

    const page = await store.pageForUser('alice', { limit: 1 });
    expect(page.items.map((r) => r.id)).toEqual(['search_alice_newer']);
    expect(page.nextCursor).toBeDefined();
    const nextPage = await store.pageForUser('alice', { limit: 1, after: page.nextCursor! });
    expect(nextPage.items.map((r) => r.id)).toEqual(['search_alice_older']);
    expect(nextPage.nextCursor).toBeUndefined();
  });

  it('update() preserves id/userId/createdAt even if the mutator tries to overwrite them', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    const mutated = await store.update(saved.id, (r) => ({
      ...r,
      id: 'search_forged',
      userId: 'bob',
      createdAt: '1999-01-01T00:00:00.000Z',
      name: 'renamed',
    }));
    expect(mutated).toMatchObject({ id: saved.id, userId: 'alice', createdAt: saved.createdAt, name: 'renamed' });
    expect(mutated?.revision).toBe((saved.revision ?? 0) + 1);
    expect(await store.update('search_does_not_exist', (r) => r)).toBeNull();
  });

  it('delete() only removes a record when the given userId matches, and removes it outright with no userId given', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    expect(await store.delete(saved.id, 'bob')).toBe(false);
    expect(await store.get(saved.id)).not.toBeNull();
    expect(await store.delete(saved.id, 'alice')).toBe(true);
    expect(await store.get(saved.id)).toBeNull();

    const another = await store.save(input('Bob KE'), result('Bob KE'), [], { userId: 'bob' });
    expect(await store.delete(another.id)).toBe(true);
    expect(await store.get(another.id)).toBeNull();
  });

  it('put() rejects overwriting an existing id with a record owned by a different user', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    await expect(store.put({ ...saved, userId: 'bob', revision: (saved.revision ?? 0) + 1 }))
      .rejects.toThrow('search record id is already owned by another user');
  });

  it('list() is unscoped and reflects every owner (used only by the worker/admin path, never a request)', async () => {
    const store = new InMemorySearchStore();
    await store.save(input('Alice KE'), result('Alice KE'), [], { userId: 'alice' });
    await store.save(input('Bob KE'), result('Bob KE'), [], { userId: 'bob' });
    const all = await store.list();
    expect(all.map((r) => r.userId).sort()).toEqual(['alice', 'bob']);
  });
});
