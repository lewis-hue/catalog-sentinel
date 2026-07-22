import { describe, it, expect } from 'vitest';
import { S3ObjectStore, type S3Backend, type S3PutInput } from './object-store';

/** Recording implementation of the narrow S3 backend for isolated tests. */
function recordingBackend() {
  const puts: S3PutInput[] = [];
  const store = new Map<string, Buffer>();
  const presigned: Array<{ Bucket: string; Key: string; expiresInSeconds: number }> = [];
  const backend: S3Backend = {
    async putObject(input) {
      puts.push(input);
      store.set(`${input.Bucket}/${input.Key}`, input.Body);
    },
    async getObject(input) {
      const b = store.get(`${input.Bucket}/${input.Key}`);
      if (!b) throw new Error('NoSuchKey');
      return { body: b };
    },
    async presignGetUrl(input) {
      presigned.push(input);
      return `https://${input.Bucket}.s3.amazonaws.com/${input.Key}?X-Amz-Expires=${input.expiresInSeconds}&X-Amz-Signature=test-signature`;
    },
  };
  return { backend, puts, presigned };
}

describe('S3ObjectStore', () => {
  it('applies SSE-KMS, key prefix, and returns an s3:// ref', async () => {
    const f = recordingBackend();
    const store = new S3ObjectStore(f.backend, { bucket: 'sentinel-artifacts', kmsKeyId: 'arn:aws:kms:us-east-1:1:key/abc', keyPrefix: 'artifacts/' });

    const out = await store.put('scan-1/report.csv', 'a,b,c\n1,2,3\n', 'text/csv');

    expect(out.ref).toBe('s3://sentinel-artifacts/artifacts/scan-1/report.csv');
    expect(out.byteSize).toBe(Buffer.byteLength('a,b,c\n1,2,3\n'));
    const put = f.puts[0]!;
    expect(put.Bucket).toBe('sentinel-artifacts');
    expect(put.Key).toBe('artifacts/scan-1/report.csv');
    expect(put.ContentType).toBe('text/csv');
    expect(put.ServerSideEncryption).toBe('aws:kms');
    expect(put.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:1:key/abc');
  });

  it('omits SSE fields when no KMS key is configured', async () => {
    const f = recordingBackend();
    const store = new S3ObjectStore(f.backend, { bucket: 'b' });
    await store.put('k.txt', 'hi');
    expect(f.puts[0]!.ServerSideEncryption).toBeUndefined();
    expect(f.puts[0]!.SSEKMSKeyId).toBeUndefined();
  });

  it('round-trips content via getByRef', async () => {
    const f = recordingBackend();
    const store = new S3ObjectStore(f.backend, { bucket: 'b', keyPrefix: 'p' });
    const { ref } = await store.put('doc.json', Buffer.from('{"x":1}'));
    const got = await store.getByRef(ref);
    expect(got?.toString('utf8')).toBe('{"x":1}');
  });

  it('mints a pre-signed URL with the configured TTL', async () => {
    const f = recordingBackend();
    const store = new S3ObjectStore(f.backend, { bucket: 'b', urlTtlSeconds: 120 });
    const { ref } = await store.put('r.pdf', Buffer.from('%PDF'));
    const url = await store.presignedGetUrl(ref);
    expect(url).toContain('X-Amz-Expires=120');
    expect(f.presigned[0]).toMatchObject({ Bucket: 'b', Key: 'r.pdf', expiresInSeconds: 120 });
    // Explicit TTL override wins.
    await store.presignedGetUrl(ref, 30);
    expect(f.presigned[1]!.expiresInSeconds).toBe(30);
  });

  it('refuses refs from another bucket (no cross-bucket reads)', async () => {
    const f = recordingBackend();
    const store = new S3ObjectStore(f.backend, { bucket: 'mine' });
    expect(await store.getByRef('s3://someone-else/secret.txt')).toBeNull();
    await expect(store.presignedGetUrl('s3://someone-else/secret.txt')).rejects.toThrow();
  });
});
