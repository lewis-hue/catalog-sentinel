import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { EnvelopeEncryptor } from '@sentinel/security';
import { RedisConnectSessionRegistry } from './distributor-connect';

const redisUrl = process.env.REDIS_URL;
const suite = redisUrl ? describe : describe.skip;
const prefix = `sentinel:test:connect:${process.pid}:${Date.now()}`;
const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : null;
const encryptor = new EnvelopeEncryptor(Buffer.alloc(32, 19).toString('base64'));
const ALICE = { tenantId: 'tenant-1', actorUserId: 'alice', allowTenantAdmin: false } as const;

afterAll(async () => {
  if (!redis) return;
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await redis.quit();
}, 30_000);

suite('RedisConnectSessionRegistry against real Redis', () => {
  it('preserves principal ownership across restart and rejects an encrypted outer-binding mismatch', async () => {
    const now = Date.now();
    const firstReplica = new RedisConnectSessionRegistry(redis!, prefix, () => now, encryptor);
    await firstReplica.put('restart-owner', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-owner', consentId: 'consent-owner', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const restarted = new RedisConnectSessionRegistry(redis!, prefix, () => now, encryptor);
    expect(await restarted.claim(
      'restart-owner',
      { tenantId: 'tenant-1', actorUserId: 'bob', allowTenantAdmin: false },
      'confirm',
      10_000,
      { searchId: 'bob-search', createdAt: new Date(now).toISOString() },
    )).toEqual({ status: 'ownership-mismatch' });
    expect(await restarted.claim(
      'restart-owner',
      { tenantId: 'tenant-1', actorUserId: 'tenant-admin', allowTenantAdmin: true },
      'confirm',
      10_000,
      { searchId: 'admin-search', createdAt: new Date(now).toISOString() },
    )).toEqual({ status: 'ownership-mismatch' });

    await firstReplica.put('tampered-owner', {
      tenantId: 'tenant-1', ownerUserId: 'alice', artists: ['Artist'], distributor: 'distrokid',
      steelSessionId: 'remote-tamper', consentId: 'consent-tamper', artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const key = `${prefix}:tampered-owner`;
    const outer = JSON.parse((await redis!.get(key))!) as Record<string, unknown>;
    outer.ownerDigest = createHash('sha256').update('tenant-1\u0000bob').digest('hex');
    await redis!.set(key, JSON.stringify(outer), 'PX', 60_000);
    await expect(restarted.claim(
      'tampered-owner',
      { tenantId: 'tenant-1', actorUserId: 'bob', allowTenantAdmin: false },
      'confirm',
      10_000,
      { searchId: 'stolen-search', createdAt: new Date(now).toISOString() },
    )).rejects.toThrow(/authorization binding mismatch/i);
  });

  it('executes encrypted consent revocation Lua and settles only after cancellation ACKs', async () => {
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis!, prefix, () => now, encryptor);
    for (const connectId of ['one', 'two']) {
      await registry.put(connectId, {
        tenantId: 'tenant-1',
        ownerUserId: 'alice',
        artists: ['Artist'],
        distributor: 'distrokid',
        steelSessionId: `remote-${connectId}`,
        consentId: 'consent-1',
        artistWorkspaceId: 'workspace-1',
        expiresAt: new Date(now + 60_000).toISOString(),
      });
    }

    await registry.markConsentRevoked('consent-1', 'tenant-1', 60_000);
    const page = await registry.claimByConsent('consent-1', 'tenant-1', 10_000, 10);
    expect(page.claims.map((claim) => claim.connectId).sort()).toEqual(['one', 'two']);
    expect(page.claims.every((claim) => claim.action === 'cancel')).toBe(true);
    for (const claim of page.claims) {
      expect(await registry.renew(claim, 10_000)).toBe('active');
      expect(await registry.ack(claim)).toBe(true);
    }
    expect(await registry.settleConsentRevocation(page.work!)).toBe(true);
  });

  it('distinguishes a stolen token from an active claim in real Lua', async () => {
    let now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis!, prefix, () => now, encryptor);
    await registry.put('stale-claim', {
      tenantId: 'tenant-1',
      ownerUserId: 'alice',
      artists: ['Artist'],
      distributor: 'distrokid',
      steelSessionId: 'remote-stale',
      artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const first = await registry.claim('stale-claim', ALICE, 'confirm', 1_000, {
      searchId: 'stable-search', createdAt: new Date(now).toISOString(),
    });
    if (first.status !== 'claimed') throw new Error('expected initial claim');
    now += 1_001;
    const recovered = await registry.claimExpired(10, 1_000);

    expect(recovered).toHaveLength(1);
    expect(await registry.claimState(first.claim)).toBe('lost');
    expect(await registry.claimState(recovered[0]!)).toBe('active');
    expect(await registry.renew(first.claim, 1_000)).toBe('lost');
    expect(await registry.renew(recovered[0]!, 1_000)).toBe('active');
  });

  it('atomically restores an orphaned Steel handle as due cancellation work', async () => {
    const now = Date.now();
    const registry = new RedisConnectSessionRegistry(redis!, prefix, () => now, encryptor);
    await registry.restoreCancellation('orphan', {
      tenantId: 'tenant-1',
      ownerUserId: 'alice',
      artists: ['Artist'],
      distributor: 'distrokid',
      steelSessionId: 'remote-orphan',
      consentId: 'consent-orphan',
      artistWorkspaceId: 'workspace-1',
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    const recovered = await registry.claimExpired(10, 1_000);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toEqual(expect.objectContaining({ connectId: 'orphan', action: 'cancel' }));
  });
});
