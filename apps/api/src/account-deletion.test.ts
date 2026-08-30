import { afterEach, describe, expect, it } from 'vitest';
import {
  purgeUserData,
  updateKeycloakUsername,
  UsernameConflictError,
  UsernameInvalidError,
  type SqlPool,
} from './account-deletion';

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

describe('updateKeycloakUsername', () => {
  const env = {
    KEYCLOAK_BASE_URL: 'http://kc:8080',
    KEYCLOAK_REALM: 'sentinel',
    KEYCLOAK_ADMIN_USERNAME: 'admin',
    KEYCLOAK_ADMIN_PASSWORD: 'secret',
  } as unknown as NodeJS.ProcessEnv;
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  // Route the three calls updateKeycloakUsername makes: admin-token POST, user GET, user PUT.
  function install(putResult: { ok: boolean; status: number }, onPut: (body: unknown) => void = () => {}) {
    globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/protocol/openid-connect/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
      }
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ id: 'u1', username: 'old', email: 'e@x.test', enabled: true }) };
      }
      onPut(init?.body ? JSON.parse(init.body) : null);
      return putResult;
    }) as unknown as typeof fetch;
  }

  it('reads the user then writes the whole representation back with only the username changed', async () => {
    let put: Record<string, unknown> | null = null;
    install({ ok: true, status: 204 }, (b) => { put = b as Record<string, unknown>; });
    await updateKeycloakUsername(env, 'u1', 'newname');
    expect(put!.username).toBe('newname');
    expect(put!.email).toBe('e@x.test'); // other fields preserved
    expect(put!.enabled).toBe(true);
  });

  it('maps a 409 to UsernameConflictError', async () => {
    install({ ok: false, status: 409 });
    await expect(updateKeycloakUsername(env, 'u1', 'taken')).rejects.toBeInstanceOf(UsernameConflictError);
  });

  it('maps a 400 to UsernameInvalidError', async () => {
    install({ ok: false, status: 400 });
    await expect(updateKeycloakUsername(env, 'u1', 'no spaces?')).rejects.toBeInstanceOf(UsernameInvalidError);
  });
});
