import { describe, it, expect } from 'vitest';
import { InMemoryTenantStore, CrossTenantError, type TenantContext } from './tenant-repo';
import { InMemoryDistributorLinkRepository, type LinkDeepScan } from './distributor-link-repo';

interface Row {
  id: string;
  tenantId: string;
  value: string;
}
const A: TenantContext = { tenantId: 'tenant-A' };
const B: TenantContext = { tenantId: 'tenant-B' };

describe('TenantStore, cross-tenant isolation', () => {
  it('refuses to write a row for a different tenant', async () => {
    const store = new InMemoryTenantStore<Row>();
    await expect(store.put(A, { id: 'r1', tenantId: 'tenant-B', value: 'x' })).rejects.toThrow(CrossTenantError);
  });

  it('never returns another tenant’s row by id', async () => {
    const store = new InMemoryTenantStore<Row>();
    await store.put(B, { id: 'r1', tenantId: 'tenant-B', value: 'secret' });
    expect(await store.get(A, 'r1')).toBeNull();
    expect((await store.get(B, 'r1'))?.value).toBe('secret');
  });

  it('scopes find/all/update/delete to the caller’s tenant', async () => {
    const store = new InMemoryTenantStore<Row>();
    await store.put(A, { id: 'a1', tenantId: 'tenant-A', value: 'a' });
    await store.put(B, { id: 'b1', tenantId: 'tenant-B', value: 'b' });

    expect((await store.all(A)).map((r) => r.id)).toEqual(['a1']);
    expect(await store.update(A, 'b1', { value: 'hacked' })).toBeNull();
    expect((await store.get(B, 'b1'))?.value).toBe('b');
    expect(await store.delete(A, 'b1')).toBe(false);
    expect(await store.get(B, 'b1')).not.toBeNull();
  });
});

describe('InMemoryDistributorLinkRepository, tenant deletion', () => {
  const scan = (id: string, tenantId: string): LinkDeepScan => ({
    id,
    tenantId,
    artistWorkspaceId: 'aw',
    distributorConnectionId: 'c',
    consentId: 'consent-1',
    status: 'COMPLETED',
    progressPercent: 100,
    currentStep: 'done',
    releasesFound: 1,
    tracksFound: 1,
    warningsCount: 0,
    events: [],
    snapshotId: null,
    issues: [],
    snapshot: null,
  });

  it('deleteTenant removes only that tenant’s rows', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    await repo.scans.put(A, scan('s-a', 'tenant-A'));
    await repo.scans.put(B, scan('s-b', 'tenant-B'));
    await repo.deleteTenant('tenant-A');
    expect(await repo.scans.get(A, 's-a')).toBeNull();
    expect(await repo.scans.get(B, 's-b')).not.toBeNull();
  });
});
