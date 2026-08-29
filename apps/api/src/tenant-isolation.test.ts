import { describe, it, expect } from 'vitest';
import { InMemorySearchStore, type CatalogResultLike } from '@sentinel/search-store';
import {
  personalArtistWorkspaceId,
  PrincipalScopedSearchStore,
  TenantScopedSearchStore,
  type SearchPrincipal,
} from './tenant-scoped-search-store';

/**
 * Cross-tenant isolation of the search store.
 *
 * The vulnerability: the API read searches by id alone and listed them with no filter at all, and
 * `SearchRecord` carried no `tenantId`, so there was nothing to filter on even if a route had
 * tried. With multi-tenant auth enabled, any authenticated caller could read another tenant's
 * artists, unreleased catalogue and ISRCs by knowing a search id, and `GET /api/searches` handed
 * every tenant's scans to everyone.
 *
 * The leak is the interesting failure here, so these tests assert what a caller CANNOT see.
 */

const result = (artist: string): CatalogResultLike => ({
  artist, stores: ['spotify'], profiles: [], tracks: [],
  summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
  generatedAt: '2026-01-01T00:00:00.000Z', warnings: [], note: '',
});

describe('TenantScopedSearchStore', () => {
  it('stamps the owning tenant on save', async () => {
    const inner = new InMemorySearchStore();
    const rec = await new TenantScopedSearchStore(inner, 'acme').save({ artist: 'A', distributor: 'distrokid' }, result('A'));
    expect(rec.tenantId).toBe('acme');
  });

  it('returns NULL for another tenant record, not 403, which would confirm it exists', async () => {
    const inner = new InMemorySearchStore();
    const theirs = await new TenantScopedSearchStore(inner, 'acme').save({ artist: 'Secret Artist', distributor: 'distrokid' }, result('Secret Artist'));

    const attacker = new TenantScopedSearchStore(inner, 'evil-corp');
    // Knowing the id must not be enough. A 403 here would turn id-guessing into a working
    // enumeration oracle over other tenants' scans.
    expect(await attacker.get(theirs.id)).toBeNull();
  });

  it('LISTS only its own searches', async () => {
    const inner = new InMemorySearchStore();
    await new TenantScopedSearchStore(inner, 'acme').save({ artist: 'Acme Artist', distributor: 'distrokid' }, result('Acme Artist'));
    await new TenantScopedSearchStore(inner, 'other').save({ artist: 'Other Artist', distributor: 'distrokid' }, result('Other Artist'));

    const mine = await new TenantScopedSearchStore(inner, 'acme').list();
    expect(mine).toHaveLength(1);
    expect(mine[0]!.artist).toBe('Acme Artist');
    // The unscoped store still sees both, that's why routes must never touch it directly.
    expect(await inner.list()).toHaveLength(2);
  });

  it('one tenant cannot evict another tenant from its 200-record list window', async () => {
    const inner = new InMemorySearchStore();
    const quiet = new TenantScopedSearchStore(inner, 'quiet');
    await quiet.save({ artist: 'Quiet Artist', distributor: 'distrokid' }, result('Quiet Artist'));
    const busy = new TenantScopedSearchStore(inner, 'busy');
    for (let i = 0; i < 205; i++) {
      await busy.save({ artist: `Busy ${i}`, distributor: 'distrokid' }, result(`Busy ${i}`));
    }
    expect((await quiet.list()).map((item) => item.artist)).toEqual(['Quiet Artist']);
    expect(await busy.list()).toHaveLength(200);
  });

  it('REFUSES to mutate another tenant record', async () => {
    const inner = new InMemorySearchStore();
    const theirs = await new TenantScopedSearchStore(inner, 'acme').save({ artist: 'A', distributor: 'distrokid' }, result('A'));

    const attacker = new TenantScopedSearchStore(inner, 'evil-corp');
    const updated = await attacker.update(theirs.id, (r) => ({ ...r, artist: 'HACKED' }));
    expect(updated).toBeNull();
    // And the record is untouched.
    expect((await inner.get(theirs.id))!.artist).toBe('A');
  });

  it('cannot be tricked into RE-OWNING a record via the mutator', async () => {
    // The mutate callback is caller-supplied. Returning a different tenantId from it must not
    // move someone else's record, or an update would double as a takeover.
    const inner = new InMemorySearchStore();
    const scoped = new TenantScopedSearchStore(inner, 'acme');
    const mine = await scoped.save({ artist: 'A', distributor: 'distrokid' }, result('A'));

    await scoped.update(mine.id, (r) => ({ ...r, tenantId: 'evil-corp', artist: 'B' }));
    const after = await inner.get(mine.id);
    expect(after!.tenantId).toBe('acme'); // ownership preserved
    expect(after!.artist).toBe('B'); // the legitimate part of the edit still applied
  });

  it('treats a legacy record with no tenantId as the demo tenant, not as public', async () => {
    // Records predate multi-tenancy. Defaulting them to "anyone can read" would turn a schema
    // migration into a data leak; defaulting to `default` cannot leak one real tenant to another.
    const inner = new InMemorySearchStore();
    const legacy = await inner.save({ artist: 'Legacy', distributor: 'distrokid' }, result('Legacy'));
    await inner.update(legacy.id, (r) => { const { tenantId: _drop, ...rest } = r; return rest as typeof r; });

    expect(await new TenantScopedSearchStore(inner, 'acme').get(legacy.id)).toBeNull();
    expect(await new TenantScopedSearchStore(inner, 'default').get(legacy.id)).not.toBeNull();
  });
});

