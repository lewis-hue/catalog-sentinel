import { createHash } from 'node:crypto';
import {
  GenerateMacCommand,
  KMSClient,
  SignCommand,
  VerifyCommand,
  type SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import {
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';
import type { GovernanceSqlPool } from './governance-types';
import { GovernanceValidationError } from './governance-types';
import { PostgresOrganizationRepository } from './organization-repository';
import { PostgresRetentionRepository } from './retention';
import { PostgresTenantErasureRepository, type TenantPseudonymizer } from './tenant-erasure';
import {
  AuditChainAnchorPublisher,
  PostgresAuditChainAppender,
  PostgresTenantAuditChainReader,
  type AuditAnchorSignatureVerifier,
  type AuditAnchorSigner,
  type ImmutableAuditAnchorStore,
} from './audit-chain';

const SIGNING_ALGORITHMS = new Set<SigningAlgorithmSpec>([
  'RSASSA_PSS_SHA_256',
  'RSASSA_PKCS1_V1_5_SHA_256',
  'ECDSA_SHA_256',
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new GovernanceValidationError(`${name} is required for the production governance runtime.`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new GovernanceValidationError(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function awsRegion(env: NodeJS.ProcessEnv): string {
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim();
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) throw new GovernanceValidationError('AWS_REGION must be a valid AWS region.');
  return region;
}

function immutableKmsKeyArn(value: string, region: string, name: string): string {
  const match = /^arn:([a-z0-9-]+):kms:([^:]+):(\d{12}):key\/([A-Za-z0-9-]+)$/.exec(value);
  if (!match || match[2] !== region) {
    throw new GovernanceValidationError(`${name} must be a full immutable KMS key ARN in AWS_REGION; aliases are forbidden.`);
  }
  return value;
}

function productionDatabaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new GovernanceValidationError('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new GovernanceValidationError('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (parsed.searchParams.get('sslmode') !== 'verify-full') {
    throw new GovernanceValidationError('Production governance DATABASE_URL must set sslmode=verify-full.');
  }
  return value;
}

function signingAlgorithm(value: string | undefined): SigningAlgorithmSpec {
  const algorithm = (value?.trim() || 'ECDSA_SHA_256') as SigningAlgorithmSpec;
  if (!SIGNING_ALGORITHMS.has(algorithm)) throw new GovernanceValidationError('AUDIT_SIGNING_ALGORITHM must be a supported SHA-256 asymmetric KMS algorithm.');
  return algorithm;
}

function canonicalBase64(value: Uint8Array, label: string): string {
  if (value.byteLength === 0) throw new Error(`AWS returned an empty ${label}.`);
  return Buffer.from(value).toString('base64');
}

function requestOptions(timeoutMs: number): { abortSignal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AWS governance request deadline exceeded.')), timeoutMs);
  timer.unref?.();
  return { abortSignal: controller.signal, cancel: () => clearTimeout(timer) };
}

export class AwsKmsTenantPseudonymizer implements TenantPseudonymizer {
  readonly keyVersion: string;

  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
    private readonly timeoutMs = 5_000,
  ) {
    this.keyVersion = keyId;
  }

  async pseudonym(domain: 'tenant' | 'subject', value: string): Promise<string> {
    const request = requestOptions(this.timeoutMs);
    try {
      const response = await this.client.send(new GenerateMacCommand({
        KeyId: this.keyId,
        MacAlgorithm: 'HMAC_SHA_256',
        Message: Buffer.from(`sentinel-erasure-pseudonym-v1\0${domain}\0${value}`, 'utf8'),
      }), { abortSignal: request.abortSignal });
      if (!response.Mac || response.Mac.length !== 32) throw new Error('AWS KMS GenerateMac returned an invalid HMAC-SHA-256 value.');
      return Buffer.from(response.Mac).toString('hex');
    } finally {
      request.cancel();
    }
  }
}

export class AwsKmsAuditAnchorSigner implements AuditAnchorSigner, AuditAnchorSignatureVerifier {
  constructor(
    private readonly client: KMSClient,
    private readonly keyId: string,
    private readonly algorithm: SigningAlgorithmSpec,
    private readonly timeoutMs = 5_000,
  ) {}

  async sign(payload: Uint8Array): Promise<{ keyId: string; signature: string }> {
    const request = requestOptions(this.timeoutMs);
    try {
      const response = await this.client.send(new SignCommand({
        KeyId: this.keyId,
        Message: payload,
        MessageType: 'RAW',
        SigningAlgorithm: this.algorithm,
      }), { abortSignal: request.abortSignal });
      if (!response.Signature) throw new Error('AWS KMS Sign returned no signature.');
      return { keyId: response.KeyId ?? this.keyId, signature: canonicalBase64(response.Signature, 'audit signature') };
    } finally {
      request.cancel();
    }
  }

  async verify(input: { keyId: string; payload: Uint8Array; signature: string }): Promise<boolean> {
    if (input.keyId !== this.keyId) return false;
    const request = requestOptions(this.timeoutMs);
    try {
      const response = await this.client.send(new VerifyCommand({
        KeyId: this.keyId,
        Message: input.payload,
        MessageType: 'RAW',
        SigningAlgorithm: this.algorithm,
        Signature: Buffer.from(input.signature, 'base64'),
      }), { abortSignal: request.abortSignal });
      return response.SignatureValid === true;
    } finally {
      request.cancel();
    }
  }
}

interface S3AnchorStoreConfig {
  bucket: string;
  prefix: string;
  kmsKeyId: string;
  retentionDays: number;
  timeoutMs: number;
}

/** S3 Object Lock COMPLIANCE mode prevents overwrite or deletion until the retention date. */
export class S3ObjectLockAuditAnchorStore implements ImmutableAuditAnchorStore {
  constructor(private readonly client: S3Client, private readonly config: S3AnchorStoreConfig) {}

  async verifyReady(): Promise<void> {
    const request = requestOptions(this.config.timeoutMs);
    try {
      const [lock, versioning] = await Promise.all([
        this.client.send(new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }), { abortSignal: request.abortSignal }),
        this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }), { abortSignal: request.abortSignal }),
      ]);
      if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') {
        throw new Error('Audit anchor bucket must have S3 Object Lock enabled.');
      }
      if (versioning.Status !== 'Enabled') throw new Error('Audit anchor bucket must have S3 versioning enabled.');
    } finally {
      request.cancel();
    }
  }

  async put(input: {
    tenantId: string;
    sequence: bigint;
    eventHash: string;
    payload: string;
    signature: string;
    keyId: string;
  }): Promise<{ immutableRef: string }> {
    const tenantDigest = createHash('sha256').update(input.tenantId, 'utf8').digest('hex');
    const key = `${this.config.prefix}${tenantDigest}/${input.sequence}-${input.eventHash}.json`;
    const body = Buffer.from(JSON.stringify({
      version: 1,
      tenantDigest,
      sequence: input.sequence.toString(),
      eventHash: input.eventHash,
      payload: input.payload,
      signature: input.signature,
      signerKeyId: input.keyId,
    }), 'utf8');
    const checksumHex = createHash('sha256').update(body).digest('hex');
    const checksumBase64 = Buffer.from(checksumHex, 'hex').toString('base64');
    const retainUntil = new Date(Date.now() + this.config.retentionDays * 86_400_000);
    const request = requestOptions(this.config.timeoutMs);
    try {
      try {
        const response = await this.client.send(new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: checksumBase64,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: this.config.kmsKeyId,
          BucketKeyEnabled: true,
          ObjectLockMode: 'COMPLIANCE',
          ObjectLockRetainUntilDate: retainUntil,
          IfNoneMatch: '*',
          Metadata: {
            'content-sha256': checksumHex,
            'event-hash': input.eventHash,
            sequence: input.sequence.toString(),
            'signer-key-sha256': createHash('sha256').update(input.keyId).digest('hex'),
          },
        }), { abortSignal: request.abortSignal });
        if (!response.VersionId) throw new Error('S3 Object Lock put returned no VersionId; bucket versioning is not effective.');
        return { immutableRef: `s3://${this.config.bucket}/${key}?versionId=${encodeURIComponent(response.VersionId)}` };
      } catch (cause) {
        const error = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (error.name !== 'PreconditionFailed' && error.$metadata?.httpStatusCode !== 412) throw cause;
        const existing = await this.client.send(new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ChecksumMode: 'ENABLED',
        }), { abortSignal: request.abortSignal });
        if (
          !existing.VersionId
          || existing.Metadata?.['content-sha256'] !== checksumHex
          || existing.Metadata?.['event-hash'] !== input.eventHash
          || existing.Metadata?.sequence !== input.sequence.toString()
          || existing.ObjectLockMode !== 'COMPLIANCE'
          || !existing.ObjectLockRetainUntilDate
        ) {
          throw new Error('Existing S3 audit anchor does not match the idempotent write.');
        }
        return { immutableRef: `s3://${this.config.bucket}/${key}?versionId=${encodeURIComponent(existing.VersionId)}` };
      }
    } finally {
      body.fill(0);
      request.cancel();
    }
  }
}

