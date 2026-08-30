import { describe, it, expect } from 'vitest';
import { PostgresSearchStore, type PgPoolLike } from './postgres-search-store';
import { TieredSearchStore } from './tiered-search-store';
import {
  InMemorySearchStore,
  RedisSearchStore,
  revisionOf,
  type CatalogResultLike,
  type RedisLike,
  type SearchRecord,
} from './search-store';

/** Fake pg pool that emulates the scan_records table with a Map (matches JSONB → object). */
class FakePg implements PgPoolLike {
  rows = new Map<string, SearchRecord>();
  queryTexts: string[] = [];
  schemaProbeCalls = 0;
  schemaRows: Array<Record<string, unknown>> = [
    ...[
      ['id', 'text', true],
      ['user_id', 'text', true],
      ['artist', 'text', true],
      ['distributor', 'text', true],
      ['deep_scan_status', 'text', false],
      ['created_at', 'timestamptz', true],
      ['updated_at', 'timestamptz', true],
      ['record', 'jsonb', true],
    ].map(([name, data_type, not_null]) => ({ kind: 'column', name, data_type, not_null, is_primary: false })),
    { kind: 'index', name: 'scan_records_pkey', data_type: null, not_null: false, is_primary: true, index_columns: ['id'], descending: [false] },
    { kind: 'index', name: 'scan_records_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['created_at'], descending: [true] },
    { kind: 'index', name: 'scan_records_user_created_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['user_id', 'created_at'], descending: [false, true] },
  ];
  beforeInsert?: (incoming: SearchRecord) => Promise<void>;
  async query(text: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> {
    this.queryTexts.push(text);
    if (/\b(?:CREATE|ALTER|DROP)\b/i.test(text)) throw new Error('runtime DDL is forbidden');
    if (text.includes('FROM scan_records LIMIT 0')) { this.schemaProbeCalls++; return { rows: [] }; }
    if (text.includes('FROM pg_attribute')) { this.schemaProbeCalls++; return { rows: this.schemaRows }; }
    if (text.includes('INSERT INTO scan_records')) {
      const id = params[0] as string;
      const incoming = JSON.parse(params[6] as string) as SearchRecord;
      await this.beforeInsert?.(incoming);
      const existing = this.rows.get(id);
      if (existing && existing.userId !== incoming.userId) return { rows: [], rowCount: 0 };
      if (existing && revisionOf(existing) >= revisionOf(incoming)) return { rows: [], rowCount: 0 };
      this.rows.set(id, incoming);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (text.includes('UPDATE scan_records SET')) {
      const id = params[0] as string;
      const userId = params[1] as string;
      const incoming = JSON.parse(params[5] as string) as SearchRecord;
      const expectedRevision = params[6] as number;
      const existing = this.rows.get(id);
      if (!existing || existing.userId !== userId || revisionOf(existing) !== expectedRevision) {
        return { rows: [], rowCount: 0 };
      }
      this.rows.set(id, incoming);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (text.includes('DELETE FROM scan_records')) {
      const id = params[0] as string;
      const existing = this.rows.get(id);
      if (!existing || (text.includes('user_id = $2') && existing.userId !== params[1])) {
        return { rows: [], rowCount: 0 };
      }
      this.rows.delete(id);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (text.includes('SELECT user_id, record')) {
      const rec = this.rows.get(params[0] as string);
      return { rows: rec ? [{ user_id: rec.userId, record: rec }] : [] };
    }
    if (text.includes('SELECT record FROM scan_records WHERE id')) {
      const rec = this.rows.get(params[0] as string);
      return { rows: rec ? [{ record: rec }] : [] };
    }
    if (text.includes('ORDER BY created_at')) {
      const records = [...this.rows.values()];
      let filtered = text.includes('WHERE user_id = $1')
        ? records.filter((record) => record.userId === params[0])
        : records;
      if (text.includes('(created_at, id) <')) {
        const afterCreatedAt = params[1] as string;
        const afterId = params[2] as string;
        filtered = filtered.filter((record) =>
          record.createdAt < afterCreatedAt || (record.createdAt === afterCreatedAt && record.id < afterId));
      }
      filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const boundLimit = /LIMIT \$\d+/.test(text) ? Number(params[params.length - 1]) : 200;
      return { rows: filtered.slice(0, boundLimit).map((r) => ({ record: r })) };
    }
    return { rows: [] };
  }
}

class FakeRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly lists = new Map<string, string[]>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async lpush(key: string, value: string): Promise<void> {
    this.lists.set(key, [value, ...(this.lists.get(key) ?? [])]);
  }
  async ltrim(key: string, start: number, stop: number): Promise<void> {
    this.lists.set(key, (this.lists.get(key) ?? []).slice(start, stop + 1));
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const inclusiveStop = stop < 0 ? list.length + stop : stop;
    return list.slice(start, inclusiveStop + 1);
  }
  async lrem(key: string, count: number, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    if (count !== 0) throw new Error('FakeRedis supports only LREM count=0');
    const next = list.filter((item) => item !== value);
    this.lists.set(key, next);
    return list.length - next.length;
  }
  async del(key: string): Promise<number> { return this.values.delete(key) ? 1 : 0; }
  async eval(script: string, numberOfKeys: number, ...input: string[]): Promise<number> {
    const keys = input.slice(0, numberOfKeys);
    const args = input.slice(numberOfKeys);
    const key = keys[0]!;
    if (script.includes("redis.call('LREM'")) {
      const existed = this.values.has(key);
      for (const indexKey of keys.slice(1)) await this.lrem(indexKey, 0, args[0]!);
      this.values.delete(key);
      return existed ? 1 : 0;
    }
    if (script.includes("redis.call('EXISTS'")) {
      if (this.values.has(key)) return 0;
      this.values.set(key, args[0]!);
      return 1;
    }
    if (this.values.get(key) !== args[0]) return 0;
    this.values.set(key, args[1]!);
    return 1;
  }
}

const result = (): CatalogResultLike => ({
  artist: 'Lewis KE', stores: ['Deezer'], profiles: [],
  tracks: [{ title: 'Icy Love', album: null, isrc: 'QZK6K2090500', artworkUrl: null, perStore: [{ store: 'Deezer', status: 'live', foundArtist: null, url: null, confidence: 1, needsManualReview: false, reviewQuery: null }] }],
  summary: { tracks: 1, live: 1, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: 'now', warnings: [], note: '',
});

describe('PostgresSearchStore', () => {
  it('validates the migrated schema once, never runs DDL, and round-trips a record', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    expect(pg.queryTexts).toHaveLength(0); // construction has no database side effects
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
    expect(saved.userId).toBe('');
    const got = await store.get(saved.id);
    expect(got?.artist).toBe('Lewis KE');
    expect((await store.list())[0]?.id).toBe(saved.id);
    expect(pg.schemaProbeCalls).toBe(2);
    expect(pg.queryTexts.every((text) => !/\b(?:CREATE|ALTER|DROP)\b/i.test(text))).toBe(true);
  });

  it('fails before DML when a required migrated column or index is absent', async () => {
    const missingIndex = new FakePg();
    missingIndex.schemaRows = missingIndex.schemaRows.filter((row) => row.name !== 'scan_records_user_created_idx');
    const store = new PostgresSearchStore(missingIndex);

    await expect(store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result()))
      .rejects.toThrow(/schema is incomplete.*scan_records_user_created_idx/i);
    expect(missingIndex.queryTexts.some((text) => text.includes('INSERT INTO'))).toBe(false);
  });

  it('update reads-modifies-writes the durable row', async () => {
    const store = new PostgresSearchStore(new FakePg());
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
    await store.update(saved.id, (r) => ({ ...r, deepScan: { status: 'done', platformsDone: ['Spotify'], platformsPending: [] } }));
    expect((await store.get(saved.id))?.deepScan?.status).toBe('done');
  });

  it('deletes a record durably and removes it from user history', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    expect(await store.delete(saved.id)).toBe(true);
    expect(await store.delete(saved.id)).toBe(false);
    expect(await store.get(saved.id)).toBeNull();
    expect(await store.listForUser('user-a')).toEqual([]);
  });

  it('persists each record under its actual user in an application-wide store', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
    expect(saved.userId).toBe('user-a');
    expect(pg.rows.get(saved.id)?.userId).toBe('user-a');
    expect((await store.get(saved.id))?.userId).toBe('user-a');
  });

  it('lists at the SQL user boundary instead of filtering a global capped page, and excludes unowned legacy rows', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    await store.save({ artist: 'Alice', distributor: 'distrokid' }, result(), undefined, { userId: 'alice' });
    await store.save({ artist: 'Bob', distributor: 'distrokid' }, result(), undefined, { userId: 'bob' });
    await store.save({ artist: 'Legacy', distributor: 'distrokid' }, result()); // no owner: userId ''

    expect((await store.listForUser('alice')).map((item) => item.artist)).toEqual(['Alice']);
    expect((await store.listForUser('bob')).map((item) => item.artist)).toEqual(['Bob']);
    expect(pg.queryTexts.some((text) => text.includes('user_id = $1'))).toBe(true);
  });

  it('seek-paginates more than 200 user rows with deterministic id ordering for equal timestamps', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const seed = await store.save({
      artist: 'Seed', distributor: 'distrokid',
    }, result(), undefined, { userId: 'alice' });
    await store.delete(seed.id, 'alice');
    const createdAt = '2026-07-22T12:00:00.000Z';
    for (let index = 0; index < 225; index++) {
      await store.put({ ...seed, id: `search_${String(index).padStart(3, '0')}`, createdAt, artist: `Artist ${index}` });
    }

    const ids: string[] = [];
    let after: { createdAt: string; id: string } | undefined;
    do {
      const page = await store.pageForUser('alice', { limit: 37, ...(after ? { after } : {}) });
      ids.push(...page.items.map((item) => item.id));
      after = page.nextCursor;
    } while (after);

    expect(ids).toHaveLength(225);
    expect(new Set(ids).size).toBe(225);
    expect(ids[0]).toBe('search_224');
    expect(ids.at(-1)).toBe('search_000');
    expect(pg.queryTexts.some((text) => text.includes('ORDER BY created_at DESC, id DESC'))).toBe(true);
  });

  it('rejects a record id collision across users without overwriting the owner', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const original = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    await expect(store.put({ ...original, userId: 'user-b', artist: 'Attacker Rewrite' })).rejects.toThrow(
      'scan record is owned by another user',
    );
    expect(pg.rows.get(original.id)?.userId).toBe('user-a');
    expect(pg.rows.get(original.id)?.artist).toBe('Private Artist');
  });

