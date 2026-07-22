import { id } from '@sentinel/core';
import type {
  CatalogResultLike,
  ReleasedTrackLike,
  SearchInput,
  SearchPage,
  SearchPageOptions,
  SearchRecord,
  SearchStore,
  SearchSummary,
} from './search-store';
import { applySearchMutation, DEFAULT_TENANT, ownerOf, revisionOf, searchRecordsEqual, toSummary, validateSearchPageOptions } from './search-store';

/**
 * Durable Postgres store for scan records — the SOURCE OF TRUTH for final results.
 * Uses the canonical DATABASE_URL via node-postgres. Schema creation belongs exclusively to
 * the committed Prisma migration chain; the application runtime performs reads and DML only.
 * The record is stored as JSONB; a few columns are denormalized for listing/filtering.
 *
 * Writes are COARSE (per platform checkpoint / terminal state), never per search query —
 * the deep-scan job calls `update` ~once per platform, so Postgres sees ~N-platform writes
 * per scan, not thousands.
 */
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
  end?(): Promise<void>;
}

const REQUIRED_COLUMNS = new Map<string, { type: string; notNull: boolean }>([
  ['id', { type: 'text', notNull: true }],
  ['tenant_id', { type: 'text', notNull: true }],
  ['owner_user_id', { type: 'text', notNull: false }],
  ['artist_workspace_id', { type: 'text', notNull: false }],
  ['artist', { type: 'text', notNull: true }],
  ['distributor', { type: 'text', notNull: true }],
  ['deep_scan_status', { type: 'text', notNull: false }],
  ['created_at', { type: 'timestamptz', notNull: true }],
  ['updated_at', { type: 'timestamptz', notNull: true }],
  ['record', { type: 'jsonb', notNull: true }],
]);

const REQUIRED_INDEXES = new Map<string, { primary: boolean; columns: string[]; descending: boolean[] }>([
  ['scan_records_pkey', { primary: true, columns: ['id'], descending: [false] }],
  ['scan_records_created_idx', { primary: false, columns: ['created_at'], descending: [true] }],
  ['scan_records_tenant_created_idx', { primary: false, columns: ['tenant_id', 'created_at'], descending: [false, true] }],
  ['scan_records_tenant_owner_created_idx', { primary: false, columns: ['tenant_id', 'owner_user_id', 'created_at'], descending: [false, false, true] }],
  ['scan_records_tenant_workspace_created_idx', { primary: false, columns: ['tenant_id', 'artist_workspace_id', 'created_at'], descending: [false, false, true] }],
]);

/**
 * Validate the exact migrated table contract without mutating schema. The zero-row SELECT also
 * proves the runtime role can read every column used by the store; pg_catalog verifies types,
 * nullability, the conflict-target primary key, and required listing indexes.
 */
