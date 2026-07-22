import { Pool } from 'pg';
import type { PgPoolLike } from './postgres-search-store';

/**
 * Node-postgres pool for revision-conditional scan DML against the same canonical DATABASE_URL
 * managed by Prisma migrations. The runtime connection is never used for schema creation.
 */
export function createPgPool(url: string): Pool {
  return new Pool({ connectionString: url, max: Number(process.env.DATABASE_POOL_MAX || 5) });
}

export function asPgPoolLike(pool: Pool): PgPoolLike {
  return pool as unknown as PgPoolLike;
}
