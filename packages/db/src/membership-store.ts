import { stableId, type Membership, type MembershipId, type TenantId, type UserId, type UserRole } from '@sentinel/core';

/**
 * Durable store for tenant memberships, the authority for cross-tenant access.
 *
 * Membership is intentionally NOT a {@link TenantStore}: it is the thing that
 * GRANTS a tenant scope, so it is keyed by (userId, tenantId) directly rather
 * than being tenant-scoped itself. The runtime Postgres adapter mirrors this
 * port; an in-memory adapter backs isolated tests.
 */
export interface MembershipStore {
  /** The authorization lookup: the caller's ACTIVE membership of a tenant, or null. */
  getActive(userId: string, tenantId: string): Promise<Membership | null>;
  /** All ACTIVE memberships for a user (the tenants they may act in). */
  listActiveForUser(userId: string): Promise<Membership[]>;
  /** All memberships for a tenant (active + invited + suspended), for the members view. */
  listForTenant(tenantId: string): Promise<Membership[]>;
  /** A pending email invitation for a tenant, matched case-insensitively, if any. */
  getPendingInvite(tenantId: string, email: string): Promise<Membership | null>;
  put(membership: Membership): Promise<Membership>;
  get(id: string): Promise<Membership | null>;
  remove(id: string): Promise<boolean>;
}

/** The personal tenant id for a user is their own subject: a solo account is a tenant of one. */
export function personalTenantId(userId: string): TenantId {
  return userId as unknown as TenantId;
}

/** Whether a tenant is a user's personal tenant (id equals the subject). */
export function isPersonalTenant(userId: string, tenantId: string): boolean {
  return tenantId === userId;
}

/** Deterministic membership id for a (user, tenant) pair, so bootstrap stays idempotent. */
export function membershipIdFor(userId: string, tenantId: string): MembershipId {
  return stableId<'MembershipId'>('mbr', userId, tenantId);
}

/**
 * Idempotently ensure a user owns their personal tenant. Safe to call on every
 * login. Existing per-user data is already keyed by the subject, so this makes
 * that data resolve as the user's personal tenant with zero migration.
 */
export async function ensurePersonalMembership(
  store: MembershipStore,
  userId: string,
  nowIso: () => string,
): Promise<Membership> {
  const tenantId = personalTenantId(userId);
  const existing = await store.getActive(userId, tenantId);
  if (existing) return existing;
  const now = nowIso();
  return store.put({
    id: membershipIdFor(userId, tenantId),
    tenantId,
    userId: userId as unknown as UserId,
    role: 'owner' as UserRole,
    status: 'active',
    invitedEmail: null,
    invitedByUserId: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Process-local membership store for isolated automated tests only.
 * @internal
 */
export class InMemoryMembershipStore implements MembershipStore {
  private readonly byId = new Map<string, Membership>();

  constructor() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('InMemoryMembershipStore is test-only; configure DATABASE_URL for runtime persistence.');
    }
  }

  async getActive(userId: string, tenantId: string): Promise<Membership | null> {
    for (const m of this.byId.values()) {
      if (m.status === 'active' && m.userId === userId && m.tenantId === tenantId) return structuredClone(m);
    }
    return null;
  }

  async listActiveForUser(userId: string): Promise<Membership[]> {
    return [...this.byId.values()]
      .filter((m) => m.status === 'active' && m.userId === userId)
      .map((m) => structuredClone(m));
  }

  async listForTenant(tenantId: string): Promise<Membership[]> {
    return [...this.byId.values()].filter((m) => m.tenantId === tenantId).map((m) => structuredClone(m));
  }

  async getPendingInvite(tenantId: string, email: string): Promise<Membership | null> {
    const lower = email.trim().toLowerCase();
    if (!lower) return null;
    for (const m of this.byId.values()) {
      if (m.status === 'invited' && m.tenantId === tenantId && (m.invitedEmail ?? '').toLowerCase() === lower) {
        return structuredClone(m);
      }
    }
    return null;
  }

  async put(membership: Membership): Promise<Membership> {
    this.byId.set(membership.id, structuredClone(membership));
    return structuredClone(membership);
  }

  async get(membershipId: string): Promise<Membership | null> {
    const m = this.byId.get(membershipId);
    return m ? structuredClone(m) : null;
  }

  async remove(membershipId: string): Promise<boolean> {
    return this.byId.delete(membershipId);
  }
}
