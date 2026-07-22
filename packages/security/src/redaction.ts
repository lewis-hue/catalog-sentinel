/**
 * Secret & PII redaction. Applied to everything that gets logged, stored as
 * evidence, or exported. The system NEVER persists raw passwords/tokens; this is
 * the defense-in-depth layer that scrubs anything that slips into a payload.
 */

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always scrubbed, matched case-insensitively. */
const SENSITIVE_KEY_RE =
  /(pass(word|phrase)?|secret|token|authorization|auth|cookie|session|api[-_ ]?key|client[-_ ]?secret|private[-_ ]?key|credential|access[-_ ]?key|refresh[-_ ]?token|otp|mfa|pin|ssn|card|cvv)/i;

/** Value patterns scrubbed regardless of key name. */
const VALUE_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /Bearer\s+[A-Za-z0-9._~+/-]+=*/g, replace: `Bearer ${REDACTED}` },
  { re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replace: REDACTED }, // JWT
  { re: /\b(?:sk|pk|rk|whsec|xox[baprs])[-_][A-Za-z0-9]{12,}\b/g, replace: REDACTED }, // provider keys
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED }, // AWS access key id
  { re: /\b[A-Fa-f0-9]{40,}\b/g, replace: REDACTED }, // long hex secrets
];

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Redact secret substrings inside a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const { re, replace } of VALUE_PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Mask an email for evidence: "j****@domain.com" (keeps first char + domain). */
export function maskEmail(email: string): string {
  return email.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***${domain}`);
}

export interface RedactOptions {
  /** Also mask email addresses (PII). Default true. */
  maskEmails?: boolean;
  /** Max depth to guard against cycles / huge trees. */
  maxDepth?: number;
}

/**
 * Deep-redact a value for safe logging/evidence. Sensitive keys are replaced
 * wholesale; string values are scrubbed for token/secret patterns; emails are
 * masked. Returns a NEW structure — never mutates the input.
 */
export function redact(value: unknown, opts: RedactOptions = {}): unknown {
  const maskEmails = opts.maskEmails ?? true;
  const maxDepth = opts.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  const walk = (val: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (val == null) return val;
    if (typeof val === 'string') {
      const s = redactString(val);
      return maskEmails ? maskEmail(s) : s;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    if (Array.isArray(val)) return val.map((v) => walk(v, depth + 1));
    if (typeof val === 'object') {
      if (seen.has(val as object)) return '[CIRCULAR]';
      seen.add(val as object);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : walk(v, depth + 1);
      }
      return out;
    }
    return String(val);
  };

  return walk(value, 0);
}

/** True if a key name would be redacted — useful for schema/lint checks. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}
