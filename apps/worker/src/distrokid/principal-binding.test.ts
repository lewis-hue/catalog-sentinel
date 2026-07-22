import { describe, expect, it } from 'vitest';
import {
  CONSENT_DISCLOSURE_VERSION,
  CONSENT_PURPOSE,
  CONSENT_RETENTION_DAYS,
  InMemoryDistributorLinkRepository,
} from '@sentinel/db';
import { InMemorySearchStore } from '@sentinel/search-store';
import { assertSnapshotPrincipalBinding, snapshotPrincipalBindingValid } from './principal-binding';

const NOW = Date.parse('2026-07-22T12:00:00.000Z');

async function fixture() {
  const store = new InMemorySearchStore();
  const repository = new InMemoryDistributorLinkRepository();
  const record = await store.save(
    {
      tenantId: 'tenant-a', ownerUserId: 'alice', artistWorkspaceId: 'workspace-a',
      artist: 'Alice Artist', distributor: 'distrokid', platforms: [],
    },
    {
      artist: 'Alice Artist', stores: [], profiles: [], tracks: [],
      summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 },
      generatedAt: '2026-07-22T11:00:00.000Z', warnings: ['__reading_in_progress__'], note: 'reading',
    },
    [],
  );
  await repository.consents.put({ tenantId: 'tenant-a' }, {
    id: 'consent-a', tenantId: 'tenant-a', artistWorkspaceId: 'workspace-a',
    grantedByUserId: 'alice', grantedAt: '2026-07-22T11:00:00.000Z',
    purpose: CONSENT_PURPOSE, disclosureVersion: CONSENT_DISCLOSURE_VERSION,
    retentionDays: CONSENT_RETENTION_DAYS, distributor: 'distrokid',
    scope: 'distributor:read-catalog', provider: 'steel',
    expiresAt: '2026-07-22T18:00:00.000Z', revokedAt: null,
  });
  return {
    store,
    repository,
    job: {
      tenantId: 'tenant-a', snapshotId: record.id, consentId: 'consent-a',
      artistWorkspaceId: 'workspace-a', distributor: 'distrokid',
    },
  };
}

describe('DistroKid snapshot principal binding', () => {
  it('accepts only a matching tenant, record owner, workspace, and active consent subject', async () => {
    const { store, repository, job } = await fixture();
    await expect(snapshotPrincipalBindingValid(store, repository, job, NOW)).resolves.toBe(true);
    await expect(assertSnapshotPrincipalBinding(store, repository, job, NOW)).resolves.toBeUndefined();
  });

  it('rejects a consent granted by another same-tenant subject', async () => {
    const { store, repository, job } = await fixture();
    const consent = await repository.consents.get({ tenantId: 'tenant-a' }, 'consent-a');
    await repository.consents.put({ tenantId: 'tenant-a' }, { ...consent!, grantedByUserId: 'bob' });
    await expect(snapshotPrincipalBindingValid(store, repository, job, NOW)).resolves.toBe(false);
  });

  it('rejects workspace or tenant substitution before projection', async () => {
    const { store, repository, job } = await fixture();
    await expect(snapshotPrincipalBindingValid(
      store, repository, { ...job, artistWorkspaceId: 'workspace-b' }, NOW,
    )).resolves.toBe(false);
    await expect(assertSnapshotPrincipalBinding(
      store, repository, { ...job, tenantId: 'tenant-b' }, NOW,
    )).rejects.toMatchObject({ name: 'SnapshotPrincipalBindingError' });
  });

  it('fails closed for legacy ownerless records and revoked grants', async () => {
    const { store, repository, job } = await fixture();
    const current = await store.get(job.snapshotId);
    const { ownerUserId: _legacyOwner, ...legacy } = current!;
    await store.put({ ...legacy, id: 'legacy-ownerless', revision: 1 });
    await expect(snapshotPrincipalBindingValid(
      store, repository, { ...job, snapshotId: 'legacy-ownerless' }, NOW,
    )).resolves.toBe(false);

    const fresh = await fixture();
    await fresh.repository.consents.update(
      { tenantId: 'tenant-a' }, 'consent-a', { revokedAt: '2026-07-22T11:30:00.000Z' },
    );
    await expect(snapshotPrincipalBindingValid(fresh.store, fresh.repository, fresh.job, NOW)).resolves.toBe(false);
  });
});