export async function assertScanRecordsSchema(pool: PgPoolLike): Promise<void> {
  await pool.query(
    `SELECT id, tenant_id, owner_user_id, artist_workspace_id, artist, distributor,
            deep_scan_status, created_at, updated_at, record
     FROM scan_records LIMIT 0`,
  );
  const { rows } = await pool.query(
    `SELECT 'column' AS kind, attribute.attname AS name, type.typname AS data_type,
            attribute.attnotnull AS not_null, false AS is_primary,
            NULL::text[] AS index_columns, NULL::boolean[] AS descending
       FROM pg_attribute attribute
       JOIN pg_type type ON type.oid = attribute.atttypid
      WHERE attribute.attrelid = to_regclass('scan_records')
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
      WHERE idx.indrelid = to_regclass('scan_records')`,
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
  if (missing.length) throw new Error(`scan_records schema is incomplete: missing or incompatible ${missing.join(', ')}`);
}

export class PostgresSearchStore implements SearchStore {
  private schemaReady: Promise<void> | null = null;
  constructor(
    private readonly pool: PgPoolLike,
    /** Optional compatibility scope. Application-wide stores leave this undefined and persist
     * each record's owner; deliberately scoped stores remain available for isolated callers. */
    private readonly tenantId?: string,
  ) {}

  /** Assert that the migration-owned table contract is present (cached per store instance). */
  async init(): Promise<void> {
    this.schemaReady ??= assertScanRecordsSchema(this.pool);
    await this.schemaReady;
  }

  async save(input: SearchInput, result: CatalogResultLike, released?: ReleasedTrackLike[]): Promise<SearchRecord> {
    const tenantId = this.tenantId ?? input.tenantId ?? DEFAULT_TENANT;
    const rec: SearchRecord = {
      id: id('search'),
      revision: 1,
      tenantId,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.artistWorkspaceId ? { artistWorkspaceId: input.artistWorkspaceId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.sourceSearchId ? { sourceSearchId: input.sourceSearchId } : {}),
      createdAt: new Date().toISOString(),
      artist: input.artist,
      distributor: input.distributor,
      platforms: input.platforms ?? [],
      song: input.song ?? null,
      result,
      ...(released ? { released } : {}),
    };
    await this.upsert(rec);
    return rec;
  }

  /** Persist a full record (used by the tiered store to mirror hot state durably). */
  async upsert(rec: SearchRecord): Promise<void> {
    await this.init();
    if (this.tenantId && ownerOf(rec) !== this.tenantId) {
      throw new Error('scan record cannot be written outside the scoped tenant');
    }
    const tenantId = this.tenantId ?? ownerOf(rec);
    const owned = { ...rec, tenantId, revision: Math.max(1, revisionOf(rec)) };
    const { rows, rowCount } = await this.pool.query(
      `INSERT INTO scan_records (
         id, tenant_id, artist, distributor, deep_scan_status, created_at, updated_at, record,
         owner_user_id, artist_workspace_id
       )
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         artist = EXCLUDED.artist, distributor = EXCLUDED.distributor,
         deep_scan_status = EXCLUDED.deep_scan_status, updated_at = now(), record = EXCLUDED.record
       WHERE scan_records.tenant_id = EXCLUDED.tenant_id
         AND scan_records.owner_user_id IS NOT DISTINCT FROM EXCLUDED.owner_user_id
         AND scan_records.artist_workspace_id IS NOT DISTINCT FROM EXCLUDED.artist_workspace_id
         AND COALESCE((scan_records.record->>'revision')::bigint, 0) < $10
       RETURNING id`,
      [
        owned.id,
        tenantId,
        owned.artist,
        owned.distributor,
        owned.deepScan?.status ?? null,
        owned.createdAt,
        JSON.stringify(owned),
        owned.ownerUserId ?? null,
        owned.artistWorkspaceId ?? null,
        owned.revision,
      ],
    );
    if (rowCount !== 0 && !(rowCount == null && rows.length === 0)) return;

    // A zero-row conflict is either stale/idempotent replication or a cross-tenant overwrite.
    const existingResult = await this.pool.query(
      `SELECT tenant_id, owner_user_id, artist_workspace_id, record FROM scan_records WHERE id = $1`,
      [owned.id],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new Error('scan record durable upsert did not converge');
    if (existing.tenant_id !== tenantId) throw new Error('scan record id is already owned by another tenant');
    if ((existing.owner_user_id ?? null) !== (owned.ownerUserId ?? null)) {
      throw new Error('scan record id is already owned by another user');
    }
    if ((existing.artist_workspace_id ?? null) !== (owned.artistWorkspaceId ?? null)) {
      throw new Error('scan record id is already scoped to another artist workspace');
    }
    const persisted = existing.record as SearchRecord;
    if (revisionOf(persisted) > owned.revision) return;
    if (revisionOf(persisted) === owned.revision && searchRecordsEqual(persisted, owned)) return;
    throw new Error('conflicting search record revision');
  }

  async get(recordId: string): Promise<SearchRecord | null> {
    await this.init();
    const { rows } = this.tenantId
      ? await this.pool.query(`SELECT record FROM scan_records WHERE id = $1 AND tenant_id = $2`, [recordId, this.tenantId])
      : await this.pool.query(`SELECT record FROM scan_records WHERE id = $1`, [recordId]);
    return rows[0] ? (rows[0].record as SearchRecord) : null;
  }

  async list(): Promise<SearchSummary[]> {
    await this.init();
    const { rows } = this.tenantId
      ? await this.pool.query(`SELECT record FROM scan_records WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [this.tenantId])
      : await this.pool.query(`SELECT record FROM scan_records ORDER BY created_at DESC, id DESC LIMIT 200`);
    return rows.map((r) => toSummary(r.record as SearchRecord));
  }

  async listForTenant(tenantId: string): Promise<SearchSummary[]> {
    await this.init();
    // A deliberately scoped instance cannot be used to enumerate a different tenant.
    if (this.tenantId && this.tenantId !== tenantId) return [];
    const { rows } = await this.pool.query(
      `SELECT record FROM scan_records WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
      [tenantId],
    );
    return rows.map((r) => toSummary(r.record as SearchRecord));
  }

  async listForOwner(tenantId: string, ownerUserId: string): Promise<SearchSummary[]> {
    await this.init();
    if (this.tenantId && this.tenantId !== tenantId) return [];
    const { rows } = await this.pool.query(
      `SELECT record FROM scan_records
        WHERE tenant_id = $1 AND owner_user_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 200`,
      [tenantId, ownerUserId],
    );
    return rows.map((r) => toSummary(r.record as SearchRecord));
  }

  async pageForTenant(tenantId: string, options: SearchPageOptions): Promise<SearchPage> {
    validateSearchPageOptions(options);
    await this.init();
    if (this.tenantId && this.tenantId !== tenantId) return { items: [] };
    const params: unknown[] = [tenantId];
    const after = options.after
      ? ` AND (created_at, id) < ($2::timestamptz, $3::text)`
      : '';
    if (options.after) params.push(options.after.createdAt, options.after.id);
    params.push(options.limit + 1);
    const limitParameter = `$${params.length}`;
    const { rows } = await this.pool.query(
      `SELECT record FROM scan_records
        WHERE tenant_id = $1${after}
        ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}`,
      params,
    );
    return searchPageFromRows(rows, options.limit);
  }

  async pageForOwner(tenantId: string, ownerUserId: string, options: SearchPageOptions): Promise<SearchPage> {
    validateSearchPageOptions(options);
    await this.init();
    if (this.tenantId && this.tenantId !== tenantId) return { items: [] };
    const params: unknown[] = [tenantId, ownerUserId];
    const after = options.after
      ? ` AND (created_at, id) < ($3::timestamptz, $4::text)`
      : '';
    if (options.after) params.push(options.after.createdAt, options.after.id);
    params.push(options.limit + 1);
    const limitParameter = `$${params.length}`;
    const { rows } = await this.pool.query(
      `SELECT record FROM scan_records
        WHERE tenant_id = $1 AND owner_user_id = $2${after}
        ORDER BY created_at DESC, id DESC LIMIT ${limitParameter}`,
      params,
    );
    return searchPageFromRows(rows, options.limit);
  }

  async update(recordId: string, mutate: (r: SearchRecord) => SearchRecord): Promise<SearchRecord | null> {
    await this.init();
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await this.get(recordId);
      if (!cur) return null;
      const next = applySearchMutation(cur, mutate);
      const tenantId = this.tenantId ?? ownerOf(cur);
      const { rows, rowCount } = await this.pool.query(
        `UPDATE scan_records SET
           artist = $3, distributor = $4, deep_scan_status = $5,
           updated_at = now(), record = $6
         WHERE id = $1 AND tenant_id = $2
           AND COALESCE((record->>'revision')::bigint, 0) = $7
         RETURNING id`,
        [recordId, tenantId, next.artist, next.distributor, next.deepScan?.status ?? null, JSON.stringify(next), revisionOf(cur)],
      );
      if (rowCount !== 0 && !(rowCount == null && rows.length === 0)) return next;
    }
    throw new Error('search record changed repeatedly during durable update');
  }

  async put(rec: SearchRecord): Promise<void> {
    // Full-record replication must preserve the caller's concurrency token. Re-reading and then
    // routing through `update` would incorrectly stamp stale content with a newer revision.
    await this.upsert(rec);
  }

  async delete(recordId: string, tenantId?: string, ownerUserId?: string): Promise<boolean> {
    await this.init();
    if (this.tenantId && tenantId && this.tenantId !== tenantId) return false;
    const ownerScope = this.tenantId ?? tenantId;
    const result = ownerScope && ownerUserId
      ? await this.pool.query(
          `DELETE FROM scan_records WHERE id = $1 AND tenant_id = $2 AND owner_user_id = $3 RETURNING id`,
          [recordId, ownerScope, ownerUserId],
        )
      : ownerScope
      ? await this.pool.query(
          `DELETE FROM scan_records WHERE id = $1 AND tenant_id = $2 RETURNING id`,
          [recordId, ownerScope],
        )
      : await this.pool.query(`DELETE FROM scan_records WHERE id = $1 RETURNING id`, [recordId]);
    return (result.rowCount ?? result.rows.length) > 0;
  }
}

function searchPageFromRows(rows: Array<Record<string, unknown>>, limit: number): SearchPage {
  const items = rows.slice(0, limit).map((row) => toSummary(row.record as SearchRecord));
  return {
    items,
    ...(rows.length > limit && items.length
      ? { nextCursor: { createdAt: items[items.length - 1]!.createdAt, id: items[items.length - 1]!.id } }
      : {}),
  };
}
