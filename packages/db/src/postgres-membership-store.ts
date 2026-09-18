import type { Membership, MembershipId, MembershipStatus, TenantId, UserId, UserRole } from '@sentinel/core';
import type { MembershipStore } from './membership-store';

/**
 * Durable Postgres store for tenant memberships, the authority for cross-tenant access.
 *
 * Schema creation belongs exclusively to the committed Prisma migration chain; this runtime
 * performs reads and DML only and asserts the migrated contract once before its first write, so a
 * drifted or unmigrated database fails loudly rather than silently mis-authorizing a tenant.
 */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  end?(): Promise<void>;
}

const REQUIRED_COLUMNS = new Map<string, { type: string; notNull: boolean }>([
  ['id', { type: 'text', notNull: true }],
  ['tenant_id', { type: 'text', notNull: true }],
  ['user_id', { type: 'text', notNull: false }],
  ['role', { type: 'text', notNull: true }],
  ['status', { type: 'text', notNull: true }],
  ['invited_email', { type: 'text', notNull: false }],
  ['invited_by_user_id', { type: 'text', notNull: false }],
  ['created_at', { type: 'timestamptz', notNull: true }],
  ['updated_at', { type: 'timestamptz', notNull: true }],
]);

const REQUIRED_INDEXES = new Map<string, { primary: boolean; columns: string[]; descending: boolean[] }>([
  ['memberships_pkey', { primary: true, columns: ['id'], descending: [false] }],
  ['memberships_user_status_idx', { primary: false, columns: ['user_id', 'status'], descending: [false, false] }],
  ['memberships_tenant_idx', { primary: false, columns: ['tenant_id'], descending: [false] }],
]);

/**
 * Validate the exact migrated table contract without mutating schema. The zero-row SELECT also
 * proves the runtime role can read every column the store uses; pg_catalog verifies types,
 * nullability, the conflict-target primary key, and the lookup indexes.
 */
export async function assertMembershipsSchema(pool: PgPoolLike): Promise<void> {
  await pool.query(
    `SELECT id, tenant_id, user_id, role, status, invited_email, invited_by_user_id, created_at, updated_at
     FROM memberships LIMIT 0`,
  );
  const { rows } = await pool.query(
    `SELECT 'column' AS kind, attribute.attname AS name, type.typname AS data_type,
            attribute.attnotnull AS not_null, false AS is_primary,
            NULL::text[] AS index_columns, NULL::boolean[] AS descending
       FROM pg_attribute attribute
       JOIN pg_type type ON type.oid = attribute.atttypid
      WHERE attribute.attrelid = to_regclass('memberships')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
     UNION ALL
     SELECT 'index' AS kind, index_class.relname AS name, NULL AS data_type,
            false AS not_null, idx.indisprimary AS is_primary,
            ARRAY(SELECT pg_get_indexdef(idx.indexrelid, position, true)
                    FROM generate_series(1, idx.indnkeyatts) position) AS index_columns,
            ARRAY(SELECT ((idx.indoption[position - 1] & 1) = 1)
                    FROM generate_series(1, idx.indnkeyatts) position) AS descending
       FROM pg_index idx
       JOIN pg_class index_class ON index_class.oid = idx.indexrelid
      WHERE idx.indrelid = to_regclass('memberships')`,
  );

  const missing: string[] = [];
  for (const [name, expected] of REQUIRED_COLUMNS) {
    const actual = rows.find((row) => row.kind === 'column' && row.name === name);
    if (!actual || actual.data_type !== expected.type || actual.not_null !== expected.notNull) {
      missing.push(`column ${name}:${expected.type}${expected.notNull ? ' not null' : ''}`);
    }
  }
  for (const [name, expected] of REQUIRED_INDEXES) {
    const actual = rows.find((row) => row.kind === 'index' && row.name === name);
    if (
      !actual ||
      actual.is_primary !== expected.primary ||
      JSON.stringify(actual.index_columns) !== JSON.stringify(expected.columns) ||
      JSON.stringify(actual.descending) !== JSON.stringify(expected.descending)
    ) {
      missing.push(`${expected.primary ? 'primary key' : 'index'} ${name}`);
    }
  }
  if (missing.length) throw new Error(`memberships schema is incomplete: missing or incompatible ${missing.join(', ')}`);
}

