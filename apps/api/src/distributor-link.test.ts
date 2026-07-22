import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_DISCLOSURE_VERSION,
  CONSENT_PURPOSE,
  CONSENT_RETENTION_DAYS,
  InMemoryDistributorLinkRepository,
  type LinkConsent,
} from '@sentinel/db';
import { InMemoryAuditLogger } from '@sentinel/security';
import { DistributorLinkService, requiredConsentRemainingMs } from './distributor-link';

const productionEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  STEEL_SESSION_TIMEOUT_MS: String(6 * 60 * 60_000),
};

function service(
  repo = new InMemoryDistributorLinkRepository(),
  audit = new InMemoryAuditLogger(),
): DistributorLinkService {
  return new DistributorLinkService(audit, { repo, env: productionEnv });
}

function consent(overrides: Partial<LinkConsent> = {}): LinkConsent {
  return {
    id: 'consent-1',
    tenantId: 'tenant-1',
    artistWorkspaceId: 'workspace-1',
    grantedByUserId: 'user-1',
    grantedAt: new Date().toISOString(),
    purpose: CONSENT_PURPOSE,
    disclosureVersion: CONSENT_DISCLOSURE_VERSION,
    retentionDays: CONSENT_RETENTION_DAYS,
    distributor: 'distrokid',
    scope: 'distributor:read-catalog',
    provider: 'steel',
    expiresAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe('consent authority for the Steel connect flow', () => {
  it('defaults consent beyond the full immutable Steel lease and cleanup grace', async () => {
    const before = Date.now();
    const granted = await service().grantConsent(
      { tenantId: 'tenant-lease' },
      {
        artistWorkspaceId: 'workspace-lease',
        distributor: 'distrokid',
        provider: 'steel',
        ttlMinutes: 1,
        actorUserId: 'user-lease',
      },
    );
    expect(Date.parse(granted.expiresAt) - before).toBeGreaterThanOrEqual(requiredConsentRemainingMs(productionEnv));
    expect(granted).toMatchObject({
      grantedByUserId: 'user-lease',
      provider: 'steel',
      retentionDays: 30,
    });
  });

  it('binds consent to the exact tenant, workspace, provider, distributor, and subject', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    const ctx = { tenantId: 'tenant-1' };
    await repo.consents.put(ctx, consent());
    const link = service(repo);

    await expect(link.assertReadConsent(ctx, 'consent-1', {
      artistWorkspaceId: 'workspace-1',
      distributor: 'distrokid',
      provider: 'steel',
      actorUserId: 'user-1',
      minimumRemainingMs: 60_000,
    })).resolves.toMatchObject({ id: 'consent-1' });
    await expect(link.assertReadConsent(ctx, 'consent-1', {
      artistWorkspaceId: 'workspace-1',
      distributor: 'distrokid',
      provider: 'steel',
      actorUserId: 'other-user',
    })).rejects.toThrow(/not bound/i);
  });

  it('does not let an audit outage roll back durable consent revocation', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    const ctx = { tenantId: 'tenant-1' };
    await repo.consents.put(ctx, consent());
    const rejectingAudit = {
      log: vi.fn(async () => { throw new Error('audit database unavailable'); }),
      list: vi.fn(async () => []),
    };
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(new DistributorLinkService(rejectingAudit, { repo, env: productionEnv }).revokeConsent(
        ctx,
        'consent-1',
        { actorUserId: 'user-1', allowTenantAdmin: false },
      )).resolves.toBe(true);
      expect((await repo.consents.get(ctx, 'consent-1'))?.revokedAt).toBeTruthy();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('audit persistence failed'),
        expect.objectContaining({ errorType: 'Error' }),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('recovers the revoke-to-Steel cleanup crash window exactly once', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    const ctx = { tenantId: 'tenant-1' };
    await repo.consents.put(ctx, consent());
    const firstReplica = service(repo);
    const committed = await firstReplica.requestConsentRevocation(
      ctx,
      'consent-1',
      { actorUserId: 'user-1', allowTenantAdmin: false },
    );
    expect(committed?.intent.completedAt).toBeNull();

    const terminate = vi.fn(async () => 1);
    const secondReplica = service(repo);
    await expect(secondReplica.reconcileConsentRevocations(terminate)).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
      retried: 0,
      sessionsTerminated: 1,
    });
    await expect(secondReplica.reconcileConsentRevocations(terminate)).resolves.toMatchObject({ claimed: 0, completed: 0 });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('stores only a fixed error category when Steel cleanup fails', async () => {
    const repo = new InMemoryDistributorLinkRepository();
    const ctx = { tenantId: 'tenant-1' };
    await repo.consents.put(ctx, consent());
    const link = service(repo);
    await link.requestConsentRevocation(ctx, 'consent-1', { actorUserId: 'user-1', allowTenantAdmin: false });
    await expect(link.reconcileConsentRevocations(async () => {
      throw new Error('https://viewer.example/session-secret?token=do-not-store');
    })).resolves.toMatchObject({ claimed: 1, completed: 0, retried: 1 });

    const intent = await repo.getConsentRevocationIntent(ctx, 'consent-1');
    expect(intent?.lastError).toBe('consent_authority_cleanup_failed');
    expect(JSON.stringify(intent)).not.toContain('session-secret');
    expect(JSON.stringify(intent)).not.toContain('do-not-store');
  });
});
