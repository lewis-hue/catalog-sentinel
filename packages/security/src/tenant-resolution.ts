import type { AuthIdentity } from './keycloak-auth';

/** Header a request uses to select which tenant it is acting in. */
export const TENANT_HEADER = 'x-sentinel-tenant';

/** Minimal view of an active membership needed to resolve a tenant scope. */
export interface ActiveMembershipView {
  role: string;
}

/** Looks up the caller's ACTIVE membership of a tenant. Returns null if there is none. */
export type ActiveMembershipLookup = (userId: string, tenantId: string) => Promise<ActiveMembershipView | null>;

export type TenantResolution =
  | { ok: true; tenantId: string; tenantRole: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Resolve the tenant a request may act in.
 *
 * Invariant: the verified token proves WHO the caller is (`identity.sub`); it never proves WHICH
 * tenant they may access. The caller's personal tenant (id equal to the subject) is always theirs
 * as `owner`. Any OTHER tenant is honored only when an active Membership exists. A tenant the
 * caller is not a member of is rejected with 403, never silently downgraded to their own data.
 */
export async function resolveTenant(
  identity: AuthIdentity,
  requestedTenantId: string | null | undefined,
  lookupActiveMembership: ActiveMembershipLookup,
): Promise<TenantResolution> {
  if (!identity.authenticated) {
    return { ok: false, status: 401, error: 'authentication required' };
  }
  const sub = identity.sub;
  const requested = (requestedTenantId ?? '').trim() || sub;
  // The personal tenant (equal to the subject) is always the caller's own, as owner. No membership
  // lookup is needed, and this preserves access to data already keyed by the subject.
  if (requested === sub) {
    return { ok: true, tenantId: sub, tenantRole: 'owner' };
  }
  const membership = await lookupActiveMembership(sub, requested);
  if (!membership) {
    return { ok: false, status: 403, error: 'not a member of the requested tenant' };
  }
  return { ok: true, tenantId: requested, tenantRole: membership.role };
}

/** Extract the requested tenant from request headers. Empty/missing means "my personal tenant". */
export function requestedTenantFrom(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[TENANT_HEADER];
  const headerVal = Array.isArray(raw) ? raw[0] : raw;
  const chosen = (headerVal ?? '').trim();
  return chosen || null;
}

/** Tenant-role privilege ranking (higher grants everything a lower role can do). */
const TENANT_ROLE_RANK: Record<string, number> = { owner: 4, admin: 3, manager: 2, analyst: 1, viewer: 0 };

/** True when `role` is at least as privileged as `minimum` within a tenant. Unknown roles fail closed. */
export function tenantRoleAtLeast(role: string, minimum: string): boolean {
  const have = TENANT_ROLE_RANK[role];
  const need = TENANT_ROLE_RANK[minimum];
  if (have === undefined || need === undefined) return false;
  return have >= need;
}
