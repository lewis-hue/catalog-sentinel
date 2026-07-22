import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const REQUIRED_SCOPES = [
  'distrokid:attended-read',
  'distrokid:passive-network-observation',
  'steel:session-processing',
  'catalogue:metadata-retention',
] as const;
const REQUIRED_APPROVER_ROLES = ['legal', 'privacy', 'security'] as const;
const MAX_BUNDLE_BYTES = 32 * 1024;
const MAX_APPROVAL_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface ComplianceApprovalClaims {
  schemaVersion: 1;
  approvalId: string;
  issuer: string;
  audience: 'artist-catalog-sentinel-production';
  environment: 'production';
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  scopes: string[];
  accountAuthorizationReference: string;
  policyReferences: {
    distroKidTermsReview: string;
    steelDpa: string;
    awsDpa: string;
    privacyNotice: string;
    retentionSchedule: string;
  };
  approvedBy: Array<{ role: 'legal' | 'privacy' | 'security'; subject: string }>;
  limits: {
    maxSessionDurationMs: number;
    maxReleasesPerScan: number;
    maxOperationalRetentionDays: number;
  };
}

export interface VerifiedComplianceApproval {
  claims: ComplianceApprovalClaims;
  keyId: string;
  bundleSha256: string;
}

export class ComplianceApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceApprovalError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ComplianceApprovalError(`${name} is required for production live scanning.`);
  return value;
}

function decodeSegment(segment: string, label: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new ComplianceApprovalError(`Compliance approval ${label} is not canonical base64url.`);
  try {
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) throw new Error('non-canonical');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ComplianceApprovalError(`Compliance approval ${label} is invalid JSON.`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComplianceApprovalError(`Compliance approval ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 1_024) {
    throw new ComplianceApprovalError(`Compliance approval ${label} must be a non-empty bounded string.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ComplianceApprovalError(`Compliance approval ${label} is outside the permitted range.`);
  }
  return value as number;
}

function configuredInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ComplianceApprovalError(`${name} must be a positive integer.`);
  return value;
}

function parseClaims(raw: unknown): ComplianceApprovalClaims {
  const claims = object(raw, 'payload');
  if (claims.schemaVersion !== 1) throw new ComplianceApprovalError('Compliance approval schemaVersion must be 1.');
  if (claims.audience !== 'artist-catalog-sentinel-production') {
    throw new ComplianceApprovalError('Compliance approval audience is invalid.');
  }
  if (claims.environment !== 'production') throw new ComplianceApprovalError('Compliance approval is not for production.');

  const scopes = claims.scopes;
  if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
    throw new ComplianceApprovalError('Compliance approval scopes must be an array of strings.');
  }
  for (const requiredScope of REQUIRED_SCOPES) {
    if (!scopes.includes(requiredScope)) throw new ComplianceApprovalError(`Compliance approval is missing scope ${requiredScope}.`);
  }

  const references = object(claims.policyReferences, 'policyReferences');
  const approvers = claims.approvedBy;
  if (!Array.isArray(approvers)) throw new ComplianceApprovalError('Compliance approval approvedBy must be an array.');
  const parsedApprovers = approvers.map((entry, index) => {
    const approver = object(entry, `approvedBy[${index}]`);
    if (!REQUIRED_APPROVER_ROLES.includes(approver.role as (typeof REQUIRED_APPROVER_ROLES)[number])) {
      throw new ComplianceApprovalError(`Compliance approval approvedBy[${index}].role is invalid.`);
    }
    return {
      role: approver.role as ComplianceApprovalClaims['approvedBy'][number]['role'],
      subject: text(approver.subject, `approvedBy[${index}].subject`),
    };
  });
  for (const requiredRole of REQUIRED_APPROVER_ROLES) {
    if (!parsedApprovers.some(({ role }) => role === requiredRole)) {
      throw new ComplianceApprovalError(`Compliance approval requires a ${requiredRole} approver.`);
    }
  }

  const limits = object(claims.limits, 'limits');
  return {
    schemaVersion: 1,
    approvalId: text(claims.approvalId, 'approvalId'),
    issuer: text(claims.issuer, 'issuer'),
    audience: 'artist-catalog-sentinel-production',
    environment: 'production',
    issuedAt: integer(claims.issuedAt, 'issuedAt', 1, Number.MAX_SAFE_INTEGER),
    notBefore: integer(claims.notBefore, 'notBefore', 1, Number.MAX_SAFE_INTEGER),
    expiresAt: integer(claims.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER),
    scopes: [...new Set(scopes)],
    accountAuthorizationReference: text(claims.accountAuthorizationReference, 'accountAuthorizationReference'),
    policyReferences: {
      distroKidTermsReview: text(references.distroKidTermsReview, 'policyReferences.distroKidTermsReview'),
      steelDpa: text(references.steelDpa, 'policyReferences.steelDpa'),
      awsDpa: text(references.awsDpa, 'policyReferences.awsDpa'),
      privacyNotice: text(references.privacyNotice, 'policyReferences.privacyNotice'),
      retentionSchedule: text(references.retentionSchedule, 'policyReferences.retentionSchedule'),
    },
    approvedBy: parsedApprovers,
    limits: {
      maxSessionDurationMs: integer(limits.maxSessionDurationMs, 'limits.maxSessionDurationMs', 60_000, 86_400_000),
      maxReleasesPerScan: integer(limits.maxReleasesPerScan, 'limits.maxReleasesPerScan', 1, 100_000),
      maxOperationalRetentionDays: integer(limits.maxOperationalRetentionDays, 'limits.maxOperationalRetentionDays', 1, 3_650),
    },
  };
}