export interface ProductionGovernanceRuntime {
  readonly pool: Pool;
  readonly pseudonymizer: AwsKmsTenantPseudonymizer;
  readonly organization: PostgresOrganizationRepository;
  readonly retention: PostgresRetentionRepository;
  readonly erasure: PostgresTenantErasureRepository;
  readonly auditAppender: PostgresAuditChainAppender;
  readonly auditReader: PostgresTenantAuditChainReader;
  readonly auditSigner: AwsKmsAuditAnchorSigner;
  readonly auditAnchorStore: S3ObjectLockAuditAnchorStore;
  readonly auditAnchorPublisher: AuditChainAnchorPublisher;
  verifyReady(): Promise<void>;
  close(): Promise<void>;
}

export interface ProductionTenantErasureRequestRuntime {
  readonly pseudonymizer: AwsKmsTenantPseudonymizer;
  readonly erasure: PostgresTenantErasureRepository;
  verifyReady(): Promise<void>;
  close(): Promise<void>;
}

/** API-side composition for owner erasure requests. It has only KMS GenerateMac capability;
 * destructive adapters and audit-signing/object-store permissions remain worker-only. */
export function createProductionTenantErasureRequestRuntime(
  pool: GovernanceSqlPool,
  env: NodeJS.ProcessEnv = process.env,
): ProductionTenantErasureRequestRuntime {
  if ([env.AWS_ENDPOINT_URL, env.AWS_ENDPOINT_URL_KMS, env.KMS_ENDPOINT].some((value) => value?.trim())) {
    throw new GovernanceValidationError('AWS endpoint overrides are forbidden for production tenant-erasure requests.');
  }
  const region = awsRegion(env);
  const hmacKeyId = immutableKmsKeyArn(
    required(env, 'GOVERNANCE_HMAC_KMS_KEY_ID'),
    region,
    'GOVERNANCE_HMAC_KMS_KEY_ID',
  );
  const timeoutMs = positiveInt(env.GOVERNANCE_AWS_TIMEOUT_MS, 5_000, 500, 60_000, 'GOVERNANCE_AWS_TIMEOUT_MS');
  const maxAttempts = positiveInt(env.GOVERNANCE_AWS_MAX_ATTEMPTS, 3, 1, 10, 'GOVERNANCE_AWS_MAX_ATTEMPTS');
  const kms = new KMSClient({ region, maxAttempts });
  const pseudonymizer = new AwsKmsTenantPseudonymizer(kms, hmacKeyId, timeoutMs);
  const erasure = new PostgresTenantErasureRepository(pool, pseudonymizer);
  return {
    pseudonymizer,
    erasure,
    async verifyReady(): Promise<void> {
      await pseudonymizer.pseudonym('tenant', 'api-erasure-readiness-probe');
    },
    async close(): Promise<void> {
      kms.destroy();
    },
  };
}

