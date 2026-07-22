import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed, expiring URLs for report/evidence downloads (PRD §K). In AWS this
 * is typically an S3 pre-signed URL; this provider covers the local-fs object
 * store and any download route the API serves itself.
 */
export interface SignedUrlParams {
  path: string;
  expiresAtEpochMs: number;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signPath(params: SignedUrlParams, secret: string): string {
  const payload = `${params.path}:${params.expiresAtEpochMs}`;
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'expired' | 'bad-signature';
}

export function verifySignedPath(params: SignedUrlParams, signature: string, secret: string, now: number): VerifyResult {
  if (now > params.expiresAtEpochMs) return { valid: false, reason: 'expired' };
  const expected = signPath(params, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { valid: false, reason: 'bad-signature' };
  return { valid: true };
}

export function buildSignedDownloadUrl(baseUrl: string, path: string, ttlMs: number, secret: string, now: number): string {
  const expiresAtEpochMs = now + ttlMs;
  const sig = signPath({ path, expiresAtEpochMs }, secret);
  const u = new URL(path, baseUrl);
  u.searchParams.set('expires', String(expiresAtEpochMs));
  u.searchParams.set('sig', sig);
  return u.toString();
}
