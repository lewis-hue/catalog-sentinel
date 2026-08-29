import { describe, it, expect } from 'vitest';
import { HealthChecker } from './health';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

const okRedis = { ping: async () => 'PONG', get: async () => String(Date.now()) } as unknown as Redis;
const downRedis = { ping: async () => { throw new Error('conn refused'); }, get: async () => null } as unknown as Redis;
const healthySchemaRows: Array<Record<string, unknown>> = [
  ...[
    ['id', 'text', true],
    ['tenant_id', 'text', true],
    ['owner_user_id', 'text', false],
    ['artist_workspace_id', 'text', false],
    ['artist', 'text', true],
    ['distributor', 'text', true],
    ['deep_scan_status', 'text', false],
    ['created_at', 'timestamptz', true],
    ['updated_at', 'timestamptz', true],
    ['record', 'jsonb', true],
  ].map(([name, data_type, not_null]) => ({ kind: 'column', name, data_type, not_null, is_primary: false })),
  { kind: 'index', name: 'scan_records_pkey', is_primary: true, index_columns: ['id'], descending: [false] },
  { kind: 'index', name: 'scan_records_created_idx', is_primary: false, index_columns: ['created_at'], descending: [true] },
  { kind: 'index', name: 'scan_records_tenant_created_idx', is_primary: false, index_columns: ['tenant_id', 'created_at'], descending: [false, true] },
  { kind: 'index', name: 'scan_records_tenant_owner_created_idx', is_primary: false, index_columns: ['tenant_id', 'owner_user_id', 'created_at'], descending: [false, false, true] },
  { kind: 'index', name: 'scan_records_tenant_workspace_created_idx', is_primary: false, index_columns: ['tenant_id', 'artist_workspace_id', 'created_at'], descending: [false, false, true] },
];
const pgWithSchema = (schemaRows = healthySchemaRows): Pool => ({
  query: async (text: string) => ({
    rows: text.includes('FROM pg_attribute')
      ? schemaRows
      : text.includes("to_regclass('public.security_audit_events')")
        ? [{ complete: true }]
        : [],
  }),
}) as unknown as Pool;
const okPg = pgWithSchema();
const downPg = { query: async () => { throw new Error('ECONNREFUSED'); } } as unknown as Pool;
// The health check only needs queue DEPTH, so the fake is just that, no `as unknown as Queue`
// cast pretending a whole BullMQ Queue exists just to read five numbers off it.
const okCounts = async (): Promise<Record<string, number>> => ({ active: 0, waiting: 1, completed: 5, failed: 0, delayed: 0 });

