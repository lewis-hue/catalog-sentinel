import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

/**
 * Envelope encryption for sensitive session/state references. Every record gets
 * a fresh AES-256 data-encryption key (DEK). In production AWS KMS wraps that
 * DEK; a KMS key backed by an AWS CloudHSM custom key store uses this same API.
 * Plaintext references and plaintext DEKs are never persisted.
 */
const ALGO = 'aes-256-gcm';
const AWS_KMS_WRAPPER_NAME = 'aws-kms';
const LOCAL_WRAPPER_NAME = 'local';
const DEFAULT_KMS_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_KMS_MAX_ATTEMPTS = 3;
const DEFAULT_KMS_CONTEXT: Readonly<Record<string, string>> = Object.freeze({
  application: 'artist-catalog-sentinel',
  purpose: 'session-envelope',
});

export type Awaitable<T> = T | Promise<T>;

/** Common contract used by session consumers; local crypto is sync, KMS is async. */
export interface EnvelopeCrypto {
  readonly provider: 'local' | 'aws-kms';
  encrypt(plaintext: string): Awaitable<string>;
  decrypt(blob: string): Awaitable<string>;
}

/** Decode the configured local KEK without silently accepting malformed input. */
export function decodeMasterKeyBase64(value: string): Buffer {
  const canonical = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(canonical)) {
    throw new Error('ENCRYPTION_MASTER_KEY must be canonical base64 for exactly 32 random bytes.');
  }
  const decoded = Buffer.from(canonical, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== canonical) {
    throw new Error('ENCRYPTION_MASTER_KEY must be canonical base64 for exactly 32 random bytes.');
  }
  return decoded;
}

function decodeCanonicalBase64(value: string, label: string, maximumBytes?: number, allowEmpty = false): Buffer {
  if ((value.length === 0 && !allowEmpty) || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Malformed ${label}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (maximumBytes !== undefined && decoded.length > maximumBytes)) {
    throw new Error(`Malformed ${label}.`);
  }
  return decoded;
}

function gcmEncrypt(key: Buffer, plaintext: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Malformed envelope cipher parameters.');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function gcmEncryptUtf8(key: Buffer, plaintext: string): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const input = Buffer.from(plaintext, 'utf8');
  try { return gcmEncrypt(key, input); }
  finally { input.fill(0); }
}

function gcmDecryptUtf8(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string {
  const plaintext = gcmDecrypt(key, iv, tag, ct);
  try { return plaintext.toString('utf8'); }
  finally { plaintext.fill(0); }
}

/** Development/test-only local envelope implementation. */
export class EnvelopeEncryptor implements EnvelopeCrypto {
  readonly provider = 'local' as const;
  /** True when the master key was generated ephemerally (tests only). */
  readonly ephemeral: boolean;
  private readonly kek: Buffer;

  constructor(masterKeyBase64?: string) {
    if (masterKeyBase64 && masterKeyBase64.trim() !== '') {
      this.kek = decodeMasterKeyBase64(masterKeyBase64);
      this.ephemeral = false;
    } else {
      this.kek = randomBytes(32);
      this.ephemeral = true;
    }
  }

  encrypt(plaintext: string): string {
    const dek = randomBytes(32);
    try {
      const data = gcmEncryptUtf8(dek, plaintext);
      const wrapped = gcmEncrypt(this.kek, dek);
      return [
        'v1',
        wrapped.iv.toString('base64'),
        wrapped.tag.toString('base64'),
        wrapped.ct.toString('base64'),
        data.iv.toString('base64'),
        data.tag.toString('base64'),
        data.ct.toString('base64'),
      ].join('.');
    } finally {
      dek.fill(0);
    }
  }

  decrypt(blob: string): string {
    const parts = blob.split('.');
    if (parts.length !== 7 || parts[0] !== 'v1') throw new Error('Malformed local envelope blob.');
    const [, wIv, wTag, wDek, dIv, dTag, dCt] = parts as [string, string, string, string, string, string, string];
    const dek = gcmDecrypt(
      this.kek,
      decodeCanonicalBase64(wIv, 'wrapped-key IV', 12),
      decodeCanonicalBase64(wTag, 'wrapped-key tag', 16),
      decodeCanonicalBase64(wDek, 'wrapped data key', 32),
    );
    try {
      return gcmDecryptUtf8(
        dek,
        decodeCanonicalBase64(dIv, 'data IV', 12),
        decodeCanonicalBase64(dTag, 'data tag', 16),
        decodeCanonicalBase64(dCt, 'ciphertext', undefined, true),
      );
    } finally {
      dek.fill(0);
    }
  }
}

/** Wraps/unwraps exactly one 32-byte data key. */
export interface KeyWrapper {
  readonly name: 'local' | 'aws-kms';
  wrap(dek: Buffer): Promise<string>;
  unwrap(wrapped: string): Promise<Buffer>;
}

/** Local wrapper retained exclusively for development and tests. */
export class LocalKeyWrapper implements KeyWrapper {
  readonly name = LOCAL_WRAPPER_NAME;
  constructor(private readonly kek: Buffer) {
    if (kek.length !== 32) throw new Error('Local envelope KEK must be exactly 32 bytes.');
  }
  async wrap(dek: Buffer): Promise<string> {
    if (dek.length !== 32) throw new Error('Envelope DEK must be exactly 32 bytes.');
    const { iv, tag, ct } = gcmEncrypt(this.kek, dek);
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }
  async unwrap(wrapped: string): Promise<Buffer> {
    const buf = decodeCanonicalBase64(wrapped, 'local wrapped data key', 60);
    if (buf.length !== 60) throw new Error('Malformed local wrapped data key.');
    return gcmDecrypt(this.kek, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28));
  }
}