const principal = (sub: string, roles: string[] = ['artist_manager'], tenantId = 'acme'): SearchPrincipal => ({
  tenantId, sub, roles, authenticated: true,
});

describe('PrincipalScopedSearchStore', () => {
  it('stamps an immutable OIDC subject and deterministic server-selected workspace', async () => {
    const inner = new InMemorySearchStore();
    const alice = new PrincipalScopedSearchStore(inner, principal('alice'));
    const saved = await alice.save({ artist: 'Alice Artist', distributor: 'distrokid' }, result('Alice Artist'));

    expect(saved).toMatchObject({
      tenantId: 'acme',
      ownerUserId: 'alice',
      artistWorkspaceId: personalArtistWorkspaceId('acme', 'alice'),
    });
    await alice.update(saved.id, (record) => ({
      ...record,
      tenantId: 'other',
      ownerUserId: 'bob',
      artistWorkspaceId: 'aw-attacker',
    }));
    expect(await inner.get(saved.id)).toMatchObject({
      tenantId: 'acme',
      ownerUserId: 'alice',
      artistWorkspaceId: personalArtistWorkspaceId('acme', 'alice'),
    });
  });

  it('isolates Alice from Bob inside one tenant for reads, writes, deletes, and lists', async () => {
    const inner = new InMemorySearchStore();
    const alice = new PrincipalScopedSearchStore(inner, principal('alice'));
    const bob = new PrincipalScopedSearchStore(inner, principal('bob'));
    const secret = await alice.save({ artist: 'Alice Secret', distributor: 'distrokid' }, result('Alice Secret'));
    await bob.save({ artist: 'Bob Artist', distributor: 'distrokid' }, result('Bob Artist'));

    expect(await bob.get(secret.id)).toBeNull();
    expect(await bob.update(secret.id, (record) => ({ ...record, artist: 'stolen' }))).toBeNull();
    expect(await bob.delete(secret.id)).toBe(false);
    expect((await bob.list()).map((item) => item.artist)).toEqual(['Bob Artist']);
    expect((await inner.get(secret.id))?.artist).toBe('Alice Secret');
  });

  it('does not let 205 Alice records starve Bob from the owner-indexed 200-row page', async () => {
    const inner = new InMemorySearchStore();
    const alice = new PrincipalScopedSearchStore(inner, principal('alice'));
    const bob = new PrincipalScopedSearchStore(inner, principal('bob'));
    await bob.save({ artist: 'Bob Quiet', distributor: 'distrokid' }, result('Bob Quiet'));
    for (let i = 0; i < 205; i++) {
      await alice.save({ artist: `Alice ${i}`, distributor: 'distrokid' }, result(`Alice ${i}`));
    }

    expect((await bob.list()).map((item) => item.artist)).toEqual(['Bob Quiet']);
    expect(await alice.list()).toHaveLength(200);
  });

  it('lets a tenant admin operate on same-tenant rows but hides customer data from platform-admin-only tokens', async () => {
    const inner = new InMemorySearchStore();
    const alice = new PrincipalScopedSearchStore(inner, principal('alice'));
    const saved = await alice.save({ artist: 'Alice Artist', distributor: 'distrokid' }, result('Alice Artist'));
    const tenantAdmin = new PrincipalScopedSearchStore(inner, principal('admin', ['tenant_admin']));
    const platformAdmin = new PrincipalScopedSearchStore(inner, principal('platform', ['platform_admin']));

    expect((await tenantAdmin.list()).map((item) => item.id)).toEqual([saved.id]);
    expect(await tenantAdmin.get(saved.id)).not.toBeNull();
    expect(await platformAdmin.list()).toEqual([]);
    expect(await platformAdmin.get(saved.id)).toBeNull();
    await expect(platformAdmin.save({ artist: 'Customer', distributor: 'distrokid' }, result('Customer')))
      .rejects.toMatchObject({ name: 'CustomerScanAccessError' });
  });

  it('hides ownerless legacy rows from ordinary users but exposes them to a same-tenant admin', async () => {
    const inner = new InMemorySearchStore();
    const legacy = await inner.save({ tenantId: 'acme', artist: 'Legacy', distributor: 'distrokid' }, result('Legacy'));
    const alice = new PrincipalScopedSearchStore(inner, principal('alice'));
    const admin = new PrincipalScopedSearchStore(inner, principal('admin', ['tenant_admin']));

    expect(await alice.get(legacy.id)).toBeNull();
    expect(await alice.list()).toEqual([]);
    expect(await admin.get(legacy.id)).not.toBeNull();

    const derived = await admin.saveDerived(legacy, {
      tenantId: 'other', ownerUserId: 'attacker', artistWorkspaceId: 'aw-attacker',
      sourceSearchId: legacy.id, artist: legacy.artist, distributor: legacy.distributor,
    } as never, result('Legacy'));
    expect(derived.tenantId).toBe('acme');
    expect(derived.ownerUserId).toBeUndefined();
    expect(derived.artistWorkspaceId).toBeUndefined();
  });

  it('preserves the source owner and consent-bound workspace when an admin creates a rescan', async () => {
    const inner = new InMemorySearchStore();
    const source = await inner.save({
      tenantId: 'acme', ownerUserId: 'alice', artistWorkspaceId: 'aw-consent-bound',
      artist: 'Alice', distributor: 'distrokid',
    }, result('Alice'));
    const admin = new PrincipalScopedSearchStore(inner, principal('admin', ['tenant_admin']));
    const derived = await admin.saveDerived(source, {
      sourceSearchId: source.id, artist: source.artist, distributor: source.distributor,
    }, result('Alice'));

    expect(derived).toMatchObject({
      ownerUserId: 'alice', artistWorkspaceId: 'aw-consent-bound', sourceSearchId: source.id,
    });
  });

  it('shares history only through durable workspace grants and separates read from edit authority', async () => {
    const inner = new InMemorySearchStore();
    const shared = await inner.save({
      tenantId: 'shared-org', ownerUserId: 'owner', artistWorkspaceId: 'workspace-shared',
      artist: 'Shared catalog', distributor: 'distrokid',
    }, result('Shared catalog'));
    const hidden = await inner.save({
      tenantId: 'shared-org', ownerUserId: 'owner', artistWorkspaceId: 'workspace-private',
      artist: 'Private catalog', distributor: 'distrokid',
    }, result('Private catalog'));
    const reader = new PrincipalScopedSearchStore(
      inner,
      principal('invited-reader', ['artist_manager'], 'shared-org'),
      { read: ['workspace-shared'], edit: [] },
    );

    expect(await reader.get(shared.id)).not.toBeNull();
    expect(await reader.get(hidden.id)).toBeNull();
    expect((await reader.list()).map((record) => record.id)).toEqual([shared.id]);
    expect((await reader.listPage(1)).searches.map((record) => record.id)).toEqual([shared.id]);
    expect(await reader.update(shared.id, (record) => ({ ...record, name: 'not allowed' }))).toBeNull();
    expect(await reader.delete(shared.id)).toBe(false);
    await expect(reader.saveInAuthorizedWorkspace(
      'workspace-shared',
      { artist: 'Unauthorized write', distributor: 'distrokid' },
      result('Unauthorized write'),
    )).rejects.toThrow(/editable principal scope/);

    const editor = new PrincipalScopedSearchStore(
      inner,
      principal('invited-editor', ['artist_manager'], 'shared-org'),
      { read: ['workspace-shared'], edit: ['workspace-shared'] },
    );
    expect(await editor.update(shared.id, (record) => ({ ...record, name: 'Team catalog' })))
      .toMatchObject({ name: 'Team catalog', ownerUserId: 'owner', artistWorkspaceId: 'workspace-shared' });
  });
});
