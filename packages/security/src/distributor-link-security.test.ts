import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DecryptCommand, EncryptCommand, type KMSClient } from '@aws-sdk/client-kms';
import {
  assertNoHostedCredentialForm,
  assertProviderEnabled,
  assertDistroKidLiveScannerAllowed,
  validateServerConfig,
  readDistributorLinkFlags,
  InsecureConfigurationError,
  ConfigValidationError,
} from './feature-flags';
import {
  EnvelopeEncryptor,
  AwsSdkKmsClientAdapter,
  createEnvelopeEncryptor,
  AsyncEnvelopeEncryptor,
  LocalKeyWrapper,
  KmsKeyWrapper,
  createKeyWrapper,
  envelopeEncryptorFromEnv,
  verifyEnvelopeEncryptor,
  type KmsDecryptInput,
  type KmsEncryptInput,
  type KmsClientLike,
} from './envelope';

const complianceKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function signedComplianceEnv(): NodeJS.ProcessEnv {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'legal-test-key' });
  const payload = encode({
    schemaVersion: 1,
    approvalId: 'approval-test-current',
    issuer: 'sentinel-test-change-control',
    audience: 'artist-catalog-sentinel-production',
    environment: 'production',
    issuedAt: now - 30,
    notBefore: now - 30,
    expiresAt: now + 30 * 24 * 60 * 60,
    scopes: ['distrokid:attended-read', 'distrokid:passive-network-observation', 'steel:session-processing', 'catalogue:metadata-retention'],
    accountAuthorizationReference: 'authorized-test-account',
    policyReferences: {
      distroKidTermsReview: 'terms-review-test',
      steelDpa: 'steel-dpa-test',
      awsDpa: 'aws-dpa-test',
      privacyNotice: 'privacy-test',
      retentionSchedule: 'retention-test',
    },
    approvedBy: [
      { role: 'legal', subject: 'legal-test-approver' },
      { role: 'privacy', subject: 'privacy-test-approver' },
      { role: 'security', subject: 'security-test-approver' },
    ],
    limits: { maxSessionDurationMs: 21_600_000, maxReleasesPerScan: 1_000, maxOperationalRetentionDays: 90 },
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), complianceKeyPair.privateKey).toString('base64url');
  return {
    COMPLIANCE_APPROVAL_BUNDLE: `${signingInput}.${signature}`,
    COMPLIANCE_APPROVAL_KEY_ID: 'legal-test-key',
    COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM: complianceKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    COMPLIANCE_APPROVAL_ISSUER: 'sentinel-test-change-control',
    DATA_RETENTION_DAYS: '30',
  };
}

describe('feature flags — hosted credential form hard block', () => {
  it('is a no-op when the hosted credential form is disabled (default)', () => {
    expect(() => assertNoHostedCredentialForm({})).not.toThrow();
    expect(() => assertNoHostedCredentialForm({ ENABLE_HOSTED_CREDENTIAL_FORM: 'false' })).not.toThrow();
  });

  it('THROWS in production even if the flag is on', () => {
    expect(() => assertNoHostedCredentialForm({ ENABLE_HOSTED_CREDENTIAL_FORM: 'true', NODE_ENV: 'production' })).toThrow(
      InsecureConfigurationError,
    );
  });

  it('THROWS when the flag is on in development', () => {
    expect(() => assertNoHostedCredentialForm({ ENABLE_HOSTED_CREDENTIAL_FORM: 'true', NODE_ENV: 'development' })).toThrow();
  });

  it('does not recognize an unsafe development override', () => {
    expect(() =>
      assertNoHostedCredentialForm({
        ENABLE_HOSTED_CREDENTIAL_FORM: 'true',
        NODE_ENV: 'development',
        SECURITY_ALLOW_UNSAFE_DEV_LOGIN_FORM: 'true',
      }),
    ).toThrow(InsecureConfigurationError);
  });

  it('defaults are safe and providers are validated', () => {
    const flags = readDistributorLinkFlags({});
    expect(flags.browserLinkProvider).toBe('steel');
    expect(flags.enableHostedCredentialForm).toBe(false);
    expect(flags.deepScanMaxConcurrency).toBe(1);
    expect(readDistributorLinkFlags({ BROWSER_LINK_PROVIDER: 'nonsense' }).browserLinkProvider).toBe('steel');
  });
});

