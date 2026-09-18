import { id as makeId, type Membership, type TenantId, type UserId, type UserRole } from '@sentinel/core';
import { membershipIdFor, type MembershipStore } from '@sentinel/db';
import { tenantRoleAtLeast } from '@sentinel/security';

/**
 * Membership management: create shared tenants, invite by email, accept, and manage roles.
 * Every operation is authorized against the ACTOR's resolved membership (never a raw request
 * field), and destructive actions protect the last owner so a tenant can never be orphaned.
 */
export interface Actor {
  sub: string;
  /** The tenant the actor is currently resolved into (from tenant resolution). */
  tenantId: string;
  tenantRole: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const VALID_ROLES: readonly string[] = ['owner', 'admin', 'manager', 'analyst', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(status: number, error: string): Result<never> {
  return { ok: false, status, error };
}

/** Create a new shared tenant, owned by the caller. */
export async function createTenant(store: MembershipStore, actor: Actor, nowIso: () => string): Promise<Result<Membership>> {
  const tenantId = makeId<'TenantId'>('org');
  const now = nowIso();
  const membership = await store.put({
    id: membershipIdFor(actor.sub, tenantId),
    tenantId,
    userId: actor.sub as unknown as UserId,
    role: 'owner',
    status: 'active',
    invitedEmail: null,
    invitedByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, value: membership };
}

/** Invite a user to the actor's current tenant by email. Requires admin or higher. */
export async function inviteMember(
  store: MembershipStore,
  actor: Actor,
  tenantId: string,
  email: string,
  role: string,
  nowIso: () => string,
): Promise<Result<Membership>> {
  if (actor.tenantId !== tenantId) return fail(403, 'not acting in that tenant');
  if (tenantId === actor.sub) return fail(400, 'cannot invite members to a personal tenant; create a shared tenant first');
  if (!tenantRoleAtLeast(actor.tenantRole, 'admin')) return fail(403, 'requires tenant role: admin or higher');
  if (!VALID_ROLES.includes(role)) return fail(400, 'invalid role');
  if (role === 'owner' && actor.tenantRole !== 'owner') return fail(403, 'only an owner may grant the owner role');
  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 320) return fail(400, 'invalid email');
  const existing = await store.getPendingInvite(tenantId, normalizedEmail);
  if (existing) return { ok: true, value: existing }; // idempotent re-invite
  const now = nowIso();
  const membership = await store.put({
    id: makeId<'MembershipId'>('mbr'),
    tenantId: tenantId as unknown as TenantId,
    userId: null,
    role: role as UserRole,
    status: 'invited',
    invitedEmail: normalizedEmail,
    invitedByUserId: actor.sub as unknown as UserId,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true, value: membership };
}

/**
 * Accept a pending invitation to a tenant, binding it to the caller's verified account. The
 * email MUST come from a verified OIDC claim, never from a request body, so an invite cannot be
 * claimed by someone who does not control the invited address.
 */
export async function acceptInvite(
  store: MembershipStore,
  userSub: string,
  verifiedEmail: string | undefined,
  tenantId: string,
  nowIso: () => string,
): Promise<Result<Membership>> {
  if (!verifiedEmail) return fail(403, 'a verified email is required to accept an invitation');
  const email = verifiedEmail.trim().toLowerCase();
  const invite = await store.getPendingInvite(tenantId, email);
  if (!invite) return fail(404, 'no pending invitation for this account and tenant');
  const now = nowIso();
  const claimed = await store.put({
    ...invite,
    userId: userSub as unknown as UserId,
    status: 'active',
    invitedEmail: null,
    updatedAt: now,
  });
  return { ok: true, value: claimed };
}

/** List a tenant's memberships (members + pending invites). Any active member may view the roster. */
export async function listMembers(store: MembershipStore, actor: Actor, tenantId: string): Promise<Result<Membership[]>> {
  if (actor.tenantId !== tenantId) return fail(403, 'not acting in that tenant');
  return { ok: true, value: await store.listForTenant(tenantId) };
}

/** Change a member's role. Requires admin+, only an owner may grant owner, and the last owner cannot be demoted. */
export async function changeRole(
  store: MembershipStore,
  actor: Actor,
  tenantId: string,
  targetUserId: string,
  newRole: string,
  nowIso: () => string,
): Promise<Result<Membership>> {
  if (actor.tenantId !== tenantId) return fail(403, 'not acting in that tenant');
  if (!tenantRoleAtLeast(actor.tenantRole, 'admin')) return fail(403, 'requires tenant role: admin or higher');
  if (!VALID_ROLES.includes(newRole)) return fail(400, 'invalid role');
  if (newRole === 'owner' && actor.tenantRole !== 'owner') return fail(403, 'only an owner may grant the owner role');
  const target = await store.getActive(targetUserId, tenantId);
  if (!target) return fail(404, 'no such member');
  if (target.role === 'owner' && newRole !== 'owner' && (await countActiveOwners(store, tenantId)) <= 1) {
    return fail(409, 'cannot demote the last owner');
  }
  const updated = await store.put({ ...target, role: newRole as UserRole, updatedAt: nowIso() });
  return { ok: true, value: updated };
}

/** Remove a member. Requires admin+, and the last owner cannot be removed. */
export async function removeMember(
  store: MembershipStore,
  actor: Actor,
  tenantId: string,
  targetUserId: string,
): Promise<Result<{ removed: boolean }>> {
  if (actor.tenantId !== tenantId) return fail(403, 'not acting in that tenant');
  if (!tenantRoleAtLeast(actor.tenantRole, 'admin')) return fail(403, 'requires tenant role: admin or higher');
  const target = await store.getActive(targetUserId, tenantId);
  if (!target) return fail(404, 'no such member');
  if (target.role === 'owner' && (await countActiveOwners(store, tenantId)) <= 1) {
    return fail(409, 'cannot remove the last owner');
  }
  return { ok: true, value: { removed: await store.remove(target.id) } };
}

async function countActiveOwners(store: MembershipStore, tenantId: string): Promise<number> {
  const members = await store.listForTenant(tenantId);
  return members.filter((m) => m.status === 'active' && m.role === 'owner').length;
}
