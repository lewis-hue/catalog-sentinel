import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryAuditLogger } from '@sentinel/security';
import { InMemorySearchStore, type ReleasedTrackLike } from '@sentinel/search-store';
import { buildApp, type AppDeps } from './app';
import { createAppTestServices } from './app.test-support';
import type { CatalogScanResult } from './catalog-scan';
import { SCAN_NAME_MAX_LENGTH, isActiveSearch, validateScanName } from './scan-history';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function result(artist = 'Private Artist'): CatalogScanResult {
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
    generatedAt: '2026-07-22T00:00:00.000Z',
    warnings: [],
    note: 'fast baseline',
  };
}

async function readyApp(options: Partial<AppDeps>): Promise<FastifyInstance> {
  const app = buildApp({ ...createAppTestServices(), ...options });
  apps.push(app);
  await app.ready();
  return app;
}

describe('scan history name validation', () => {
  it('normalizes a valid display name and rejects empty, invisible, and overlong labels', () => {
    expect(validateScanName('  July   catalogue audit  ')).toEqual({ ok: true, name: 'July catalogue audit' });
    expect(validateScanName('   ')).toMatchObject({ ok: false });
    expect(validateScanName('hidden\u200bname')).toMatchObject({ ok: false });
    expect(validateScanName('x'.repeat(SCAN_NAME_MAX_LENGTH + 1))).toMatchObject({ ok: false });
  });

  it('treats distributor reading plus idle/queued/running deep scans as active', () => {
    const base = result();
    expect(isActiveSearch({ result: { ...base, warnings: ['__reading_in_progress__'] } })).toBe(true);
    expect(isActiveSearch({ result: base, deepScan: { status: 'idle', platformsPending: [], platformsDone: [] } })).toBe(true);
    expect(isActiveSearch({ result: base, deepScan: { status: 'queued', platformsPending: [], platformsDone: [] } })).toBe(true);
    expect(isActiveSearch({ result: base, deepScan: { status: 'running', platformsPending: [], platformsDone: [] } })).toBe(true);
    expect(isActiveSearch({ result: base, deepScan: { status: 'done', platformsPending: [], platformsDone: [] } })).toBe(false);
  });
});

