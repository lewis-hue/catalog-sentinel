/**
 * Object storage abstraction for report/evidence artifacts. Runtime composition
 * uses durable S3 storage with a customer-managed KMS key.
 */
export interface StoredObject {
  ref: string;
  byteSize: number;
}

export interface ObjectStore {
  readonly provider: string;
  put(key: string, content: string | Buffer, contentType?: string): Promise<StoredObject>;
}

/**
 * Object store that can also read back an artifact and mint a short-lived
 * pre-signed download URL. Implemented by {@link S3ObjectStore} for production.
 */
export interface SignedUrlObjectStore extends ObjectStore {
  getByRef(ref: string): Promise<Buffer | null>;
  presignedGetUrl(ref: string, ttlSeconds?: number): Promise<string>;
}

/**
 * Narrow S3 backend the store depends on — the subset of `@aws-sdk/client-s3` +
 * `@aws-sdk/s3-request-presigner` we use. Typed by hand so this package compiles
 * and tests run WITHOUT the AWS SDK installed; the real backend
 * ({@link createAwsS3Backend}) satisfies it at runtime.
 */
export interface S3PutInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType?: string;
  /** SSE-KMS: server-side encryption with a customer-managed KMS key. */
  ServerSideEncryption?: 'aws:kms';
  SSEKMSKeyId?: string;
}
export interface S3Backend {
  putObject(input: S3PutInput): Promise<void>;
  getObject(input: { Bucket: string; Key: string }): Promise<{ body: Buffer }>;
  presignGetUrl(input: { Bucket: string; Key: string; expiresInSeconds: number }): Promise<string>;
}

export interface S3ObjectStoreConfig {
  bucket: string;
  /** KMS key id/arn for SSE-KMS. When set, every object is encrypted with it. */
  kmsKeyId?: string;
  /** Key namespace, e.g. "artifacts/". */
  keyPrefix?: string;
  /** Default pre-signed URL lifetime (seconds). */
  urlTtlSeconds?: number;
}

/**
 * S3-backed artifact store with KMS server-side encryption (SSE-KMS) and
 * short-lived pre-signed download URLs. Objects are encrypted at rest with the
 * customer KMS key, so
 * a pre-signed GET streams plaintext to the authorized caller while the bytes at
 * rest stay KMS-encrypted. Depends only on the narrow {@link S3Backend}, so it is
 * unit-testable without the AWS SDK or a real bucket.
 */
export class S3ObjectStore implements SignedUrlObjectStore {
  readonly provider = 's3';
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(
    private readonly backend: S3Backend,
    private readonly cfg: S3ObjectStoreConfig,
  ) {
    if (!cfg.bucket) throw new Error('S3ObjectStore requires a bucket.');
    this.prefix = cfg.keyPrefix ? cfg.keyPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
    this.ttl = cfg.urlTtlSeconds ?? 900;
  }

  async put(key: string, content: string | Buffer, contentType?: string): Promise<StoredObject> {
    const Body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const Key = this.prefix + key.replace(/^\/+/, '');
    await this.backend.putObject({
      Bucket: this.cfg.bucket,
      Key,
      Body,
      ...(contentType ? { ContentType: contentType } : {}),
      ...(this.cfg.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.cfg.kmsKeyId } : {}),
    });
    return { ref: `s3://${this.cfg.bucket}/${Key}`, byteSize: Body.byteLength };
  }

  async getByRef(ref: string): Promise<Buffer | null> {
    const loc = this.parseRef(ref);
    if (!loc) return null;
    try {
      const res = await this.backend.getObject(loc);
      return res.body;
    } catch {
      return null;
    }
  }

  async presignedGetUrl(ref: string, ttlSeconds?: number): Promise<string> {
    const loc = this.parseRef(ref);
    if (!loc) throw new Error(`Not an S3 ref for this store: ${ref}`);
    return this.backend.presignGetUrl({ ...loc, expiresInSeconds: ttlSeconds ?? this.ttl });
  }

  private parseRef(ref: string): { Bucket: string; Key: string } | null {
    const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) return null;
    const bucket = m[1]!;
    const key = m[2]!;
    // Only serve objects from this store's own bucket.
    return bucket === this.cfg.bucket ? { Bucket: bucket, Key: key } : null;
  }
}
