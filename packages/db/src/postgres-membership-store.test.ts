import { describe, it, expect } from 'vitest';
import type { Membership, MembershipId, TenantId, UserId, UserRole } from '@sentinel/core';
import { PostgresMembershipStore, type PgPoolLike } from './postgres-membership-store';

type Row = Record<string, unknown>;

/** Fake pg pool emulating the memberships table with a Map, matching the store's exact SQL. */
class FakePg implements PgPoolLike {
  rows = new Map<string, Row>();
  queryTexts: string[] = [];
  schemaProbeCalls = 0;
  schemaRows: Row[] = [
    ...[
      ['id', 'text', true],
      ['tenant_id', 'text', true],
      ['user_id', 'text', false],
      ['role', 'text', true],
      ['status', 'text', true],
      ['invited_email', 'text', false],
      ['invited_by_user_id', 'text', false],
      ['created_at', 'timestamptz', true],
      ['updated_at', 'timestamptz', true],
    ].map(([name, data_type, not_null]) => ({ kind: 'column', name, data_type, not_null, is_primary: false })),
    { kind: 'index', name: 'memberships_pkey', data_type: null, not_null: false, is_primary: true, index_columns: ['id'], descending: [false] },
    { kind: 'index', name: 'memberships_user_status_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['user_id', 'status'], descending: [false, false] },
    { kind: 'index', name: 'memberships_tenant_idx', data_type: null, not_null: false, is_primary: false, index_columns: ['tenant_id'], descending: [false] },
  ];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount?: number | null }> {
    this.queryTexts.push(text);
    if (/\b(?:CREATE|ALTER|DROP)\b/i.test(text)) throw new Error('runtime DDL is forbidden');
    if (text.includes('FROM memberships LIMIT 0')) { this.schemaProbeCalls++; return { rows: [] }; }
    if (text.includes('FROM pg_attribute')) { this.schemaProbeCalls++; return { rows: this.schemaRows }; }
    if (text.includes('INSERT INTO memberships')) {
      const row: Row = {
        id: params[0], tenant_id: params[1], user_id: params[2], role: params[3], status: params[4],
        invited_email: params[5], invited_by_user_id: params[6], created_at: params[7], updated_at: params[8],
      };
      const existing = this.rows.get(row.id as string);
      // ON CONFLICT preserves the original created_at.
      if (existing) row.created_at = existing.created_at;
      this.rows.set(row.id as string, row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('DELETE FROM memberships')) {
      const existed = this.rows.delete(params[0] as string);
      return { rows: existed ? [{ id: params[0] }] : [], rowCount: existed ? 1 : 0 };
    }
    if (text.includes('WHERE id = $1')) {
      const row = this.rows.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    if (text.includes("status = 'active' LIMIT 1")) {
      for (const row of this.rows.values()) {
        if (row.user_id === params[0] && row.tenant_id === params[1] && row.status === 'active') return { rows: [row] };
      }
      return { rows: [] };
    }
    if (text.includes("WHERE user_id = $1 AND status = 'active'")) {
      const matches = [...this.rows.values()].filter((r) => r.user_id === params[0] && r.status === 'active');
      return { rows: matches };
    }
    if (text.includes('WHERE tenant_id = $1 ORDER BY')) {
      return { rows: [...this.rows.values()].filter((r) => r.tenant_id === params[0]) };
    }
    if (text.includes("status = 'invited' AND lower(invited_email)")) {
      for (const row of this.rows.values()) {
        if (row.tenant_id === params[0] && row.status === 'invited' && String(row.invited_email ?? '').toLowerCase() === params[1]) {
          return { rows: [row] };
        }
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function membership(overrides: Partial<Membership> = {}): Membership {
  return {
    id: 'mbr_1' as MembershipId,
    tenantId: 'org_acme' as TenantId,
    userId: 'user_a' as UserId,
    role: 'owner' as UserRole,
    status: 'active',
    invitedEmail: null,
    invitedByUserId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PostgresMembershipStore', () => {
  it('validates the migrated schema once, never runs DDL, and round-trips a membership', async () => {
    const pg = new FakePg();
    const store = new PostgresMembershipStore(pg);
    expect(pg.queryTexts).toHaveLength(0); // construction has no database side effects

    const put = await store.put(membership());
    expect(put.tenantId).toBe('org_acme');
    expect(await store.getActive('user_a', 'org_acme')).not.toBeNull();
    expect((await store.get('mbr_1'))?.role).toBe('owner');
    expect(pg.schemaProbeCalls).toBe(2); // schema asserted exactly once
    expect(pg.queryTexts.every((text) => !/\b(?:CREATE|ALTER|DROP)\b/i.test(text))).toBe(true);
  });

  it('fails before DML when a required migrated index is absent', async () => {
    const pg = new FakePg();
    pg.schemaRows = pg.schemaRows.filter((row) => row.name !== 'memberships_user_status_idx');
    const store = new PostgresMembershipStore(pg);
    await expect(store.put(membership())).rejects.toThrow(/schema is incomplete.*memberships_user_status_idx/i);
    expect(pg.queryTexts.some((text) => text.includes('INSERT INTO'))).toBe(false);
  });

  it('scopes getActive to the (user, tenant) pair and ignores non-active rows', async () => {
    const store = new PostgresMembershipStore(new FakePg());
    await store.put(membership({ id: 'mbr_a' as MembershipId, userId: 'user_a' as UserId }));
    await store.put(membership({ id: 'mbr_b' as MembershipId, userId: 'user_b' as UserId, status: 'suspended' }));

    expect(await store.getActive('user_a', 'org_acme')).not.toBeNull();
    expect(await store.getActive('user_b', 'org_acme')).toBeNull(); // suspended grants nothing
    expect(await store.getActive('user_c', 'org_acme')).toBeNull(); // no membership
  });

  it('lists only active memberships for a user and the full roster for a tenant', async () => {
    const store = new PostgresMembershipStore(new FakePg());
    await store.put(membership({ id: 'mbr_owner' as MembershipId, userId: 'user_a' as UserId, role: 'owner' as UserRole }));
    await store.put(membership({ id: 'mbr_inv' as MembershipId, userId: null, status: 'invited', invitedEmail: 'bob@example.com', role: 'admin' as UserRole }));

    expect((await store.listActiveForUser('user_a')).map((m) => m.id)).toEqual(['mbr_owner']);
    expect((await store.listForTenant('org_acme')).map((m) => m.id).sort()).toEqual(['mbr_inv', 'mbr_owner']);
  });

  it('matches a pending invite case-insensitively and preserves created_at on re-put', async () => {
    const store = new PostgresMembershipStore(new FakePg());
    await store.put(membership({
      id: 'mbr_inv' as MembershipId, userId: null, status: 'invited',
      invitedEmail: 'Alice@Example.com', createdAt: '2026-08-01T00:00:00.000Z',
    }));
    expect(await store.getPendingInvite('org_acme', 'alice@example.com')).not.toBeNull();
    expect(await store.getPendingInvite('org_acme', 'nobody@example.com')).toBeNull();

    // Accepting the invite re-puts with the same id and a later updated_at; created_at is preserved.
    const claimed = await store.put(membership({
      id: 'mbr_inv' as MembershipId, userId: 'user_alice' as UserId, status: 'active',
      invitedEmail: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }));
    expect(claimed.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(claimed.status).toBe('active');
  });

  it('removes a membership and reports whether a row was deleted', async () => {
    const store = new PostgresMembershipStore(new FakePg());
    await store.put(membership({ id: 'mbr_x' as MembershipId }));
    expect(await store.remove('mbr_x')).toBe(true);
    expect(await store.remove('mbr_x')).toBe(false);
    expect(await store.get('mbr_x')).toBeNull();
  });
});
