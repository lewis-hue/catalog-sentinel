import { describe, expect, it } from 'vitest';
import { createObjectStore } from './object-store-factory';

describe('createObjectStore', () => {
  it('refuses to start without durable S3 storage', async () => {
    await expect(createObjectStore({} as NodeJS.ProcessEnv)).rejects.toThrow('ARTIFACT_S3_BUCKET is required');
  });

  it('refuses to start without a customer-managed KMS key', async () => {
    await expect(
      createObjectStore({ ARTIFACT_S3_BUCKET: 'sentinel-artifacts' } as NodeJS.ProcessEnv),
    ).rejects.toThrow('ARTIFACT_KMS_KEY_ID is required');
  });

  it('validates the signed URL lifetime before opening an AWS client', async () => {
    await expect(
      createObjectStore({
        ARTIFACT_S3_BUCKET: 'sentinel-artifacts',
        ARTIFACT_KMS_KEY_ID: 'arn:aws:kms:us-east-1:123456789012:key/fixture',
        ARTIFACT_URL_TTL_SECONDS: '59',
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow('ARTIFACT_URL_TTL_SECONDS must be an integer between 60 and 3600');
  });
});
