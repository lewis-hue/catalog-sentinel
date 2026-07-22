import { generateKeyPairSync, sign } from 'node:crypto';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Produce a current signed approval for isolated tests; never imported by runtime code. */
export function signedComplianceTestEnv(overrides: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'test-compliance-key' });
  const payload = encode({
    schemaVersion: 1,
    approvalId: 'test-approval-current',
    issuer: 'sentinel-test-change-control',
    audience: 'artist-catalog-sentinel-production',
    environment: 'production',
    issuedAt: now - 30,
    notBefore: now - 30,
    expiresAt: now + 30 * 24 * 60 * 60,
    scopes: [
      'distrokid:attended-read',
      'distrokid:passive-network-observation',
      'steel:session-processing',
      'catalogue:metadata-retention',
    ],
    accountAuthorizationReference: 'test-account-authorization',
    policyReferences: {
      distroKidTermsReview: 'test-terms-review',
      steelDpa: 'test-steel-dpa',
      awsDpa: 'test-aws-dpa',
      privacyNotice: 'test-privacy-notice',
      retentionSchedule: 'test-retention-schedule',
    },
    approvedBy: [
      { role: 'legal', subject: 'test-legal-approver' },
      { role: 'privacy', subject: 'test-privacy-approver' },
      { role: 'security', subject: 'test-security-approver' },
    ],
    limits: { maxSessionDurationMs: 86_400_000, maxReleasesPerScan: 100_000, maxOperationalRetentionDays: 3_650 },
    ...overrides,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), keyPair.privateKey).toString('base64url');
  return {
    COMPLIANCE_APPROVAL_BUNDLE: `${signingInput}.${signature}`,
    COMPLIANCE_APPROVAL_KEY_ID: 'test-compliance-key',
    COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    COMPLIANCE_APPROVAL_ISSUER: 'sentinel-test-change-control',
    STEEL_SESSION_TIMEOUT_MS: '3600000',
    CATALOG_READ_MAX_RELEASES: '5000',
    DATA_RETENTION_DAYS: '30',
  };
}
