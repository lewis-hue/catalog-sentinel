import { describe, expect, it } from 'vitest';
import {
  createLocalTenantErasureRequestRuntime,
  createProductionGovernanceRuntime,
} from './governance-runtime';
import type { GovernanceSqlPool } from './governance-types';

const productionEnv = (): NodeJS.ProcessEnv => ({
  DATABASE_URL: 'postgresql://sentinel:secret@db.internal.example/sentinel?sslmode=verify-full',
  AWS_REGION: 'eu-west-1',
  GOVERNANCE_HMAC_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-1111-1111-111111111111',
  AUDIT_SIGNING_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:123456789012:key/22222222-2222-2222-2222-222222222222',
  AUDIT_EXPORT_KMS_KEY_ID: 'arn:aws:kms:eu-west-1:123456789012:key/33333333-3333-3333-3333-333333333333',
  AUDIT_EXPORT_S3_BUCKET: 'sentinel-audit-export-production',
  AUDIT_RETENTION_DAYS: '2555',
});

describe('production governance runtime configuration', () => {
  it('constructs only concrete PostgreSQL, KMS, and S3-backed services', async () => {
    const runtime = createProductionGovernanceRuntime(productionEnv());
    expect(runtime.erasure).toBeTruthy();
    expect(runtime.auditSigner).toBeTruthy();
    expect(runtime.auditAnchorStore).toBeTruthy();
    await runtime.close();
  });

  it.each([
    'DATABASE_URL',
    'GOVERNANCE_HMAC_KMS_KEY_ID',
    'AUDIT_SIGNING_KMS_KEY_ID',
    'AUDIT_EXPORT_KMS_KEY_ID',
    'AUDIT_EXPORT_S3_BUCKET',
  ])('fails closed when %s is missing', (name) => {
    const env = productionEnv();
    delete env[name];
    expect(() => createProductionGovernanceRuntime(env)).toThrow(new RegExp(name));
  });

  it('rejects aliases, region mismatch, endpoint overrides, and short immutable retention', () => {
    expect(() => createProductionGovernanceRuntime({
      ...productionEnv(), GOVERNANCE_HMAC_KMS_KEY_ID: 'alias/governance-hmac',
    })).toThrow(/immutable KMS key ARN/);
    expect(() => createProductionGovernanceRuntime({
      ...productionEnv(), AUDIT_SIGNING_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/abc',
    })).toThrow(/AWS_REGION/);
    expect(() => createProductionGovernanceRuntime({
      ...productionEnv(), AWS_ENDPOINT_URL: 'http://localhost:4566',
    })).toThrow(/endpoint overrides are forbidden/);
    expect(() => createProductionGovernanceRuntime({
      ...productionEnv(), AUDIT_RETENTION_DAYS: '30',
    })).toThrow(/365/);
    expect(() => createProductionGovernanceRuntime({
      ...productionEnv(), DATABASE_URL: 'postgresql://sentinel:secret@db.internal.example/sentinel?sslmode=disable',
    })).toThrow(/sslmode=verify-full/);
  });
});

describe('local tenant-erasure request runtime configuration', () => {
  const pool = {
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release() {},
    }),
  } as unknown as GovernanceSqlPool;

  it('uses real PostgreSQL state with a stable, dedicated HMAC pseudonymizer', async () => {
    const runtime = createLocalTenantErasureRequestRuntime(pool, {
      GOVERNANCE_HMAC_LOCAL_KEY: Buffer.alloc(32, 7).toString('base64'),
      GOVERNANCE_HMAC_LOCAL_KEY_VERSION: 'manual-stack-v1',
    });
    expect(runtime.pseudonymizer.keyVersion).toBe('manual-stack-v1');
    expect(await runtime.pseudonymizer.pseudonym('tenant', 'tenant-a')).toMatch(/^[a-f0-9]{64}$/);
    await runtime.verifyReady();
    await runtime.close();
  });

  it('rejects missing, malformed, or short local HMAC keys', () => {
    expect(() => createLocalTenantErasureRequestRuntime(pool, {})).toThrow(/GOVERNANCE_HMAC_LOCAL_KEY/);
    expect(() => createLocalTenantErasureRequestRuntime(pool, { GOVERNANCE_HMAC_LOCAL_KEY: 'not-base64' }))
      .toThrow(/canonical base64/);
    expect(() => createLocalTenantErasureRequestRuntime(pool, {
      GOVERNANCE_HMAC_LOCAL_KEY: Buffer.alloc(16, 1).toString('base64'),
    })).toThrow(/32 random bytes/);
  });
});