/** A timestamptz round-trips as a Date from node-postgres and as an ISO string from the fake pool. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function rowToMembership(row: Record<string, unknown>): Membership {
  return {
    id: row.id as MembershipId,
    tenantId: row.tenant_id as TenantId,
    userId: (row.user_id as string | null) as UserId | null,
    role: row.role as UserRole,
    status: row.status as MembershipStatus,
    invitedEmail: (row.invited_email as string | null) ?? null,
    invitedByUserId: (row.invited_by_user_id as string | null) as UserId | null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_COLUMNS =
  'id, tenant_id, user_id, role, status, invited_email, invited_by_user_id, created_at, updated_at';

export class PostgresMembershipStore implements MembershipStore {
  private schemaReady: Promise<void> | null = null;
  constructor(private readonly pool: PgPoolLike) {}

  /** Assert that the migration-owned table contract is present (cached per store instance). */
  async init(): Promise<void> {
    this.schemaReady ??= assertMembershipsSchema(this.pool);
    await this.schemaReady;
  }

  async getActive(userId: string, tenantId: string): Promise<Membership | null> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM memberships
        WHERE user_id = $1 AND tenant_id = $2 AND status = 'active' LIMIT 1`,
      [userId, tenantId],
    );
    return rows[0] ? rowToMembership(rows[0]) : null;
  }

  async listActiveForUser(userId: string): Promise<Membership[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM memberships
        WHERE user_id = $1 AND status = 'active' ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return rows.map(rowToMembership);
  }

  async listForTenant(tenantId: string): Promise<Membership[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM memberships
        WHERE tenant_id = $1 ORDER BY created_at ASC, id ASC`,
      [tenantId],
    );
    return rows.map(rowToMembership);
  }

  async getPendingInvite(tenantId: string, email: string): Promise<Membership | null> {
    const lower = email.trim().toLowerCase();
    if (!lower) return null;
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT ${SELECT_COLUMNS} FROM memberships
        WHERE tenant_id = $1 AND status = 'invited' AND lower(invited_email) = $2 LIMIT 1`,
      [tenantId, lower],
    );
    return rows[0] ? rowToMembership(rows[0]) : null;
  }

  async put(membership: Membership): Promise<Membership> {
    await this.init();
    // Upsert on the deterministic id. created_at is preserved on conflict (kept off the update
    // list) so a re-put of an existing membership never rewrites its original creation time.
    const { rows } = await this.pool.query(
      `INSERT INTO memberships (
         id, tenant_id, user_id, role, status, invited_email, invited_by_user_id, created_at, updated_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, user_id = EXCLUDED.user_id, role = EXCLUDED.role,
         status = EXCLUDED.status, invited_email = EXCLUDED.invited_email,
         invited_by_user_id = EXCLUDED.invited_by_user_id, updated_at = EXCLUDED.updated_at
       RETURNING ${SELECT_COLUMNS}`,
      [
        membership.id,
        membership.tenantId,
        membership.userId,
        membership.role,
        membership.status,
        membership.invitedEmail,
        membership.invitedByUserId,
        membership.createdAt,
        membership.updatedAt,
      ],
    );
    return rowToMembership(rows[0]!);
  }

  async get(id: string): Promise<Membership | null> {
    await this.init();
    const { rows } = await this.pool.query(`SELECT ${SELECT_COLUMNS} FROM memberships WHERE id = $1`, [id]);
    return rows[0] ? rowToMembership(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    await this.init();
    const result = await this.pool.query(`DELETE FROM memberships WHERE id = $1 RETURNING id`, [id]);
    return (result.rowCount ?? result.rows.length) > 0;
  }
}