/**
 * Verify the legal/privacy/security release approval without any network lookup.
 * The compact JWS must be RS256-signed by the separately controlled public key
 * configured in the production secret. Boolean feature flags cannot satisfy this gate.
 */
export function verifyComplianceApproval(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): VerifiedComplianceApproval {
  const bundle = required(env, 'COMPLIANCE_APPROVAL_BUNDLE');
  if (Buffer.byteLength(bundle, 'utf8') > MAX_BUNDLE_BYTES) throw new ComplianceApprovalError('Compliance approval bundle is too large.');
  const segments = bundle.split('.');
  if (segments.length !== 3 || segments.some((segment) => !segment)) {
    throw new ComplianceApprovalError('COMPLIANCE_APPROVAL_BUNDLE must be a compact JWS.');
  }
  const [protectedHeader, payload, encodedSignature] = segments as [string, string, string];

  const header = object(decodeSegment(protectedHeader, 'header'), 'header');
  const permittedHeaders = new Set(['alg', 'typ', 'kid']);
  if (Object.keys(header).some((name) => !permittedHeaders.has(name))) {
    throw new ComplianceApprovalError('Compliance approval contains an unsupported protected header.');
  }
  if (header.alg !== 'RS256' || header.typ !== 'JWT') {
    throw new ComplianceApprovalError('Compliance approval must use an RS256 JWT protected header.');
  }
  const expectedKeyId = required(env, 'COMPLIANCE_APPROVAL_KEY_ID');
  if (header.kid !== expectedKeyId) throw new ComplianceApprovalError('Compliance approval key id does not match the configured approval key.');

  let publicKey;
  try {
    publicKey = createPublicKey(required(env, 'COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM'));
  } catch {
    throw new ComplianceApprovalError('COMPLIANCE_APPROVAL_PUBLIC_KEY_PEM is not a valid public key.');
  }
  if (publicKey.asymmetricKeyType !== 'rsa') throw new ComplianceApprovalError('Compliance approval public key must be RSA.');
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) throw new ComplianceApprovalError('Compliance approval signature is not canonical base64url.');
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.toString('base64url') !== encodedSignature) throw new ComplianceApprovalError('Compliance approval signature is not canonical base64url.');
  const signingInput = Buffer.from(`${protectedHeader}.${payload}`, 'ascii');
  if (!verifySignature('RSA-SHA256', signingInput, publicKey, signature)) {
    throw new ComplianceApprovalError('Compliance approval signature is invalid.');
  }

  const claims = parseClaims(decodeSegment(payload, 'payload'));
  if (claims.issuer !== required(env, 'COMPLIANCE_APPROVAL_ISSUER')) {
    throw new ComplianceApprovalError('Compliance approval issuer does not match the configured issuer.');
  }
  const epochSeconds = Math.floor(now.getTime() / 1_000);
  if (claims.issuedAt > epochSeconds + CLOCK_SKEW_SECONDS) throw new ComplianceApprovalError('Compliance approval was issued in the future.');
  if (claims.notBefore > epochSeconds + CLOCK_SKEW_SECONDS) throw new ComplianceApprovalError('Compliance approval is not active yet.');
  if (claims.expiresAt <= epochSeconds - CLOCK_SKEW_SECONDS) throw new ComplianceApprovalError('Compliance approval has expired.');
  if (claims.notBefore < claims.issuedAt || claims.expiresAt <= claims.notBefore) {
    throw new ComplianceApprovalError('Compliance approval time window is invalid.');
  }
  if (claims.expiresAt - claims.issuedAt > MAX_APPROVAL_LIFETIME_SECONDS) {
    throw new ComplianceApprovalError('Compliance approval lifetime cannot exceed 90 days.');
  }

  const configuredSessionMs = configuredInteger(env, 'STEEL_SESSION_TIMEOUT_MS');
  const configuredReleaseCap = configuredInteger(env, 'CATALOG_READ_MAX_RELEASES');
  const configuredRetentionDays = configuredInteger(env, 'DATA_RETENTION_DAYS');
  if (configuredSessionMs > claims.limits.maxSessionDurationMs) {
    throw new ComplianceApprovalError('STEEL_SESSION_TIMEOUT_MS exceeds the signed approval limit.');
  }
  if (configuredReleaseCap > claims.limits.maxReleasesPerScan) {
    throw new ComplianceApprovalError('CATALOG_READ_MAX_RELEASES exceeds the signed approval limit.');
  }
  if (configuredRetentionDays > claims.limits.maxOperationalRetentionDays) {
    throw new ComplianceApprovalError('DATA_RETENTION_DAYS exceeds the signed approval limit.');
  }

  return {
    claims,
    keyId: expectedKeyId,
    bundleSha256: createHash('sha256').update(bundle, 'utf8').digest('hex'),
  };
}
