import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMembershipStore, ensurePersonalMembership } from '@sentinel/db';
import type { UserId, UserRole } from '@sentinel/core';
import {
  createTenant,
  inviteMember,
  acceptInvite,
  listMembers,
  changeRole,
  removeMember,
  type Actor,
} from './membership-service';

let clock = 0;
const nowIso = () => new Date(1_700_000_000_000 + clock++ * 1000).toISOString();

function actor(overrides: Partial<Actor> = {}): Actor {
  return { sub: 'user_owner', tenantId: 'org_acme', tenantRole: 'owner', ...overrides };
}

describe('membership-service', () => {
  let store: InMemoryMembershipStore;
  beforeEach(() => {
    clock = 0;
    store = new InMemoryMembershipStore();
  });

  it('createTenant makes the caller the owner of a fresh org', async () => {
    const owner: Actor = { sub: 'user_x', tenantId: 'user_x', tenantRole: 'owner' };
    const r = await createTenant(store, owner, nowIso);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.role).toBe('owner');
    expect(r.value.userId).toBe('user_x');
    expect(r.value.tenantId).toMatch(/^org_/);
  });

  it('inviteMember requires admin or higher and rejects viewers', async () => {
    const viewer = actor({ tenantRole: 'viewer' });
    const r = await inviteMember(store, viewer, 'org_acme', 'alice@example.com', 'member', nowIso);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('inviteMember refuses to touch a tenant the actor is not acting in', async () => {
    const r = await inviteMember(store, actor({ tenantId: 'org_acme' }), 'org_other', 'a@b.com', 'viewer', nowIso);
    expect(r).toMatchObject({ ok: false, status: 403, error: 'not acting in that tenant' });
  });

  it('inviteMember refuses invites to a personal tenant', async () => {
    const solo = actor({ sub: 'user_solo', tenantId: 'user_solo' });
    const r = await inviteMember(store, solo, 'user_solo', 'a@b.com', 'viewer', nowIso);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('only an owner may grant the owner role', async () => {
    const admin = actor({ tenantRole: 'admin' });
    expect(await inviteMember(store, admin, 'org_acme', 'a@b.com', 'owner', nowIso)).toMatchObject({ ok: false, status: 403 });
    expect((await inviteMember(store, actor(), 'org_acme', 'a@b.com', 'owner', nowIso)).ok).toBe(true);
  });

  it('inviteMember validates the email and role, and is idempotent', async () => {
    expect(await inviteMember(store, actor(), 'org_acme', 'not-an-email', 'viewer', nowIso)).toMatchObject({ ok: false, status: 400 });
    expect(await inviteMember(store, actor(), 'org_acme', 'a@b.com', 'wizard', nowIso)).toMatchObject({ ok: false, status: 400 });
    const first = await inviteMember(store, actor(), 'org_acme', 'Alice@Example.com', 'analyst', nowIso);
    const second = await inviteMember(store, actor(), 'org_acme', 'alice@example.com', 'analyst', nowIso);
    expect(first.ok && second.ok && first.value.id === second.value.id).toBe(true);
    expect(await store.listForTenant('org_acme')).toHaveLength(1);
  });

  it('acceptInvite requires a verified email and binds the invite to the account', async () => {
    await inviteMember(store, actor(), 'org_acme', 'alice@example.com', 'analyst', nowIso);
    expect(await acceptInvite(store, 'user_alice', undefined, 'org_acme', nowIso)).toMatchObject({ ok: false, status: 403 });
    expect(await acceptInvite(store, 'user_alice', 'someone-else@example.com', 'org_acme', nowIso)).toMatchObject({ ok: false, status: 404 });
    const claimed = await acceptInvite(store, 'user_alice', 'ALICE@example.com', 'org_acme', nowIso);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.value.userId).toBe('user_alice');
    expect(claimed.value.status).toBe('active');
    // Now Alice is a real member.
    expect(await store.getActive('user_alice', 'org_acme')).not.toBeNull();
  });

  it('changeRole and removeMember protect the last owner', async () => {
    await store.put({
      id: 'mbr_owner' as never,
      tenantId: 'org_acme' as never,
      userId: 'user_owner' as UserId,
      role: 'owner' as UserRole,
      status: 'active',
      invitedEmail: null,
      invitedByUserId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const owner = actor();
    expect(await changeRole(store, owner, 'org_acme', 'user_owner', 'admin', nowIso)).toMatchObject({ ok: false, status: 409 });
    expect(await removeMember(store, owner, 'org_acme', 'user_owner')).toMatchObject({ ok: false, status: 409 });
  });

  it('listMembers only works within the actor\'s resolved tenant', async () => {
    expect(await listMembers(store, actor({ tenantId: 'org_acme' }), 'org_other')).toMatchObject({ ok: false, status: 403 });
    expect((await listMembers(store, actor({ tenantId: 'org_acme' }), 'org_acme')).ok).toBe(true);
  });

  it('bootstrap + invite + accept end to end lets two users share a tenant', async () => {
    // Owner creates a shared org, invites Bob, Bob accepts, both can act in it.
    const created = await createTenant(store, { sub: 'user_owner', tenantId: 'user_owner', tenantRole: 'owner' }, nowIso);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const org = created.value.tenantId;
    const inv = await inviteMember(store, { sub: 'user_owner', tenantId: org, tenantRole: 'owner' }, org, 'bob@example.com', 'admin', nowIso);
    expect(inv.ok).toBe(true);
    await ensurePersonalMembership(store, 'user_bob', nowIso);
    const accepted = await acceptInvite(store, 'user_bob', 'bob@example.com', org, nowIso);
    expect(accepted.ok).toBe(true);
    expect(await store.getActive('user_owner', org)).not.toBeNull();
    expect(await store.getActive('user_bob', org)).not.toBeNull();
  });
});
