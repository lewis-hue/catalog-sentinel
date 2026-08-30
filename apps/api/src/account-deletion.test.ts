import { describe, expect, it } from 'vitest';
import { purgeUserData, type SqlPool } from './account-deletion';

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]!.trim();
}

describe('purgeUserData', () => {
  it('deletes the search store + every user table inside one transaction, scoped to the user', async () => {
    const queries: string[] = [];
    const values: unknown[][] = [];
    const client = {
      query: async (sql: string, v?: readonly unknown[]) => { queries.push(firstLine(sql)); if (v) values.push([...v]); return {}; },
      release: () => {},
    };
    const pool: SqlPool = { connect: async () => client };

    await purgeUserData(pool, 'user-123');

    expect(queries[0]).toBe('BEGIN');
    expect(queries[queries.length - 1]).toBe('COMMIT');
    expect(queries.some((q) => q.includes('scan_records') && q.includes('user_id'))).toBe(true);
    expect(queries.some((q) => q.includes('"DistributorReleaseOutcome"') && q.includes('"userId"'))).toBe(true);
    expect(queries.some((q) => q.includes('"ConsentGrant"'))).toBe(true);
    expect(queries.some((q) => q.includes('"DistributorLinkRecord"'))).toBe(true);
    // Every delete is bound to the same user id.
    expect(values.every((v) => v[0] === 'user-123')).toBe(true);
  });

  it('rolls back and rethrows if any delete fails', async () => {
    const queries: string[] = [];
    let n = 0;
    const client = {
      query: async (sql: string) => { queries.push(firstLine(sql)); if (++n === 3) throw new Error('fk violation'); return {}; },
      release: () => {},
    };
    const pool: SqlPool = { connect: async () => client };

    await expect(purgeUserData(pool, 'u')).rejects.toThrow('fk violation');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });
});