export interface KmsEncryptInput {
  KeyId: string;
  Plaintext: Buffer;
  EncryptionAlgorithm: 'SYMMETRIC_DEFAULT';
  EncryptionContext: Record<string, string>;
}

export interface KmsDecryptInput {
  KeyId: string;
  CiphertextBlob: Uint8Array;
  EncryptionAlgorithm: 'SYMMETRIC_DEFAULT';
  EncryptionContext: Record<string, string>;
}

/** Injectable boundary used by the wrapper and deterministic contract tests. */
export interface KmsClientLike {
  encrypt(input: KmsEncryptInput): Promise<{ CiphertextBlob: Uint8Array }>;
  decrypt(input: KmsDecryptInput): Promise<{ Plaintext: Uint8Array }>;
}

/** Official AWS SDK v3 adapter with a hard per-request deadline. */
export class AwsSdkKmsClientAdapter implements KmsClientLike {
  constructor(
    private readonly client: KMSClient,
    private readonly requestTimeoutMs = DEFAULT_KMS_REQUEST_TIMEOUT_MS,
  ) {}

  async encrypt(input: KmsEncryptInput): Promise<{ CiphertextBlob: Uint8Array }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('AWS KMS request deadline exceeded.')), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.client.send(new EncryptCommand(input), { abortSignal: controller.signal });
      if (!response.CiphertextBlob?.length) throw new Error('AWS KMS Encrypt returned no ciphertext.');
      return { CiphertextBlob: response.CiphertextBlob };
    } finally {
      clearTimeout(timeout);
    }
  }

  async decrypt(input: KmsDecryptInput): Promise<{ Plaintext: Uint8Array }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('AWS KMS request deadline exceeded.')), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.client.send(new DecryptCommand(input), { abortSignal: controller.signal });
      if (!response.Plaintext?.length) throw new Error('AWS KMS Decrypt returned no plaintext.');
      return { Plaintext: response.Plaintext };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** AWS KMS KEK. Encryption context and KeyId are supplied on both operations. */
export class KmsKeyWrapper implements KeyWrapper {
  readonly name = AWS_KMS_WRAPPER_NAME;
  private readonly context: Record<string, string>;

  constructor(
    private readonly client: KmsClientLike,
    private readonly keyId: string,
    encryptionContext: Readonly<Record<string, string>> = DEFAULT_KMS_CONTEXT,
  ) {
    if (!keyId.trim()) throw new Error('KMS_KEY_ID must not be empty.');
    this.context = { ...encryptionContext };
    if (Object.keys(this.context).length === 0) throw new Error('KMS encryption context must not be empty.');
  }

  async wrap(dek: Buffer): Promise<string> {
    if (dek.length !== 32) throw new Error('Envelope DEK must be exactly 32 bytes.');
    const result = await this.client.encrypt({
      KeyId: this.keyId,
      Plaintext: dek,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: this.context,
    });
    const wrapped = Buffer.from(result.CiphertextBlob);
    if (wrapped.length === 0 || wrapped.length > 6_144) throw new Error('AWS KMS returned an invalid wrapped data key.');
    return wrapped.toString('base64');
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const ciphertext = decodeCanonicalBase64(wrapped, 'KMS wrapped data key', 6_144);
    const result = await this.client.decrypt({
      KeyId: this.keyId,
      CiphertextBlob: ciphertext,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
      EncryptionContext: this.context,
    });
    const dek = Buffer.from(result.Plaintext);
    result.Plaintext.fill(0);
    if (dek.length !== 32) {
      dek.fill(0);
      throw new Error('AWS KMS returned an invalid data key.');
    }
    return dek;
  }
}

