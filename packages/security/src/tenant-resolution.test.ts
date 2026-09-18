import { describe, it, expect } from 'vitest';
import type { AuthIdentity } from './keycloak-auth';
import {
  resolveTenant,
  requestedTenantFrom,
  tenantRoleAtLeast,
  TENANT_HEADER,
  type ActiveMembershipLookup,
} from './tenant-resolution';

function identity(overrides: Partial<AuthIdentity> = {}): AuthIdentity {
  return {
    sub: 'user_alice',
    tenantId: 'user_alice',
    tenantRole: 'owner',
    roles: ['user'],
    emailVerified: true,
    authenticated: true,
    ...overrides,
  };
}

const noMemberships: ActiveMembershipLookup = async () => null;

describe('resolveTenant', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const r = await resolveTenant(identity({ authenticated: false }), 'org_acme', noMemberships);
    expect(r).toEqual({ ok: false, status: 401, error: 'authentication required' });
  });

  it('defaults to the personal tenant (owner) when no tenant is requested', async () => {
    expect(await resolveTenant(identity(), null, noMemberships)).toEqual({
      ok: true,
      tenantId: 'user_alice',
      tenantRole: 'owner',
    });
  });

  it('grants the personal tenant as owner without any membership lookup', async () => {
    let called = false;
    const lookup: ActiveMembershipLookup = async () => {
      called = true;
      return null;
    };
    expect(await resolveTenant(identity(), 'user_alice', lookup)).toEqual({
      ok: true,
      tenantId: 'user_alice',
      tenantRole: 'owner',
    });
    expect(called).toBe(false);
  });

  it('honors a shared tenant only with an active membership, carrying its role', async () => {
    const lookup: ActiveMembershipLookup = async (u, t) =>
      u === 'user_alice' && t === 'org_acme' ? { role: 'admin' } : null;
    expect(await resolveTenant(identity(), 'org_acme', lookup)).toEqual({
      ok: true,
      tenantId: 'org_acme',
      tenantRole: 'admin',
    });
  });

  it('rejects a shared tenant the caller is not a member of with 403, never downgrading to their own data', async () => {
    const r = await resolveTenant(identity(), 'org_acme', noMemberships);
    expect(r).toEqual({ ok: false, status: 403, error: 'not a member of the requested tenant' });
    // Critically, it does NOT silently fall back to tenantId = sub (which would mask the error).
    expect((r as { tenantId?: string }).tenantId).toBeUndefined();
  });

  it("does not let user A act in user B's personal tenant", async () => {
    // Alice requests Bob's personal tenant (id equals user_bob). She has no membership of it.
    const r = await resolveTenant(identity({ sub: 'user_alice' }), 'user_bob', noMemberships);
    expect(r.ok).toBe(false);
    expect((r as { status: number }).status).toBe(403);
  });
});

describe('tenantRoleAtLeast', () => {
  it('ranks owner > admin > manager > analyst > viewer', () => {
    expect(tenantRoleAtLeast('owner', 'admin')).toBe(true);
    expect(tenantRoleAtLeast('admin', 'admin')).toBe(true);
    expect(tenantRoleAtLeast('viewer', 'admin')).toBe(false);
    expect(tenantRoleAtLeast('manager', 'viewer')).toBe(true);
  });
  it('fails closed on unknown roles', () => {
    expect(tenantRoleAtLeast('superuser', 'viewer')).toBe(false);
    expect(tenantRoleAtLeast('owner', 'godmode')).toBe(false);
  });
});

describe('requestedTenantFrom', () => {
  it('reads the tenant header, trimming whitespace', () => {
    expect(requestedTenantFrom({ [TENANT_HEADER]: '  org_acme  ' })).toBe('org_acme');
  });
  it('returns null when the header is missing or empty', () => {
    expect(requestedTenantFrom({})).toBeNull();
    expect(requestedTenantFrom({ [TENANT_HEADER]: '   ' })).toBeNull();
  });
  it('takes the first value when the header repeats', () => {
    expect(requestedTenantFrom({ [TENANT_HEADER]: ['org_a', 'org_b'] })).toBe('org_a');
  });
});