describe('HealthChecker', () => {
  it('redis: ok / down / disabled', async () => {
    expect((await new HealthChecker({ redis: okRedis }).redis()).status).toBe('ok');
    expect((await new HealthChecker({ redis: downRedis }).redis()).status).toBe('down');
    expect((await new HealthChecker({ redis: null }).redis()).status).toBe('disabled');
  });

  it('scan-postgres: ok / down / disabled', async () => {
    expect((await new HealthChecker({ pgPool: okPg }).scanPostgres()).status).toBe('ok');
    expect((await new HealthChecker({ pgPool: downPg }).scanPostgres()).status).toBe('down');
    expect((await new HealthChecker({ pgPool: null }).scanPostgres()).status).toBe('disabled');
  });

  it('scan-postgres fails readiness when the migration-owned scan schema is incomplete', async () => {
    const missingIndex = pgWithSchema(healthySchemaRows.filter((row) => row.name !== 'scan_records_created_idx'));
    const check = await new HealthChecker({ pgPool: missingIndex }).scanPostgres();
    expect(check.status).toBe('down');
    expect(check.detail).toMatch(/schema is incomplete.*scan_records_created_idx/i);
    expect((await new HealthChecker({ redis: okRedis, pgPool: missingIndex }).ready()).ready).toBe(false);
  });

  it('scan-postgres fails readiness until principal columns and owner indexes are migrated', async () => {
    const missingPrincipalScope = pgWithSchema(healthySchemaRows.filter((row) =>
      row.name !== 'owner_user_id' && row.name !== 'scan_records_tenant_owner_created_idx'));
    const check = await new HealthChecker({ pgPool: missingPrincipalScope }).scanPostgres();
    expect(check.status).toBe('down');
    expect(check.detail).toMatch(/owner_user_id/);
    expect(check.detail).toMatch(/scan_records_tenant_owner_created_idx/);
  });

  it('scan-postgres fails readiness when the append-only audit migration is missing', async () => {
    const missingAudit = {
      query: async (text: string) => ({
        rows: text.includes('FROM pg_attribute') ? healthySchemaRows : [{ complete: false }],
      }),
    } as unknown as Pool;
    const check = await new HealthChecker({ pgPool: missingAudit }).scanPostgres();
    expect(check.status).toBe('down');
    expect(check.detail).toMatch(/security_audit_events/);
  });

  it('ready: true when critical deps ok, false when one is down', async () => {
    expect((await new HealthChecker({ redis: okRedis, pgPool: okPg }).ready()).ready).toBe(true);
    expect((await new HealthChecker({ redis: downRedis, pgPool: okPg }).ready()).ready).toBe(false);
  });

  it('ready: STEEL_REQUIRED=false does not gate on a misconfigured Steel connector', async () => {
    const env = { STEEL_REQUIRED: 'false', STEEL_CONNECTOR_MODE: 'unsupported' } as NodeJS.ProcessEnv;
    expect((await new HealthChecker({ redis: okRedis, pgPool: okPg, env }).ready()).ready).toBe(true);
  });

  it('ready: STEEL_REQUIRED=true fails readiness when Steel is not READY', async () => {
    const env = { STEEL_REQUIRED: 'true', STEEL_CONNECTOR_MODE: 'unsupported' } as NodeJS.ProcessEnv;
    expect((await new HealthChecker({ redis: okRedis, pgPool: okPg, env }).ready()).ready).toBe(false);
  });

  it('keeps Steel dependency health separate from the live-login policy gate', async () => {
    const connector = { NODE_ENV: 'test', STEEL_CONNECTOR_MODE: 'unsupported' } as NodeJS.ProcessEnv;
    const blocked = await new HealthChecker({ env: connector }).distributorLogin();
    const allowed = await new HealthChecker({
      env: {
        ...connector,
        ENABLE_DISTROKID_LIVE_SCANNER: 'true',
        LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED: 'true',
      },
    }).distributorLogin();

    expect(blocked.connectionPolicyReady).toBe(false);
    expect(blocked.liveLoginAvailable).toBe(false);
    expect(blocked.loginMode).toBe('disabled');
    expect(allowed.connectionPolicyReady).toBe(true);
  });

  it('dependencies: includes a misconfigured Steel connector and degrades overall', async () => {
    const env = { STEEL_CONNECTOR_MODE: 'unsupported' } as NodeJS.ProcessEnv;
    const d = await new HealthChecker({ redis: okRedis, pgPool: okPg, env }).dependencies();
    const steelDep = d.deps.find((x) => x.name === 'steel');
    expect(steelDep?.status).toBe('degraded');
    expect(d.steel.status).toBe('MISCONFIGURED');
    expect(d.status).toBe('degraded');
  });

  it('queue: reports counts when a queue is present, disabled otherwise', async () => {
    const r = await new HealthChecker({ presenceCounts: okCounts }).queue();
    expect(r.status).toBe('ok');
    expect(r.counts?.completed).toBe(5);
    expect((await new HealthChecker({ presenceCounts: null }).queue()).status).toBe('disabled');
  });

  it('worker heartbeat: fresh = ok, missing = down', async () => {
    expect((await new HealthChecker({ redis: okRedis }).workerHeartbeat()).status).toBe('ok');
    const stale = { get: async () => String(Date.now() - 120_000) } as unknown as Redis;
    expect((await new HealthChecker({ redis: stale }).workerHeartbeat()).status).toBe('degraded');
  });

  it('credential status reflects env (no secret values)', () => {
    const h = new HealthChecker({ env: { SPOTIFY_CLIENT_ID: 'spid_ABC', SPOTIFY_CLIENT_SECRET: 'SUPERSECRET_XYZ' } as NodeJS.ProcessEnv });
    const rows = h.credentialStatus();
    expect(rows.find((r) => r.platform === 'Deezer')?.status).toBe('ready');
    expect(rows.find((r) => r.platform === 'Spotify')?.status).toBe('ready');
    expect(rows.find((r) => r.platform === 'Audiomack')?.status).toBe('credential-required');
    // No secret values leak into the payload.
    expect(JSON.stringify(rows)).not.toContain('SUPERSECRET_XYZ');
  });

  it('dependencies() aggregates to the worst live status', async () => {
    const snap = await new HealthChecker({ redis: okRedis, pgPool: okPg, presenceCounts: okCounts, env: {} as NodeJS.ProcessEnv }).dependencies();
    expect(snap.deps.map((d) => d.name)).toContain('scan-postgres');
    expect(['ok', 'degraded', 'down']).toContain(snap.status);
  });
});