/** Async envelope implementation used by the production KMS path. */
export class AsyncEnvelopeEncryptor implements EnvelopeCrypto {
  readonly provider: 'local' | 'aws-kms';

  constructor(private readonly wrapper: KeyWrapper) {
    this.provider = wrapper.name;
  }

  async encrypt(plaintext: string): Promise<string> {
    const dek = randomBytes(32);
    try {
      const data = gcmEncryptUtf8(dek, plaintext);
      const wrappedDek = await this.wrapper.wrap(dek);
      return ['v2', this.wrapper.name, wrappedDek, data.iv.toString('base64'), data.tag.toString('base64'), data.ct.toString('base64')].join('.');
    } finally {
      dek.fill(0);
    }
  }

  async decrypt(blob: string): Promise<string> {
    const parts = blob.split('.');
    if (parts.length !== 6 || parts[0] !== 'v2' || parts[1] !== this.wrapper.name) {
      throw new Error('Malformed or incompatible v2 envelope blob.');
    }
    const [, , wrappedDek, dIv, dTag, dCt] = parts as [string, string, string, string, string, string];
    const dek = await this.wrapper.unwrap(wrappedDek);
    try {
      return gcmDecryptUtf8(
        dek,
        decodeCanonicalBase64(dIv, 'data IV', 12),
        decodeCanonicalBase64(dTag, 'data tag', 16),
        decodeCanonicalBase64(dCt, 'ciphertext', undefined, true),
      );
    } finally {
      dek.fill(0);
    }
  }
}

export interface KeyWrapperConfig {
  masterKeyBase64?: string;
  kmsKeyId?: string;
  kmsClient?: KmsClientLike;
  kmsEncryptionContext?: Readonly<Record<string, string>>;
}

export function createKeyWrapper(config: KeyWrapperConfig): KeyWrapper {
  if (config.kmsKeyId?.trim()) {
    if (!config.kmsClient) throw new Error('KMS_KEY_ID is set but no KMS client was provided.');
    return new KmsKeyWrapper(config.kmsClient, config.kmsKeyId.trim(), config.kmsEncryptionContext);
  }
  const kek = config.masterKeyBase64?.trim()
    ? decodeMasterKeyBase64(config.masterKeyBase64)
    : randomBytes(32);
  return new LocalKeyWrapper(kek);
}

export function createAsyncEnvelopeEncryptor(config: KeyWrapperConfig): AsyncEnvelopeEncryptor {
  return new AsyncEnvelopeEncryptor(createKeyWrapper(config));
}

export interface EnvelopeConfig {
  masterKeyBase64?: string;
  kmsKeyId?: string;
}

/** Legacy local factory retained for non-production tests and development only. */
export function createEnvelopeEncryptor(config: EnvelopeConfig = {}): EnvelopeEncryptor {
  if (config.kmsKeyId?.trim()) {
    throw new Error('Use envelopeEncryptorFromEnv for the asynchronous AWS KMS path.');
  }
  return new EnvelopeEncryptor(config.masterKeyBase64);
}

export interface EnvelopeRuntimeDeps {
  kmsClient?: KmsClientLike;
}

function parsePositiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseKmsEncryptionContext(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return { ...DEFAULT_KMS_CONTEXT };
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('KMS_ENCRYPTION_CONTEXT must be a JSON object of non-empty string keys and values.'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('KMS_ENCRYPTION_CONTEXT must be a JSON object of non-empty string keys and values.');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20 || entries.some(([key, item]) => !key || key.length > 256 || typeof item !== 'string' || !item || item.length > 256)) {
    throw new Error('KMS_ENCRYPTION_CONTEXT must contain 1-20 non-empty string keys and values of at most 256 characters.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Production context is explicit, non-secret, stable, and application-bound. */
export function parseProductionKmsEncryptionContext(value: string | undefined): Record<string, string> {
  if (!value?.trim()) throw new Error('KMS_ENCRYPTION_CONTEXT is required in production.');
  const context = parseKmsEncryptionContext(value);
  if (
    context.application !== 'artist-catalog-sentinel'
    || context.environment !== 'production'
    || context.purpose !== 'session-envelope'
  ) {
    throw new Error(
      'Production KMS_ENCRYPTION_CONTEXT must include application=artist-catalog-sentinel, environment=production, and purpose=session-envelope.',
    );
  }
  return context;
}

/** Pin production to an immutable key ARN; aliases can be repointed and strand old envelopes. */
export function validateProductionKmsKeyId(value: string, region: string): string {
  const keyId = value.trim();
  const match = /^arn:([a-z0-9-]+):kms:([^:]+):(\d{12}):key\/([A-Za-z0-9-]+)$/.exec(keyId);
  if (!match || match[2] !== region) {
    throw new Error('Production KMS_KEY_ID must be a full KMS key ARN in AWS_REGION; aliases and bare key IDs are not accepted.');
  }
  return keyId;
}

function productionRegion(env: NodeJS.ProcessEnv): string {
  const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim();
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
    throw new Error('AWS_REGION (or AWS_DEFAULT_REGION) is required and must be a valid AWS region when KMS_KEY_ID is set.');
  }
  return region;
}

function productionEnvironment(env: NodeJS.ProcessEnv): boolean {
  return [env.DEPLOYMENT_ENV, env.APP_ENV, env.NODE_ENV]
    .some((value) => value?.trim().toLowerCase() === 'production');
}

function testEnvironment(env: NodeJS.ProcessEnv): boolean {
  return !productionEnvironment(env) && (
    Boolean(env.VITEST)
    || [env.DEPLOYMENT_ENV, env.APP_ENV, env.NODE_ENV]
      .some((value) => value?.trim().toLowerCase() === 'test')
  );
}

/**
 * Build the process encryption provider. Production has exactly one valid path:
 * AWS KMS. Local deterministic/ephemeral keys are rejected in production.
 */
export function envelopeEncryptorFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnvelopeRuntimeDeps = {},
): EnvelopeCrypto {
  const kmsKeyId = env.KMS_KEY_ID?.trim();
  if (kmsKeyId) {
    const region = productionRegion(env);
    const production = productionEnvironment(env);
    if (production && [env.KMS_ENDPOINT, env.AWS_ENDPOINT_URL_KMS, env.AWS_ENDPOINT_URL].some((value) => value?.trim())) {
      throw new Error('Custom AWS/KMS endpoints are not permitted in production; use the AWS regional KMS endpoint or its CloudHSM custom key store.');
    }
    const requestTimeoutMs = parsePositiveInteger(env.KMS_REQUEST_TIMEOUT_MS, DEFAULT_KMS_REQUEST_TIMEOUT_MS, 100, 60_000, 'KMS_REQUEST_TIMEOUT_MS');
    const maxAttempts = parsePositiveInteger(env.KMS_MAX_ATTEMPTS, DEFAULT_KMS_MAX_ATTEMPTS, 1, 10, 'KMS_MAX_ATTEMPTS');
    const resolvedKeyId = production ? validateProductionKmsKeyId(kmsKeyId, region) : kmsKeyId;
    const encryptionContext = production
      ? parseProductionKmsEncryptionContext(env.KMS_ENCRYPTION_CONTEXT)
      : parseKmsEncryptionContext(env.KMS_ENCRYPTION_CONTEXT);
    const client = deps.kmsClient ?? new AwsSdkKmsClientAdapter(new KMSClient({
      region,
      maxAttempts,
      ignoreConfiguredEndpointUrls: production,
      ...(env.KMS_ENDPOINT?.trim() ? { endpoint: env.KMS_ENDPOINT.trim() } : {}),
    }), requestTimeoutMs);
    return new AsyncEnvelopeEncryptor(new KmsKeyWrapper(client, resolvedKeyId, encryptionContext));
  }

  if (productionEnvironment(env)) {
    throw new Error('KMS_KEY_ID is required for production envelope encryption; local master keys are forbidden.');
  }
  if (!env.ENCRYPTION_MASTER_KEY?.trim() && !testEnvironment(env)) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for local development envelope encryption.');
  }
  return new EnvelopeEncryptor(env.ENCRYPTION_MASTER_KEY);
}

/** Fail startup unless the selected provider can perform an authenticated round trip. */
export async function verifyEnvelopeEncryptor(encryptor: EnvelopeCrypto): Promise<void> {
  const challenge = randomBytes(32);
  const plaintext = challenge.toString('base64');
  try {
    const blob = await encryptor.encrypt(plaintext);
    const recovered = Buffer.from(await encryptor.decrypt(blob), 'base64');
    try {
      if (recovered.length !== challenge.length || !timingSafeEqual(recovered, challenge)) {
        throw new Error('Envelope encryption readiness round trip did not match.');
      }
    } finally { recovered.fill(0); }
  } finally {
    challenge.fill(0);
  }
}
