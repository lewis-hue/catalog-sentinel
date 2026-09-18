import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaDistributorLinkRepository } from './prisma-distributor-link-repo';
import { CrossTenantError, type TenantContext } from './tenant-repo';
import type { LinkConsent, LinkDeepScan } from './distributor-link-repo';

/**
 * Postgres integration test for the Prisma persistence adapter. GATED behind
 * DATABASE_URL so it never runs (or fails) in the default unit-test run, CI/local
 * `vitest` stays green with no database. To run it:
 *
 *   docker compose up -d postgres
 *   npm -w @sentinel/db run db:generate
 *   DATABASE_URL=postgres://... npm -w @sentinel/db run db:migrate:deploy
 *   DATABASE_URL=postgres://... npx vitest run prisma-distributor-link-repo.integration
 *
 * It proves the SAME cross-tenant guarantee the in-memory adapter has (tenant A can
 * never see tenant B's rows) holds against real Postgres, plus CRUD + tenant wipe.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const A: TenantContext = { tenantId: 'itest-tenant-A' };
const B: TenantContext = { tenantId: 'itest-tenant-B' };

const consent = (id: string, tenantId: string): LinkConsent => ({
  id,
  tenantId,
  artistWorkspaceId: 'aw',
  grantedByUserId: 'alice',
  distributor: 'distrokid',
  scope: 'distributor:read-catalog',
  provider: 'steel',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  revokedAt: null,
});

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
  tracksFound: 3,
  warningsCount: 0,
  events: [],
  snapshotId: null,
  issues: [],
  snapshot: null,
});

describe.skipIf(!hasDb)('PrismaDistributorLinkRepository, Postgres integration', () => {
  let repo: PrismaDistributorLinkRepository;
  let client: { $disconnect: () => Promise<void> };

  beforeAll(async () => {
    const mod = (await import('@prisma/client' as string)) as { PrismaClient: new () => never };
    client = new mod.PrismaClient() as unknown as { $disconnect: () => Promise<void> };
    repo = new PrismaDistributorLinkRepository(client as never);
    // Clean slate for the test tenants (idempotent across reruns).
    await repo.deleteTenant(A.tenantId);
    await repo.deleteTenant(B.tenantId);
  });

  afterAll(async () => {
    if (!repo) return;
    await repo.deleteTenant(A.tenantId);
    await repo.deleteTenant(B.tenantId);
    await client.$disconnect();
  });

  it('round-trips put → get → update → delete for a tenant', async () => {
    await repo.consents.put(A, consent('c-a', A.tenantId));
    expect((await repo.consents.get(A, 'c-a'))?.scope).toBe('distributor:read-catalog');

    await repo.consents.update(A, 'c-a', { scope: 'changed' });
    expect((await repo.consents.get(A, 'c-a'))?.scope).toBe('changed');

    expect(await repo.consents.delete(A, 'c-a')).toBe(true);
    expect(await repo.consents.get(A, 'c-a')).toBeNull();
  });

  it('refuses to write a row under the wrong tenant context', async () => {
    await expect(repo.consents.put(A, consent('c-x', B.tenantId))).rejects.toThrow(CrossTenantError);
  });

  it('never returns another tenant’s row across kinds', async () => {
    await repo.scans.put(B, scan('s-b', B.tenantId));
    // Tenant A cannot read it, update it, or delete it.
    expect(await repo.scans.get(A, 's-b')).toBeNull();
    expect(await repo.scans.update(A, 's-b', { status: 'HACKED' })).toBeNull();
    expect(await repo.scans.delete(A, 's-b')).toBe(false);
    // Owner still sees the untouched original.
    expect((await repo.scans.get(B, 's-b'))?.status).toBe('COMPLETED');
  });

  it('deleteTenant wipes only that tenant’s rows across every kind', async () => {
    await repo.consents.put(A, consent('c-a2', A.tenantId));
    await repo.scans.put(A, scan('s-a2', A.tenantId));
    await repo.consents.put(B, consent('c-b2', B.tenantId));

    await repo.deleteTenant(A.tenantId);

    expect(await repo.consents.get(A, 'c-a2')).toBeNull();
    expect(await repo.scans.get(A, 's-a2')).toBeNull();
    expect((await repo.consents.get(B, 'c-b2'))?.id).toBe('c-b2');
  });

  it('atomically commits revoke + intent and rolls the revoke back if intent insertion fails', async () => {
    await repo.consents.put(A, consent('c-atomic-ok', A.tenantId));
    const committed = await repo.revokeConsentAndCreateIntent(A, 'c-atomic-ok', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false });
    expect(committed).not.toBeNull();
    expect((await repo.consents.get(A, 'c-atomic-ok'))?.revokedAt).toBeTruthy();
    expect(await repo.getConsentRevocationIntent(A, 'c-atomic-ok')).toMatchObject({
      consentId: 'c-atomic-ok',
      completedAt: null,
    });
    const committedClaim = (await repo.claimConsentRevocationIntents({
      now: new Date().toISOString(), leaseMs: 30_000, limit: 1, intentId: committed!.intent.id,
    }))[0]!;
    expect(await repo.completeConsentRevocationIntent(
      committedClaim.id,
      committedClaim.leaseToken,
      new Date().toISOString(),
    )).toBe(true);

    // A revocation intent must reference a real consent id; the migration CHECK
    // (ConsentRevocationIntent_consentId_nonempty) rejects an empty one. Since revoke + outbox is
    // one SQL statement, the JSON UPDATE preceding the rejected INSERT must roll back as well.
    await repo.consents.put(A, consent('', A.tenantId));
    await expect(
      repo.revokeConsentAndCreateIntent(A, '', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false }),
    ).rejects.toThrow();
    expect((await repo.consents.get(A, ''))?.revokedAt).toBeNull();
    expect(await repo.getConsentRevocationIntent(A, '')).toBeNull();
  });

  it('authorizes owner/admin revocation inside the same atomic SQL statement', async () => {
    await repo.consents.put(A, consent('c-owner-guard', A.tenantId));

    expect(await repo.revokeConsentAndCreateIntent(
      A,
      'c-owner-guard',
      new Date().toISOString(),
      { actorUserId: 'bob', allowTenantAdmin: false },
    )).toBeNull();
    expect((await repo.consents.get(A, 'c-owner-guard'))?.revokedAt).toBeNull();
    expect(await repo.getConsentRevocationIntent(A, 'c-owner-guard')).toBeNull();

    expect(await repo.revokeConsentAndCreateIntent(
      A,
      'c-owner-guard',
      new Date().toISOString(),
      { actorUserId: 'tenant-admin', allowTenantAdmin: true },
    )).not.toBeNull();
    expect((await repo.consents.get(A, 'c-owner-guard'))?.revokedAt).toBeTruthy();
  });

  it('recovers a committed intent from a new repository instance after the crash window', async () => {
    await repo.consents.put(A, consent('c-crash-recovery', A.tenantId));
    const committed = await repo.revokeConsentAndCreateIntent(A, 'c-crash-recovery', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false });
    expect(committed?.intent.completedAt).toBeNull();

    // Simulate the request process disappearing before Steel cleanup: a fresh Prisma client can
    // lease the durable row and acknowledge it without any state from the first process.
    const mod = (await import('@prisma/client' as string)) as { PrismaClient: new () => never };
    const recoveryClient = new mod.PrismaClient() as unknown as { $disconnect: () => Promise<void> };
    const recoveryRepo = new PrismaDistributorLinkRepository(recoveryClient as never);
    try {
      const claimed = await recoveryRepo.claimConsentRevocationIntents({
        now: new Date().toISOString(), leaseMs: 30_000, limit: 1, intentId: committed!.intent.id,
      });
      expect(claimed).toHaveLength(1);
      expect(await recoveryRepo.completeConsentRevocationIntent(
        claimed[0]!.id,
        claimed[0]!.leaseToken,
        new Date().toISOString(),
      )).toBe(true);
      expect((await repo.getConsentRevocationIntent(A, 'c-crash-recovery'))?.completedAt).toBeTruthy();
    } finally {
      await recoveryClient.$disconnect();
    }
  });

  it('leases due intents once across replicas with SKIP LOCKED', async () => {
    await repo.consents.put(A, consent('c-lease-1', A.tenantId));
    await repo.consents.put(A, consent('c-lease-2', A.tenantId));
    await repo.revokeConsentAndCreateIntent(A, 'c-lease-1', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false });
    await repo.revokeConsentAndCreateIntent(A, 'c-lease-2', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false });

    const mod = (await import('@prisma/client' as string)) as { PrismaClient: new () => never };
    const secondaryClient = new mod.PrismaClient() as unknown as { $disconnect: () => Promise<void> };
    const secondary = new PrismaDistributorLinkRepository(secondaryClient as never);
    try {
      const now = new Date().toISOString();
      const [left, right] = await Promise.all([
        repo.claimConsentRevocationIntents({ now, leaseMs: 30_000, limit: 1 }),
        secondary.claimConsentRevocationIntents({ now, leaseMs: 30_000, limit: 1 }),
      ]);
      expect(left).toHaveLength(1);
      expect(right).toHaveLength(1);
      expect(new Set([left[0]!.id, right[0]!.id]).size).toBe(2);
      expect(await repo.completeConsentRevocationIntent(left[0]!.id, left[0]!.leaseToken, new Date().toISOString())).toBe(true);
      expect(await secondary.completeConsentRevocationIntent(right[0]!.id, right[0]!.leaseToken, new Date().toISOString())).toBe(true);
    } finally {
      await secondaryClient.$disconnect();
    }
  });

  it('uses lease-token CAS for retry, reclaim, and completion', async () => {
    await repo.consents.put(B, consent('c-cas', B.tenantId));
    const write = await repo.revokeConsentAndCreateIntent(B, 'c-cas', new Date().toISOString(), { actorUserId: 'alice', allowTenantAdmin: false });
    expect(write).not.toBeNull();
    const now = new Date();
    const first = (await repo.claimConsentRevocationIntents({
      now: now.toISOString(), leaseMs: 30_000, limit: 1, intentId: write!.intent.id,
    }))[0]!;

    expect(await repo.completeConsentRevocationIntent(first.id, 'wrong-token', now.toISOString())).toBe(false);
    expect(await repo.retryConsentRevocationIntent(first.id, 'wrong-token', 0, 'wrong owner')).toBe(false);
    expect(await repo.retryConsentRevocationIntent(first.id, first.leaseToken, 0, 'transient failure')).toBe(true);

    const second = (await repo.claimConsentRevocationIntents({
      now: new Date(now.getTime() + 1).toISOString(), leaseMs: 30_000, limit: 1, intentId: first.id,
    }))[0]!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await repo.completeConsentRevocationIntent(second.id, first.leaseToken, new Date().toISOString())).toBe(false);
    expect(await repo.completeConsentRevocationIntent(second.id, second.leaseToken, new Date().toISOString())).toBe(true);
    expect((await repo.getConsentRevocationIntent(B, 'c-cas'))?.completedAt).toBeTruthy();
  });
});
