import {
  S3ObjectStore,
  type ObjectStore,
  type S3Backend,
  type S3PutInput,
} from './object-store';

/**
 * Build a real {@link S3Backend} over the AWS SDK. The SDK packages are imported
 * DYNAMICALLY so `@sentinel/engine` compiles and its tests run without them
 * installed, they're only needed when S3 is actually configured at runtime.
 *
 * Requires `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.
 */
export async function createAwsS3Backend(opts: { region?: string } = {}): Promise<S3Backend> {
  let s3mod: {
    S3Client: new (cfg: unknown) => { send: (cmd: unknown) => Promise<unknown> };
    PutObjectCommand: new (input: unknown) => unknown;
    GetObjectCommand: new (input: unknown) => unknown;
  };
  let presignMod: { getSignedUrl: (client: unknown, command: unknown, opts: { expiresIn: number }) => Promise<string> };
  try {
    s3mod = (await import('@aws-sdk/client-s3' as string)) as typeof s3mod;
    presignMod = (await import('@aws-sdk/s3-request-presigner' as string)) as typeof presignMod;
  } catch (err) {
    throw new Error(
      `S3 is configured but the AWS SDK is not available. Install "@aws-sdk/client-s3" and "@aws-sdk/s3-request-presigner". Cause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const client = new s3mod.S3Client(opts.region ? { region: opts.region } : {});

  return {
    async putObject(input: S3PutInput): Promise<void> {
      await client.send(new s3mod.PutObjectCommand(input));
    },
    async getObject(input): Promise<{ body: Buffer }> {
      const res = (await client.send(new s3mod.GetObjectCommand(input))) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
      const bytes = res.Body?.transformToByteArray ? await res.Body.transformToByteArray() : new Uint8Array();
      return { body: Buffer.from(bytes) };
    },
    async presignGetUrl(input): Promise<string> {
      const command = new s3mod.GetObjectCommand({ Bucket: input.Bucket, Key: input.Key });
      return presignMod.getSignedUrl(client, command, { expiresIn: input.expiresInSeconds });
    },
  };
}

/**
 * Build the durable artifact store from the environment. Runtime artifacts are
 * always written to S3 using SSE-KMS; process-local storage is intentionally not
 * a runtime option.
 */
export async function createObjectStore(env: NodeJS.ProcessEnv = process.env): Promise<ObjectStore> {
  const bucket = env.ARTIFACT_S3_BUCKET?.trim();
  const kmsKeyId = env.ARTIFACT_KMS_KEY_ID?.trim();
  if (!bucket) {
    throw new Error('ARTIFACT_S3_BUCKET is required; runtime artifacts must use durable S3 storage.');
  }
  if (!kmsKeyId) {
    throw new Error('ARTIFACT_KMS_KEY_ID is required; runtime artifacts must be encrypted with SSE-KMS.');
  }

  let urlTtlSeconds: number | undefined;
  if (env.ARTIFACT_URL_TTL_SECONDS?.trim()) {
    urlTtlSeconds = Number(env.ARTIFACT_URL_TTL_SECONDS);
    if (!Number.isInteger(urlTtlSeconds) || urlTtlSeconds < 60 || urlTtlSeconds > 3_600) {
      throw new Error('ARTIFACT_URL_TTL_SECONDS must be an integer between 60 and 3600.');
    }
  }

  const backend = await createAwsS3Backend({ ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) });
  return new S3ObjectStore(backend, {
    bucket,
    kmsKeyId,
    ...(env.ARTIFACT_S3_PREFIX ? { keyPrefix: env.ARTIFACT_S3_PREFIX } : {}),
    ...(urlTtlSeconds !== undefined ? { urlTtlSeconds } : {}),
  });
}