  it('rejects a full-record ownership rewrite at the durable boundary', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const original = await store.save({
      artist: 'Private Artist', distributor: 'distrokid',
    }, result(), undefined, { userId: 'alice' });

    await expect(store.put({ ...original, revision: 2, userId: 'bob' })).rejects.toThrow('scan record is owned by another user');
    expect(pg.rows.get(original.id)).toMatchObject({ userId: 'alice' });
  });

  it('accepts an idempotent same-revision projection independent of JSON object key order', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'alice' });
    const reordered: SearchRecord = {
      result: saved.result,
      song: saved.song,
      platforms: saved.platforms,
      distributor: saved.distributor,
      artist: saved.artist,
      createdAt: saved.createdAt,
      userId: saved.userId,
      revision: saved.revision,
      id: saved.id,
    };
    await expect(store.upsert(reordered)).resolves.toBeUndefined();
    expect(pg.rows.get(saved.id)?.artist).toBe('Private Artist');
  });

  it('never promotes stale full-record puts over newer durable state', async () => {
    const pg = new FakePg();
    const store = new PostgresSearchStore(pg);
    const saved = await store.save({ artist: 'Private Artist', distributor: 'distrokid' }, result());
    const newer: SearchRecord = { ...saved, revision: 3, result: { ...saved.result, note: 'newer' } };
    await store.put(newer);
    await store.put({ ...saved, revision: 2, result: { ...saved.result, note: 'stale' } });

    expect((await store.get(saved.id))?.revision).toBe(3);
    expect((await store.get(saved.id))?.result.note).toBe('newer');
    await expect(store.put({ ...newer, result: { ...newer.result, note: 'equal-version-conflict' } }))
      .rejects.toThrow('conflicting search record revision');
  });
});