describe('envelope encryption', () => {
  it('round-trips a sensitive ref and hides the plaintext', () => {
    const enc = new EnvelopeEncryptor(Buffer.alloc(32, 9).toString('base64'));
    const blob = enc.encrypt('provider-session-abc123');
    expect(blob).not.toContain('provider-session-abc123');
    expect(blob.startsWith('v1.')).toBe(true);
    expect(enc.decrypt(blob)).toBe('provider-session-abc123');
  });

  it('uses a fresh data key per record (two ciphertexts differ)', () => {
    const enc = new EnvelopeEncryptor(Buffer.alloc(32, 3).toString('base64'));
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('fails to decrypt a tampered blob', () => {
    const enc = new EnvelopeEncryptor(Buffer.alloc(32, 5).toString('base64'));
    const blob = enc.encrypt('secret-token');
    const tampered = blob.slice(0, -3) + (blob.endsWith('A') ? 'BBB' : 'AAA');
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it('directs KMS configuration to the asynchronous runtime factory', () => {
    expect(() => createEnvelopeEncryptor({ kmsKeyId: 'arn:aws:kms:...' })).toThrow(/envelopeEncryptorFromEnv/);
  });
});

describe('provider selection gate', () => {
  it('allows only Steel', () => {
    expect(() => assertProviderEnabled({ BROWSER_LINK_PROVIDER: 'steel' })).not.toThrow();
    expect(() => assertProviderEnabled({ BROWSER_LINK_PROVIDER: 'mock' })).toThrow(InsecureConfigurationError);
    expect(() => assertProviderEnabled({ BROWSER_LINK_PROVIDER: 'browserless' })).toThrow(InsecureConfigurationError);
  });
});

describe('DistroKid live scanner legal-review gate', () => {
  it('blocks unless enabled AND legal-review approved', () => {
    expect(() => assertDistroKidLiveScannerAllowed({})).toThrow(InsecureConfigurationError);
    expect(() => assertDistroKidLiveScannerAllowed({ ENABLE_DISTROKID_LIVE_SCANNER: 'true' })).toThrow(/LEGAL_REVIEW/);
    expect(() =>
      assertDistroKidLiveScannerAllowed({ ENABLE_DISTROKID_LIVE_SCANNER: 'true', LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED: 'true' }),
    ).not.toThrow();
  });
});

describe('validateServerConfig — startup hard-fails', () => {
  const key = Buffer.alloc(32, 1).toString('base64');

  it('passes a safe test/dev config', () => {
    expect(() => validateServerConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateServerConfig({ NODE_ENV: 'development', ENCRYPTION_MASTER_KEY: key })).not.toThrow();
  });

  const production: NodeJS.ProcessEnv = {
    ...signedComplianceEnv(),
    NODE_ENV: 'production',
    KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
    AWS_REGION: 'us-east-1',
    KMS_ENCRYPTION_CONTEXT: '{"application":"artist-catalog-sentinel","environment":"production","purpose":"session-envelope"}',
    HISTORY_CURSOR_SIGNING_KEY: Buffer.alloc(32, 2).toString('base64'),
    DATABASE_URL: 'postgres://x',
    REDIS_URL: 'redis://x',
    ENABLE_KEYCLOAK_AUTH: 'true',
    KEYCLOAK_BASE_URL: 'https://identity.example',
    KEYCLOAK_API_AUDIENCE: 'sentinel-api',
    DEEP_SCAN_DISPATCH: 'bullmq',
    BROWSER_LINK_PROVIDER: 'steel',
    STEEL_REQUIRED: 'true',
    STEEL_CONNECTOR_MODE: 'cloud',
    STEEL_API_KEY: 'steel-test-key',
    STEEL_VIEWER_ORIGINS: 'https://api.steel.dev https://app.steel.dev',
    STEEL_SESSION_TIMEOUT_MS: '21600000',
    CATALOG_READ_MAX_DURATION_MS: '600000',
    CATALOG_READ_MAX_RELEASES: '250',
    ENABLE_DISTROKID_LIVE_SCANNER: 'true',
    LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED: 'true',
    APP_BASE_URL: 'https://sentinel.example',
  };

  it('production requires the complete durable, authenticated Steel configuration', () => {
    expect(() => validateServerConfig({ NODE_ENV: 'production' })).toThrow(ConfigValidationError);
    expect(() => validateServerConfig({ DEPLOYMENT_ENV: 'production', NODE_ENV: 'development' })).toThrow(ConfigValidationError);
    expect(() => validateServerConfig({ NODE_ENV: 'production', KMS_KEY_ID: 'arn:kms' })).toThrow(/AWS_REGION/);
    expect(() => validateServerConfig({ ...production, KMS_KEY_ID: undefined, ENCRYPTION_MASTER_KEY: key })).toThrow(/KMS_KEY_ID.*required/i);
    expect(() => validateServerConfig({ ...production, ENCRYPTION_MASTER_KEY: key })).toThrow(/exactly one/i);
    expect(() => validateServerConfig({ ...production, KMS_ENDPOINT: 'http://localstack:4566' })).toThrow(/not permitted/i);
    expect(() => validateServerConfig({ ...production, AWS_ENDPOINT_URL_KMS: 'http://localstack:4566' })).toThrow(/not permitted/i);
    expect(() => validateServerConfig({ ...production, AWS_ENDPOINT_URL: 'http://localstack:4566' })).toThrow(/not permitted/i);
    expect(() => validateServerConfig({ ...production, KMS_KEY_ID: 'alias/sentinel-production' })).toThrow(/full KMS key ARN/i);
    expect(() => validateServerConfig({ ...production, KMS_KEY_ID: production.KMS_KEY_ID!.replace('us-east-1', 'eu-west-1') })).toThrow(/AWS_REGION/i);
    expect(() => validateServerConfig({ ...production, KMS_ENCRYPTION_CONTEXT: undefined })).toThrow(/KMS_ENCRYPTION_CONTEXT is required/i);
    expect(() => validateServerConfig({ ...production, KMS_ENCRYPTION_CONTEXT: '{"application":"other"}' })).toThrow(/application=artist-catalog-sentinel/i);
    expect(() => validateServerConfig({ ...production, HISTORY_CURSOR_SIGNING_KEY: undefined })).toThrow(/HISTORY_CURSOR_SIGNING_KEY/);
    expect(() => validateServerConfig({ ...production, REDIS_URL: undefined })).toThrow(/REDIS_URL/);
    expect(() => validateServerConfig({ ...production, KEYCLOAK_BASE_URL: 'http://identity.example' })).toThrow(/HTTPS URL/);
    expect(() => validateServerConfig({ ...production, STEEL_VIEWER_ORIGINS: undefined })).toThrow(/STEEL_VIEWER_ORIGINS/);
    expect(() => validateServerConfig({ ...production, STEEL_VIEWER_ORIGINS: 'https://*.steel.dev' })).toThrow(/wildcards/);
    expect(() => validateServerConfig({ ...production, SCAN_DATABASE_URL: 'postgres://different' })).toThrow(/distinct SCAN_DATABASE_URL/i);
    expect(() => validateServerConfig({ ...production, SCAN_DATABASE_URL: production.DATABASE_URL })).not.toThrow();
    expect(() => validateServerConfig({ ...production, STEEL_SESSION_TIMEOUT_MS: undefined })).toThrow(/STEEL_SESSION_TIMEOUT_MS/);
    expect(() => validateServerConfig({ ...production, CATALOG_READ_MAX_DURATION_MS: undefined })).toThrow(/CATALOG_READ_MAX_DURATION_MS/);
    expect(() => validateServerConfig({
      ...production,
      STEEL_SESSION_TIMEOUT_MS: '659999',
      CATALOG_READ_MAX_DURATION_MS: '600000',
    })).toThrow(/60000ms terminal cleanup reserve/);
    expect(() => validateServerConfig({
      ...production,
      STEEL_SESSION_TIMEOUT_MS: '660000',
      CATALOG_READ_MAX_DURATION_MS: '600000',
    })).not.toThrow();
    expect(() => validateServerConfig({ ...production, CATALOG_READ_MAX_RELEASES: '0' })).toThrow(/CATALOG_READ_MAX_RELEASES/);
    expect(() => validateServerConfig({
      ...production,
      CATALOG_READ_MAX_RELEASES: '1000',
      CATALOG_READ_MAX_DURATION_MS: '600000',
    })).toThrow(/750ms per-release pacing floor/);
    expect(() => validateServerConfig({ ...production, DEEP_SCAN_MAX_DISTINCT_ARTISTS: '20001' }))
      .toThrow(/DEEP_SCAN_MAX_DISTINCT_ARTISTS/);
    expect(() => validateServerConfig({ ...production, DSP_CATALOG_MAX_TRACKS_PER_ARTIST: '0' }))
      .toThrow(/DSP_CATALOG_MAX_TRACKS_PER_ARTIST/);
    expect(() => validateServerConfig({ ...production, DSP_CATALOG_FETCH_CONCURRENCY: '17' }))
      .toThrow(/DSP_CATALOG_FETCH_CONCURRENCY/);
    expect(() => validateServerConfig({
      ...production,
      STEEL_API_REQUEST_TIMEOUT_MS: '10000',
      CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS: '14999',
    })).toThrow(/cancellation-ack reserve/);
    expect(() => validateServerConfig({
      ...production,
      STEEL_API_REQUEST_TIMEOUT_MS: '10000',
      CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS: '15000',
    })).not.toThrow();
    expect(() => validateServerConfig({
      ...production,
      STEEL_API_REQUEST_TIMEOUT_MS: '10000',
      CONSENT_REVOCATION_LEASE_MS: '14999',
    })).toThrow(/completion reserve/);
    expect(() => validateServerConfig({
      ...production,
      STEEL_API_REQUEST_TIMEOUT_MS: '10000',
      CONSENT_REVOCATION_LEASE_MS: '15000',
    })).not.toThrow();
    expect(() => validateServerConfig({ ...production, STEEL_API_URL: 'http://api.steel.dev' })).toThrow(/HTTPS URL/);
    expect(() => validateServerConfig({ ...production, STEEL_API_URL: 'https://key@api.steel.dev' })).toThrow(/embedded credentials/);
    expect(() => validateServerConfig({ ...production, STEEL_API_URL: 'https://proxy.example/steel' })).not.toThrow();
    expect(() => validateServerConfig({ ...production, COMPLIANCE_APPROVAL_BUNDLE: undefined })).toThrow(/signed compliance approval/i);
    expect(() => validateServerConfig({ ...production, COMPLIANCE_APPROVAL_BUNDLE: `${production.COMPLIANCE_APPROVAL_BUNDLE}tampered` })).toThrow(/signed compliance approval/i);
    expect(() => validateServerConfig({
      ...production,
      STEEL_CONNECTOR_MODE: 'external',
      STEEL_API_KEY: undefined,
      STEEL_API_URL: 'http://steel.internal',
    })).toThrow(/HTTPS URL/);
    expect(() => validateServerConfig(production)).not.toThrow();
  });

  it('production still blocks the hosted credential form and unenabled providers', () => {
    expect(() => validateServerConfig({ ...production, ENABLE_HOSTED_CREDENTIAL_FORM: 'true' })).toThrow();
    expect(() => validateServerConfig({ ...production, BROWSER_LINK_PROVIDER: 'browserless' })).toThrow(/only browser-link path/);
    expect(() => validateServerConfig({ ...production, ENABLE_LEGACY_DOM_SCANNER: 'true' })).toThrow(/not permitted/);
  });

  it('production rejects auth-off, non-Steel, and non-durable dispatch modes', () => {
    expect(() => validateServerConfig({ ...production, ENABLE_KEYCLOAK_AUTH: 'false' })).toThrow(/KEYCLOAK/);
    expect(() => validateServerConfig({ ...production, KEYCLOAK_API_AUDIENCE: undefined })).toThrow(/KEYCLOAK_API/);
    expect(() => validateServerConfig({ ...production, BROWSER_LINK_PROVIDER: undefined })).toThrow(/BROWSER_LINK_PROVIDER=steel/);
    expect(() => validateServerConfig({ ...production, STEEL_CONNECTOR_MODE: 'mock' })).toThrow(/STEEL_CONNECTOR_MODE/);
    expect(() => validateServerConfig({ ...production, DEEP_SCAN_DISPATCH: 'inline' })).toThrow(/bullmq/);
  });

  it('non-test config without any encryption key fails fast', () => {
    expect(() => validateServerConfig({ NODE_ENV: 'development' })).toThrow(/ENCRYPTION_MASTER_KEY|encryption key/i);
  });

  it('rejects malformed, empty, and undersized configured master keys', () => {
    for (const invalid of ['', 'not-base64', Buffer.alloc(16, 1).toString('base64'), 'A'.repeat(44)]) {
      expect(() => validateServerConfig({ NODE_ENV: 'development', ENCRYPTION_MASTER_KEY: invalid })).toThrow(
        /ENCRYPTION_MASTER_KEY|32 random bytes/i,
      );
    }
    expect(() => new EnvelopeEncryptor('not-base64')).toThrow(/32 random bytes/i);
  });
});

/** Deterministic KMS boundary contract: wraps by prefixing a marker. */
class DeterministicKmsContract implements KmsClientLike {
  private readonly marker = Buffer.from('KMSWRAP::');
  readonly encryptInputs: KmsEncryptInput[] = [];
  readonly decryptInputs: KmsDecryptInput[] = [];
  async encrypt(input: KmsEncryptInput) {
    this.encryptInputs.push(input);
    const { Plaintext } = input;
    return { CiphertextBlob: Buffer.concat([this.marker, Plaintext]) };
  }
  async decrypt(input: KmsDecryptInput) {
    this.decryptInputs.push(input);
    const { CiphertextBlob } = input;
    return { Plaintext: Buffer.from(CiphertextBlob).subarray(this.marker.length) };
  }
}

describe('KMS-pluggable envelope encryption', () => {
  it('uses the official AWS SDK EncryptCommand and DecryptCommand contracts', async () => {
    const wrapped = Buffer.from('wrapped-key');
    const plaintext = Buffer.alloc(32, 8);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof EncryptCommand) return { CiphertextBlob: wrapped };
      if (command instanceof DecryptCommand) return { Plaintext: plaintext };
      throw new Error('unexpected command');
    });
    const adapter = new AwsSdkKmsClientAdapter({ send } as unknown as KMSClient, 1_000);
    await expect(adapter.encrypt({
      KeyId: 'alias/sentinel',
      Plaintext: plaintext,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: { application: 'sentinel' },
    })).resolves.toEqual({ CiphertextBlob: wrapped });
    await expect(adapter.decrypt({
      KeyId: 'alias/sentinel',
      CiphertextBlob: wrapped,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: { application: 'sentinel' },
    })).resolves.toEqual({ Plaintext: plaintext });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(EncryptCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DecryptCommand);
  });

  it('round-trips with a local KEK wrapper', async () => {
    const enc = new AsyncEnvelopeEncryptor(new LocalKeyWrapper(Buffer.alloc(32, 2)));
    const blob = await enc.encrypt('storage-state-json');
    expect(blob.startsWith('v2.local.')).toBe(true);
    expect(blob).not.toContain('storage-state-json');
    expect(await enc.decrypt(blob)).toBe('storage-state-json');
  });

  it('wraps the data key via (mock) AWS KMS and round-trips', async () => {
    const kms = new DeterministicKmsContract();
    const enc = new AsyncEnvelopeEncryptor(new KmsKeyWrapper(kms, 'arn:aws:kms:key'));
    const blob = await enc.encrypt('provider-session-token');
    expect(blob.startsWith('v2.aws-kms.')).toBe(true);
    expect(blob).not.toContain('provider-session-token');
    expect(await enc.decrypt(blob)).toBe('provider-session-token');
    expect(kms.encryptInputs[0]).toMatchObject({
      KeyId: 'arn:aws:kms:key',
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: { application: 'artist-catalog-sentinel', purpose: 'session-envelope' },
    });
    expect(kms.decryptInputs[0]).toMatchObject({
      KeyId: 'arn:aws:kms:key',
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: kms.encryptInputs[0]?.EncryptionContext,
    });
  });

  it('builds the production KMS provider and proves its data-plane round trip', async () => {
    const kms = new DeterministicKmsContract();
    const enc = envelopeEncryptorFromEnv({
      NODE_ENV: 'production',
      KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
      AWS_REGION: 'us-east-1',
      KMS_ENCRYPTION_CONTEXT: '{"application":"artist-catalog-sentinel","environment":"production","purpose":"session-envelope"}',
    } as NodeJS.ProcessEnv, { kmsClient: kms });
    expect(enc.provider).toBe('aws-kms');
    await expect(verifyEnvelopeEncryptor(enc)).resolves.toBeUndefined();
    expect(kms.encryptInputs).toHaveLength(1);
    expect(kms.decryptInputs).toHaveLength(1);
    expect(kms.encryptInputs[0]?.EncryptionContext).toEqual({
      application: 'artist-catalog-sentinel',
      environment: 'production',
      purpose: 'session-envelope',
    });
  });

  it('cannot select local or emulator crypto in production', () => {
    expect(() => envelopeEncryptorFromEnv({
      NODE_ENV: 'production',
      ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    } as NodeJS.ProcessEnv)).toThrow(/KMS_KEY_ID is required/i);
    expect(() => envelopeEncryptorFromEnv({
      NODE_ENV: 'production',
      KMS_KEY_ID: 'alias/sentinel',
      AWS_REGION: 'us-east-1',
      KMS_ENDPOINT: 'http://127.0.0.1:4566',
    } as NodeJS.ProcessEnv, { kmsClient: new DeterministicKmsContract() })).toThrow(/not permitted/i);
  });

  it('createKeyWrapper requires a client when KMS_KEY_ID is set', () => {
    expect(() => createKeyWrapper({ kmsKeyId: 'arn:aws:kms:key' })).toThrow(/no KMS client/);
    expect(createKeyWrapper({ kmsKeyId: 'arn:aws:kms:key', kmsClient: new DeterministicKmsContract() }).name).toBe('aws-kms');
    expect(createKeyWrapper({ masterKeyBase64: Buffer.alloc(32, 1).toString('base64') }).name).toBe('local');
  });
});
