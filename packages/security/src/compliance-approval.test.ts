import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ComplianceApprovalError, verifyComplianceApproval } from './compliance-approval';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function approval(overrides: Record<string, unknown> = {}): { env: NodeJS.ProcessEnv; now: Date } {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const issuedAt = Math.floor(now.getTime() / 1_000) - 30;
  const claims = {
    schemaVersion: 1,
    approvalId: 'approval-2026-07-22-001',
    issuer: 'sentinel-change-control',
    audience: 'artist-catalog-sentinel-production',
    environment: 'production',
    issuedAt,
    notBefore: issuedAt,
    expiresAt: issuedAt + 30 * 24 * 60 * 60,
    scopes: [
      'distrokid:attended-read',
      'distrokid:passive-network-observation',
      'steel:session-processing',
      'catalogue:metadata-retention',
    ],
    accountAuthorizationReference: 'authz-ticket-1001',
    policyReferences: {
      distroKidTermsReview: 'legal-review-41',
      steelDpa: 'dpa-steel-12',
      awsDpa: 'aws-account-contract-3',
      privacyNotice: 'privacy-notice-v5',
      retentionSchedule: 'retention-v4',
    },
    approvedBy: [
      { role: 'legal', subject: 'legal-approver' },
      { role: 'privacy', subject: 'privacy-approver' },
      { role: 'security', subject: 'security-approver' },
    ],
    limits: { maxSessionDurationMs: 7_200_000, maxReleasesPerScan: 2_000, maxOperationalRetentionDays: 90 },
    ...overrides,
  };
  const protectedHeader = encode({ alg: 'RS256', typ: 'JWT', kid: 'legal-key-2026-01' });
  const payload = encode(claims);
  const input = `${protectedHeader}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(input, 'ascii'), privateKey).toString('base64url');
  return {
    now,
    env: {
      COMPLIANCE_APPROVAL_BUNDLE: `${input}.${signature}`,
      COMPLIANCE_APPROVAL_KEY_ID: 'legal-key-2026-01',
      COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      COMPLIANCE_APPROVAL_ISSUER: 'sentinel-change-control',
      STEEL_SESSION_TIMEOUT_MS: '3600000',
      CATALOG_READ_MAX_RELEASES: '1500',
      DATA_RETENTION_DAYS: '30',
    },
  };
}

describe('verifyComplianceApproval', () => {
  it('accepts a current signed approval whose limits cover production config', () => {
    const { env, now } = approval();
    const verified = verifyComplianceApproval(env, now);
    expect(verified.claims.approvalId).toBe('approval-2026-07-22-001');
    expect(verified.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a tampered payload', () => {
    const { env, now } = approval();
    const segments = env.COMPLIANCE_APPROVAL_BUNDLE!.split('.');
    env.COMPLIANCE_APPROVAL_BUNDLE = `${segments[0]}.${encode({ schemaVersion: 1 })}.${segments[2]}`;
    expect(() => verifyComplianceApproval(env, now)).toThrow(ComplianceApprovalError);
  });

  it('rejects an expired approval', () => {
    const { env, now } = approval({ expiresAt: Math.floor(new Date('2026-07-21T00:00:00Z').getTime() / 1_000) });
    expect(() => verifyComplianceApproval(env, now)).toThrow(/expired/);
  });

  it('rejects configuration that exceeds a signed limit', () => {
    const { env, now } = approval();
    env.CATALOG_READ_MAX_RELEASES = '2500';
    expect(() => verifyComplianceApproval(env, now)).toThrow(/exceeds the signed approval limit/);
  });

  it('requires independent legal, privacy, and security approvers', () => {
    const { env, now } = approval({ approvedBy: [{ role: 'legal', subject: 'legal-approver' }] });
    expect(() => verifyComplianceApproval(env, now)).toThrow(/privacy approver/);
  });
});
