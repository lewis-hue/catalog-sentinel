import { describe, it, expect, beforeEach } from 'vitest';
import type { Membership, UserId, UserRole } from '@sentinel/core';
import {
  InMemoryMembershipStore,
  ensurePersonalMembership,
  membershipIdFor,
  personalTenantId,
  isPersonalTenant,
} from './membership-store';

let clock = 0;
const nowIso = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

function invite(overrides: Partial<Membership> = {}): Membership {
  const now = nowIso();
  return {
    id: 'mbr_invite_1' as Membership['id'],
    tenantId: 'org_acme' as Membership['tenantId'],
    userId: null,
    role: 'member' as UserRole,
    status: 'invited',
    invitedEmail: 'alice@example.com',
    invitedByUserId: 'user_owner' as UserId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('personal tenant helpers', () => {
  it('maps a user to a personal tenant equal to their subject', () => {
    expect(personalTenantId('user_abc')).toBe('user_abc');
    expect(isPersonalTenant('user_abc', 'user_abc')).toBe(true);
    expect(isPersonalTenant('user_abc', 'org_acme')).toBe(false);
  });

  it('derives a deterministic membership id for a (user, tenant) pair', () => {
    expect(membershipIdFor('u1', 't1')).toBe(membershipIdFor('u1', 't1'));
    expect(membershipIdFor('u1', 't1')).not.toBe(membershipIdFor('u1', 't2'));
    expect(membershipIdFor('u1', 't1')).toMatch(/^mbr_[0-9a-f]{24}$/);
  });
});

describe('ensurePersonalMembership', () => {
  let store: InMemoryMembershipStore;
  beforeEach(() => {
    clock = 0;
    store = new InMemoryMembershipStore();
  });

  it('creates an owner membership of the personal tenant on first call', async () => {
    const m = await ensurePersonalMembership(store, 'user_solo', nowIso);
    expect(m.tenantId).toBe('user_solo');
    expect(m.userId).toBe('user_solo');
    expect(m.role).toBe('owner');
    expect(m.status).toBe('active');
  });

  it('is idempotent: a second call returns the same membership, not a duplicate', async () => {
    const first = await ensurePersonalMembership(store, 'user_solo', nowIso);
    const second = await ensurePersonalMembership(store, 'user_solo', nowIso);
    expect(second.id).toBe(first.id);
    expect(await store.listForTenant('user_solo')).toHaveLength(1);
  });
});

describe('InMemoryMembershipStore isolation', () => {
  let store: InMemoryMembershipStore;
  beforeEach(() => {
    clock = 0;
    store = new InMemoryMembershipStore();
  });

  it('getActive only returns an active membership for the exact (user, tenant)', async () => {
    await ensurePersonalMembership(store, 'user_a', nowIso);
    await store.put({
      id: membershipIdFor('user_a', 'org_acme'),
      tenantId: 'org_acme' as Membership['tenantId'],
      userId: 'user_a' as UserId,
      role: 'admin' as UserRole,
      status: 'active',
      invitedEmail: null,
      invitedByUserId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    expect(await store.getActive('user_a', 'org_acme')).not.toBeNull();
    // A different user is NOT a member of org_acme.
    expect(await store.getActive('user_b', 'org_acme')).toBeNull();
    // The user is not a member of some other org.
    expect(await store.getActive('user_a', 'org_other')).toBeNull();
  });

  it('a suspended membership grants nothing', async () => {
    await store.put({
      id: membershipIdFor('user_a', 'org_acme'),
      tenantId: 'org_acme' as Membership['tenantId'],
      userId: 'user_a' as UserId,
      role: 'admin' as UserRole,
      status: 'suspended',
      invitedEmail: null,
      invitedByUserId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(await store.getActive('user_a', 'org_acme')).toBeNull();
    expect(await store.listActiveForUser('user_a')).toHaveLength(0);
  });

  it('finds a pending invite by tenant + email (case-insensitive), never as active', async () => {
    await store.put(invite());
    expect(await store.getPendingInvite('org_acme', 'ALICE@example.com')).not.toBeNull();
    expect(await store.getPendingInvite('org_acme', 'bob@example.com')).toBeNull();
    // An invite is not an active membership for anyone yet.
    expect(await store.listActiveForUser('user_owner')).toHaveLength(0);
  });
});