describe('scan history mutation routes', () => {
  it('renames a tenant-owned scan, exposes the name in history, and audits the mutation', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const saved = await store.save({ tenantId: 'default', artist: 'Private Artist', distributor: 'distrokid' }, result());
    const app = await readyApp({ searchStore: store, auditLogger: audit });

    const invalid = await app.inject({ method: 'PATCH', url: `/api/searches/${saved.id}`, payload: { name: '   ' } });
    expect(invalid.statusCode).toBe(400);
    expect((await store.get(saved.id))?.name).toBeUndefined();

    const renamed = await app.inject({
      method: 'PATCH', url: `/api/searches/${saved.id}`, payload: { name: '  July   catalogue audit  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: saved.id, name: 'July catalogue audit' });

    const history = await app.inject({ method: 'GET', url: '/api/searches' });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ searches: [{ id: saved.id, name: 'July catalogue audit' }] });
    expect((await audit.list()).map((entry) => entry.action)).toContain('catalog.search.renamed');
  }, 15_000);

  it('returns 404 for every mutation of another tenant scan without touching or queuing it', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const enqueue = vi.fn(async () => {});
    const fastScan = vi.fn(async (artist: string) => result(artist));
    const theirs = await store.save({ tenantId: 'tenant-other', artist: 'Secret Artist', distributor: 'distrokid' }, result('Secret Artist'));
    const app = await readyApp({ searchStore: store, auditLogger: audit, enqueueDeepScan: enqueue, runFastCatalogScan: fastScan });

    const rename = await app.inject({ method: 'PATCH', url: `/api/searches/${theirs.id}`, payload: { name: 'stolen' } });
    const remove = await app.inject({ method: 'DELETE', url: `/api/searches/${theirs.id}` });
    const rescan = await app.inject({ method: 'POST', url: `/api/searches/${theirs.id}/rescan`, payload: {} });

    expect([rename.statusCode, remove.statusCode, rescan.statusCode]).toEqual([404, 404, 404]);
    expect((await store.get(theirs.id))?.artist).toBe('Secret Artist');
    expect(enqueue).not.toHaveBeenCalled();
    expect(fastScan).not.toHaveBeenCalled();
    expect(await audit.list()).toEqual([]);
  });

  it('rejects deletion while distributor reading or idle/queued/running, then removes terminal history and audits it', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const saved = await store.save({ tenantId: 'default', artist: 'Private Artist', distributor: 'distrokid' }, result());
    await store.update(saved.id, (record) => ({
      ...record,
      result: { ...record.result, warnings: ['__reading_in_progress__'] },
    }));
    const app = await readyApp({ searchStore: store, auditLogger: audit });

    const reading = await app.inject({ method: 'DELETE', url: `/api/searches/${saved.id}` });
    expect(reading.statusCode).toBe(409);
    expect(reading.json()).toMatchObject({ status: 'reading_distributor_catalog' });
    await store.update(saved.id, (record) => ({
      ...record,
      result: { ...record.result, warnings: [] },
      deepScan: { status: 'idle', platformsPending: [], platformsDone: [] },
    }));
    const idle = await app.inject({ method: 'DELETE', url: `/api/searches/${saved.id}` });
    expect(idle.statusCode).toBe(409);
    expect(idle.json()).toMatchObject({ status: 'idle' });
    await store.update(saved.id, (record) => ({
      ...record,
      deepScan: { status: 'queued', platformsPending: [], platformsDone: [] },
    }));

    const queued = await app.inject({ method: 'DELETE', url: `/api/searches/${saved.id}` });
    expect(queued.statusCode).toBe(409);
    expect(queued.json()).toMatchObject({ status: 'queued' });
    await store.update(saved.id, (record) => ({
      ...record,
      deepScan: { status: 'running', platformsPending: ['Spotify'], platformsDone: [] },
    }));
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${saved.id}` })).statusCode).toBe(409);

    await store.update(saved.id, (record) => ({
      ...record,
      deepScan: { status: 'done', platformsPending: [], platformsDone: ['Spotify'] },
    }));
    expect((await app.inject({ method: 'DELETE', url: `/api/searches/${saved.id}` })).statusCode).toBe(204);
    expect(await store.get(saved.id)).toBeNull();
    expect(await store.listForTenant('default')).toEqual([]);
    expect((await audit.list()).map((entry) => entry.action)).toEqual(['catalog.search.deleted']);
  });

  it('creates an immutable linked record and queues a platform recheck from the saved snapshot', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const enqueue = vi.fn(async () => {});
    const released: ReleasedTrackLike[] = [{
      title: 'Track One', primaryArtist: 'Private Artist', isrc: 'QZABC1234567', releaseTitle: 'Release One',
    }];
    const source = await store.save(
      { tenantId: 'default', name: 'Original audit', artist: 'Private Artist', distributor: 'distrokid', platforms: ['Spotify'] },
      result(),
      released,
    );
    await store.update(source.id, (record) => ({
      ...record,
      deepScan: { status: 'done', platformsPending: [], platformsDone: ['Spotify'] },
    }));
    const sourceBefore = structuredClone(await store.get(source.id));
    const releasedScan = vi.fn(async (artist: string, tracks: ReleasedTrackLike[]) => {
      expect(artist).toBe('Private Artist');
      expect(tracks).toEqual(released);
      return result(artist);
    });
    const app = await readyApp({
      searchStore: store,
      auditLogger: audit,
      enqueueDeepScan: enqueue,
      runReleasedCatalogScan: releasedScan,
    });

    const response = await app.inject({
      method: 'POST', url: `/api/searches/${source.id}/rescan`, payload: { name: 'July rerun' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      id: string;
      sourceSearchId: string;
      operation: string;
      name: string;
      deepScan: { status: string };
      result: { note: string };
      actions: { refreshDistributor: { href: string; label: string } };
    };
    expect(body).toMatchObject({
      sourceSearchId: source.id,
      operation: 'SAVED_SNAPSHOT_PLATFORM_RECHECK',
      name: 'July rerun',
      deepScan: { status: 'queued' },
      actions: { refreshDistributor: { href: '/connect', label: 'Refresh from DistroKid' } },
    });
    expect(body.result.note).toMatch(/saved distributor snapshot/i);
    expect(body.result.note).toMatch(/not re-extracted/i);
    expect(body.id).not.toBe(source.id);
    expect(enqueue).toHaveBeenCalledWith(body.id, 'default');

    const created = await store.get(body.id);
    expect(created).toMatchObject({ sourceSearchId: source.id, name: 'July rerun', deepScan: { status: 'queued' } });
    expect(await store.get(source.id)).toEqual(sourceBefore);
    await store.update(body.id, (record) => ({ ...record, sourceSearchId: 'rewritten-source' }));
    expect((await store.get(body.id))?.sourceSearchId).toBe(source.id);
    expect((await audit.list()).map((entry) => entry.action)).toEqual(['catalog.search.platform-recheck.created']);
  });

  it('rejects a saved-snapshot platform recheck while the source is still active', async () => {
    const store = new InMemorySearchStore();
    const audit = new InMemoryAuditLogger();
    const enqueue = vi.fn(async () => {});
    const releasedScan = vi.fn(async () => result());
    const source = await store.save(
      { tenantId: 'default', artist: 'Private Artist', distributor: 'distrokid' },
      { ...result(), warnings: ['__reading_in_progress__'] },
      [],
    );
    const app = await readyApp({
      searchStore: store,
      auditLogger: audit,
      enqueueDeepScan: enqueue,
      runReleasedCatalogScan: releasedScan,
    });

    const response = await app.inject({ method: 'POST', url: `/api/searches/${source.id}/rescan`, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'reading_distributor_catalog' });
    expect(releasedScan).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(await audit.list()).toEqual([]);
  });
});
