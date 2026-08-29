/**
 * Security + privacy boundary for distributor network capture.
 *
 * We are observing an AUTHENTICATED dashboard. Its traffic contains cookies, auth headers,
 * tokens, and (on some routes) banking/tax/payment/profile data. None of that may ever reach a
 * log, a database, or a metric label.
 *
 * Rules enforced here:
 *  - Same-origin ALLOWLIST: only the distributor's own hosts are ever inspected.
 *  - Sensitive-path DENYLIST: money/identity/auth routes are never read at all.
 *  - Size caps: never buffer an unbounded body.
 *  - Values are never retained, only key NAMES, shapes, and hashes.
 *  - Raw debug artifacts are opt-in, TTL'd, sample-capped, and redacted.
 */

/** Query/JSON keys whose VALUES must never be retained, even in a "shape" summary. */
const SENSITIVE_KEY = /(cookie|authorization|auth|token|bearer|session|password|passwd|secret|apikey|api_key|accesstoken|refreshtoken|csrf|xsrf|otp|totp|2fa|ssn|taxid|iban|account_number|routing|card|cvv|email|phone|address|dob|birth)/i;

/** Paths that are never catalog data and may carry money/identity/auth material. */
const SENSITIVE_PATH = /(bank|tax|payment|payout|billing|invoice|card|wallet|ssn|address|password|signin|login|logout|2fa|totp|mfa|security|session|token|oauth|auth|account\/settings|profile\/edit)/i;

/** Hard ceiling on any single response body we will read into memory. */
export const MAX_CAPTURE_BODY_BYTES = 8 * 1024 * 1024;

/** Distributor host allowlist. Only these origins are ever inspected. */
export const DISTRIBUTOR_HOSTS: Record<string, string> = {
  distrokid: 'distrokid.com',
  cdbaby: 'cdbaby.com',
  tunecore: 'tunecore.com',
  unitedmasters: 'unitedmasters.com',
  ditto: 'dittomusic.com',
  amuse: 'amuse.io',
};

export function isAllowedHost(hostname: string, origin: string): boolean {
  return hostname === origin || hostname.endsWith(`.${origin}`);
}

export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATH.test(pathname);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Is this URL safe to inspect for catalog data?
 * Must be the distributor's own origin AND not a sensitive route.
 */
export function isInspectableUrl(rawUrl: string, origin: string): boolean {
  try {
    const u = new URL(rawUrl);
    return isAllowedHost(u.hostname, origin) && !isSensitivePath(u.pathname);
  } catch {
    return false;
  }
}

/** Mask ids in a path so fingerprints are stable and carry no identifiers. */
export function maskPath(pathname: string): string {
  return pathname
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{12,}/g, '{uuid}')
    .replace(/\/[0-9a-fA-F]{24,}/g, '/{hash}')
    .replace(/\/\d{4,}/g, '/{n}');
}

/**
 * Sanitized query KEY names. Values are dropped entirely; sensitive keys are masked so we don't
 * even reveal that (e.g.) an `access_token` parameter name was present with a value.
 */
export function sanitizedQueryKeys(url: URL): string[] {
  return [...url.searchParams.keys()].map((k) => (isSensitiveKey(k) ? '{redacted}' : k)).sort();
}

/** Redact an error to a category. Never let a message carry a body/header/token. */
export function redactError(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Deeply redact a payload for a TEMPORARY, opt-in debug artifact: keeps structure and key names,
 * replaces every scalar with a type token, and drops sensitive keys entirely. Even when debug is
 * enabled, no real values leave the process.
 */
export function redactPayloadShape(value: unknown, depth = 0): unknown {
  if (depth > 6) return '{depth-capped}';
  if (value === null) return null;
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => redactPayloadShape(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? '{redacted}' : redactPayloadShape(v, depth + 1);
    }
    return out;
  }
  return `{${typeof value}}`;
}

/** Temporary raw-debug configuration. OFF by default; TTL'd and sample-capped when on. */
export interface NetworkDebugConfig {
  enabled: boolean;
  ttlMinutes: number;
  sampleLimit: number;
}

export function readNetworkDebugConfig(env: NodeJS.ProcessEnv): NetworkDebugConfig {
  return {
    enabled: /^(1|true|yes|on)$/i.test(env.ENABLE_DISTRIBUTOR_NETWORK_DEBUG ?? ''),
    ttlMinutes: Number(env.DISTRIBUTOR_NETWORK_DEBUG_TTL_MINUTES) || 30,
    sampleLimit: Number(env.DISTRIBUTOR_NETWORK_DEBUG_SAMPLE_LIMIT) || 5,
  };
}

/** Has a TTL'd debug artifact expired and become ineligible to read? */
export function isDebugArtifactExpired(createdAtIso: string, cfg: NetworkDebugConfig, nowMs = Date.now()): boolean {
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return true;
  return nowMs - created > cfg.ttlMinutes * 60_000;
}