/** Strict production composition: no local key, filesystem, in-memory, or optional AWS fallback. */
export function createProductionGovernanceRuntime(env: NodeJS.ProcessEnv = process.env): ProductionGovernanceRuntime {
  if ([env.AWS_ENDPOINT_URL, env.AWS_ENDPOINT_URL_KMS, env.AWS_ENDPOINT_URL_S3, env.KMS_ENDPOINT, env.S3_ENDPOINT]
    .some((value) => value?.trim())) {
    throw new GovernanceValidationError('AWS endpoint overrides are forbidden in the production governance runtime.');
  }
  const databaseUrl = productionDatabaseUrl(required(env, 'DATABASE_URL'));
  const region = awsRegion(env);
  const hmacKeyId = immutableKmsKeyArn(required(env, 'GOVERNANCE_HMAC_KMS_KEY_ID'), region, 'GOVERNANCE_HMAC_KMS_KEY_ID');
  const signingKeyId = immutableKmsKeyArn(required(env, 'AUDIT_SIGNING_KMS_KEY_ID'), region, 'AUDIT_SIGNING_KMS_KEY_ID');
  const anchorKmsKeyId = immutableKmsKeyArn(required(env, 'AUDIT_EXPORT_KMS_KEY_ID'), region, 'AUDIT_EXPORT_KMS_KEY_ID');
  const anchorBucket = required(env, 'AUDIT_EXPORT_S3_BUCKET');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(anchorBucket)) throw new GovernanceValidationError('AUDIT_EXPORT_S3_BUCKET is invalid.');
  const prefixValue = (env.AUDIT_EXPORT_S3_PREFIX?.trim() || 'sentinel-audit-anchors/').replace(/^\/+/, '');
  const prefix = prefixValue.endsWith('/') ? prefixValue : `${prefixValue}/`;
  if (prefix.includes('..') || prefix.length > 512) throw new GovernanceValidationError('AUDIT_ANCHOR_S3_PREFIX is invalid.');
  const retentionDays = positiveInt(env.AUDIT_RETENTION_DAYS, 2_555, 365, 3_650, 'AUDIT_RETENTION_DAYS');
  const awsTimeoutMs = positiveInt(env.GOVERNANCE_AWS_TIMEOUT_MS, 5_000, 500, 60_000, 'GOVERNANCE_AWS_TIMEOUT_MS');
  const maxAttempts = positiveInt(env.GOVERNANCE_AWS_MAX_ATTEMPTS, 3, 1, 10, 'GOVERNANCE_AWS_MAX_ATTEMPTS');
  const poolMax = positiveInt(env.GOVERNANCE_DATABASE_POOL_MAX, 10, 1, 100, 'GOVERNANCE_DATABASE_POOL_MAX');

  const pool = new Pool({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: positiveInt(env.GOVERNANCE_DATABASE_CONNECT_TIMEOUT_MS, 5_000, 500, 60_000, 'GOVERNANCE_DATABASE_CONNECT_TIMEOUT_MS'),
    idleTimeoutMillis: positiveInt(env.GOVERNANCE_DATABASE_IDLE_TIMEOUT_MS, 30_000, 1_000, 600_000, 'GOVERNANCE_DATABASE_IDLE_TIMEOUT_MS'),
    application_name: 'sentinel-governance',
  });
  const sqlPool = pool as unknown as GovernanceSqlPool;
  const kms = new KMSClient({ region, maxAttempts });
  const s3 = new S3Client({ region, maxAttempts });
  const pseudonymizer = new AwsKmsTenantPseudonymizer(kms, hmacKeyId, awsTimeoutMs);
  const signer = new AwsKmsAuditAnchorSigner(kms, signingKeyId, signingAlgorithm(env.AUDIT_SIGNING_ALGORITHM), awsTimeoutMs);
  const anchorStore = new S3ObjectLockAuditAnchorStore(s3, {
    bucket: anchorBucket,
    prefix,
    kmsKeyId: anchorKmsKeyId,
    retentionDays,
    timeoutMs: awsTimeoutMs,
  });
  const organization = new PostgresOrganizationRepository(sqlPool, pseudonymizer);
  const retention = new PostgresRetentionRepository(sqlPool);
  const erasure = new PostgresTenantErasureRepository(sqlPool, pseudonymizer);
  const auditAppender = new PostgresAuditChainAppender(sqlPool);
  const auditReader = new PostgresTenantAuditChainReader(sqlPool);
  const auditAnchorPublisher = new AuditChainAnchorPublisher(sqlPool, signer, anchorStore);

  return {
    pool,
    pseudonymizer,
    organization,
    retention,
    erasure,
    auditAppender,
    auditReader,
    auditSigner: signer,
    auditAnchorStore: anchorStore,
    auditAnchorPublisher,
    async verifyReady(): Promise<void> {
      await pool.query('SELECT 1 FROM "TenantErasureRequest" LIMIT 0');
      await anchorStore.verifyReady();
      await pseudonymizer.pseudonym('tenant', 'readiness-probe');
      const payload = Buffer.from('sentinel-audit-signing-readiness-v1', 'utf8');
      const signed = await signer.sign(payload);
      if (!await signer.verify({ keyId: signed.keyId, payload, signature: signed.signature })) {
        throw new Error('AWS KMS audit signing readiness verification failed.');
      }
    },
    async close(): Promise<void> {
      kms.destroy();
      s3.destroy();
      await pool.end();
    },
  };
}