describe('revision-aware hot store', () => {
  it('ignores stale cache refreshes and rejects equal-revision conflicts across users or data', async () => {
    const store = new RedisSearchStore(new FakeRedis());
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
    const updated = await store.update(saved.id, (record) => ({
      ...record,
      result: { ...record.result, note: 'new authoritative state' },
    }));
    expect(updated?.revision).toBe(2);

    await store.put(saved); // delayed revision 1 cache refresh
    expect((await store.get(saved.id))?.result.note).toBe('new authoritative state');
    await expect(store.put({ ...updated!, artist: 'same revision, different data' })).rejects.toThrow('conflicting');
    await expect(store.put({ ...updated!, revision: 3, userId: 'user-b' })).rejects.toThrow('another user');
  });

  it('atomically removes Redis values plus global and user index entries', async () => {
    const redis = new FakeRedis();
    const store = new RedisSearchStore(redis);
    const saved = await store.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    expect(await store.delete(saved.id)).toBe(true);
    expect(await store.get(saved.id)).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await store.listForUser('user-a')).toEqual([]);
    expect(redis.lists.get('search:index')).not.toContain(saved.id);
    expect(redis.lists.get('search:user:user-a:index')).not.toContain(saved.id);

    const partiallyRemoved = await store.save({ artist: 'Second', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
    redis.values.delete(`search:${partiallyRemoved.id}`);
    expect(await store.delete(partiallyRemoved.id, 'user-a')).toBe(false);
    expect(redis.lists.get('search:index')).not.toContain(partiallyRemoved.id);
    expect(redis.lists.get('search:user:user-a:index')).not.toContain(partiallyRemoved.id);
  });

  it('uses a dedicated user index so 205 peer records cannot starve another owner', async () => {
    const redis = new FakeRedis();
    const store = new RedisSearchStore(redis);
    const bob = await store.save({
      artist: 'Bob', distributor: 'distrokid',
    }, result(), undefined, { userId: 'bob' });
    for (let i = 0; i < 205; i++) {
      await store.save({
        artist: `Alice ${i}`, distributor: 'distrokid',
      }, result(), undefined, { userId: 'alice' });
    }

    expect((await store.listForUser('bob')).map((item) => item.id)).toEqual([bob.id]);
    expect(await store.listForUser('alice')).toHaveLength(200);
    const aliceIndex = redis.lists.get('search:user:alice:index')!;
    aliceIndex.unshift(aliceIndex[0]!); // tolerate a stale duplicate left by a retried index write
    const pagedIds: string[] = [];
    let after: { createdAt: string; id: string } | undefined;
    do {
      const page = await store.pageForUser('alice', { limit: 41, ...(after ? { after } : {}) });
      pagedIds.push(...page.items.map((item) => item.id));
      after = page.nextCursor;
    } while (after);
    expect(pagedIds).toHaveLength(205);
    expect(new Set(pagedIds).size).toBe(205);
    await store.delete(bob.id, 'bob');
    expect(redis.lists.get('search:user:bob:index')).not.toContain(bob.id);
  });
});

describe('TieredSearchStore', () => {
  it('mirrors saves to the durable tier and recovers on a Redis flush', async () => {
    const hot = new InMemorySearchStore();
    const pg = new FakePg();
    const durable = new PostgresSearchStore(pg);
    const tiered = new TieredSearchStore(hot, durable);

    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
    expect(pg.rows.has(saved.id)).toBe(true); // durably persisted

    // Simulate a Redis flush: wipe the hot tier.
    const flushed = new InMemorySearchStore();
    const recovered = new TieredSearchStore(flushed, durable);
    const got = await recovered.get(saved.id);
    expect(got?.id).toBe(saved.id); // recovered from Postgres
    expect(await flushed.get(saved.id)).not.toBeNull(); // and re-warmed into hot
  });

  it('deletes from both durable and hot tiers so history cannot resurrect', async () => {
    const hot = new InMemorySearchStore();
    const pg = new FakePg();
    const durable = new PostgresSearchStore(pg);
    const tiered = new TieredSearchStore(hot, durable);
    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    expect(await tiered.delete(saved.id)).toBe(true);
    expect(await hot.get(saved.id)).toBeNull();
    expect(await durable.get(saved.id)).toBeNull();
    expect(await tiered.listForUser('user-a')).toEqual([]);
  });

  it('durably projects every mutation, including metadata-only changes', async () => {
    const hot = new InMemorySearchStore();
    const pg = new FakePg();
    const tiered = new TieredSearchStore(hot, new PostgresSearchStore(pg));
    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result());
    let writes = 0;
    const realQuery = pg.query.bind(pg);
    pg.query = async (t, p) => { if (t.includes('UPDATE scan_records SET')) writes++; return realQuery(t, p); };

    // Manual-review attribution does not change status/counts, but it is authoritative data.
    await tiered.update(saved.id, (r) => ({
      ...r,
      result: {
        ...r.result,
        tracks: r.result.tracks.map((track) => ({
          ...track,
          perStore: track.perStore.map((cell) => ({
            ...cell,
            reviewDecision: 'DISMISSED',
            reviewedBy: 'reviewer-1',
            reviewedAt: '2026-07-22T00:00:00.000Z',
            reviewNotes: 'verified against the artist dashboard',
          })),
        })),
      },
    }));
    expect(writes).toBe(1);
    const durable = await new PostgresSearchStore(pg).get(saved.id);
    expect(durable?.result.tracks[0]?.perStore[0]).toMatchObject({
      reviewDecision: 'DISMISSED',
      reviewedBy: 'reviewer-1',
      reviewNotes: 'verified against the artist dashboard',
    });
  });

  it('does not let a stale cache projection roll Postgres backward', async () => {
    const hot = new InMemorySearchStore();
    const pg = new FakePg();
    const tiered = new TieredSearchStore(hot, new PostgresSearchStore(pg));
    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    const staleProjection = {
      ...saved,
      result: { ...saved.result, note: 'stale-cache-value' },
    };
    const newer = await tiered.update(saved.id, (record) => ({
      ...record,
      deepScan: { status: 'running', platformsDone: [], platformsPending: ['Spotify'] },
    }));
    await tiered.put(staleProjection);

    const durable = pg.rows.get(saved.id);
    expect(durable?.revision).toBe(2);
    expect(durable?.result.note).toBe('');
    expect(durable?.deepScan?.status).toBe('running');
    expect(durable?.userId).toBe('user-a');
    expect((await hot.get(saved.id))?.revision).toBe(newer?.revision);
  });

  it('serializes concurrent production mutations against Postgres and replays losers', async () => {
    const hot = new InMemorySearchStore();
    const pg = new FakePg();
    const durable = new PostgresSearchStore(pg);
    const tiered = new TieredSearchStore(hot, durable);
    const saved = await tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });

    await Promise.all([
      tiered.update(saved.id, (record) => ({ ...record, result: { ...record.result, note: 'human-reviewed' } })),
      tiered.update(saved.id, (record) => ({
        ...record,
        deepScan: { status: 'running', platformsDone: [], platformsPending: ['Spotify'] },
      })),
    ]);

    const authoritative = await durable.get(saved.id);
    expect(authoritative?.revision).toBe(3);
    expect(authoritative?.result.note).toBe('human-reviewed');
    expect(authoritative?.deepScan?.status).toBe('running');
    expect((await hot.get(saved.id))?.revision).toBe(3);
  });

  it('fails closed in production instead of serving a stale hot record when Postgres is down', async () => {
    const hot = new InMemorySearchStore();
    const cached = await hot.save({ artist: 'Cached Artist', distributor: 'distrokid' }, result(), undefined, { userId: 'user-a' });
    const brokenPg: PgPoolLike = {
      query: async () => { throw new Error('pg down'); },
    };
    const tiered = new TieredSearchStore(hot, new PostgresSearchStore(brokenPg));

    await expect(tiered.get(cached.id)).rejects.toThrow('pg down');
    await expect(tiered.listForUser('user-a')).rejects.toThrow('durable search store unavailable');
  });

  it('never acknowledges a write when the durable tier throws', async () => {
    const hot = new InMemorySearchStore();
    const brokenPg: PgPoolLike = { query: async () => { throw new Error('pg down'); } };
    const tiered = new TieredSearchStore(hot, new PostgresSearchStore(brokenPg));
    await expect(
      tiered.save({ artist: 'Lewis KE', distributor: 'distrokid' }, result()),
    ).rejects.toThrow('pg down');
    expect(await hot.list()).toEqual([]);
  });
});
