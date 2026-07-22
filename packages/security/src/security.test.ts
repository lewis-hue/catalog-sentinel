import { describe, it, expect } from 'vitest';
import { signPath, verifySignedPath, buildSignedDownloadUrl } from './signed-url';
import { can, requirePermission, AuthorizationError } from './rbac';
import { InMemoryAuditLogger, PostgresAuditLogger } from './audit';

describe('signed URLs', () => {
  const secret = 'download-signing-secret';
  it('verifies a valid, unexpired signature', () => {
    const params = { path: '/reports/r1.csv', expiresAtEpochMs: 2000 };
    const sig = signPath(params, secret);
    expect(verifySignedPath(params, sig, secret, 1000)).toEqual({ valid: true });
  });

  it('rejects expired and tampered signatures', () => {
    const params = { path: '/reports/r1.csv', expiresAtEpochMs: 2000 };
    const sig = signPath(params, secret);
    expect(verifySignedPath(params, sig, secret, 3000).reason).toBe('expired');
    expect(verifySignedPath(params, 'deadbeef', secret, 1000).reason).toBe('bad-signature');
  });

  it('builds a signed download URL with expiry + sig query params', () => {
    const url = buildSignedDownloadUrl('https://app.example.com', '/reports/r1.csv', 60_000, secret, 1000);
    expect(url).toContain('expires=61000');
    expect(url).toContain('sig=');
  });
});

describe('rbac', () => {
  it('grants and denies by role', () => {
    expect(can('owner', 'workspace:delete')).toBe(true);
    expect(can('viewer', 'workspace:delete')).toBe(false);
    expect(can('analyst', 'scan:run')).toBe(true);
    expect(() => requirePermission('viewer', 'scan:run')).toThrow(AuthorizationError);
  });
});

describe('audit logging', () => {
  it('records events with redacted metadata', async () => {
    const log = new InMemoryAuditLogger(() => '2026-07-07T00:00:00.000Z');
    await log.log({
      tenantId: 't1',
      action: 'connection.create',
      targetType: 'DistributorAccount',
      metadata: { provider: 'distrokid', sessionToken: 'super-secret' },
    });
    const rows = await log.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata.provider).toBe('distrokid');
    expect(rows[0]?.metadata.sessionToken).toBe('[REDACTED]');
    expect(rows[0]?.at).toBe('2026-07-07T00:00:00.000Z');
  });

  it('persists a redacted append-only event through the SQL sink', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const log = new PostgresAuditLogger({
      async query(sql, values) { calls.push({ sql, values }); return { rows: [] }; },
    }, () => '2026-07-22T10:00:00.000Z');

    const row = await log.log({
      tenantId: 'tenant-a',
      actorUserId: 'user-a',
      action: 'distributor.connect.requested',
      targetType: 'SteelSession',
      metadata: { provider: 'steel', sessionToken: 'never-store-me' },
    });

    expect(row.id).toMatch(/^audit_/);
    expect(row.metadata.sessionToken).toBe('[REDACTED]');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('INSERT INTO security_audit_events');
    expect(JSON.stringify(calls[0]?.values)).not.toContain('never-store-me');
  });
});
