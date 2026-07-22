import type { ConsentScope } from './enums';
import type { ConsentGrant } from './entities';

/** Raised when a scan is attempted without valid consent. */
export class ConsentError extends Error {
  constructor(
    message: string,
    public readonly missingScopes: ConsentScope[] = [],
  ) {
    super(message);
    this.name = 'ConsentError';
  }
}

/** A consent grant is valid if it is not revoked and not past its expiry. */
export function isConsentValid(grant: ConsentGrant | null | undefined, at: Date = new Date()): boolean {
  if (!grant) return false;
  if (grant.revokedAt) return false;
  return new Date(grant.expiresAt).getTime() > at.getTime();
}

export function hasScopes(grant: ConsentGrant | null | undefined, required: ConsentScope[], at: Date = new Date()): boolean {
  if (!isConsentValid(grant, at)) return false;
  const held = new Set(grant!.scopes);
  return required.every((s) => held.has(s));
}

/**
 * Guard used by every scan/export path. Throws {@link ConsentError} if consent
 * is missing/expired or does not cover the required scopes. Enforced in tests.
 */
export function requireConsent(grant: ConsentGrant | null | undefined, required: ConsentScope[], at: Date = new Date()): void {
  if (!isConsentValid(grant, at)) {
    throw new ConsentError('Consent is missing, revoked, or expired for this workspace.', required);
  }
  const held = new Set(grant!.scopes);
  const missing = required.filter((s) => !held.has(s));
  if (missing.length > 0) {
    throw new ConsentError(`Consent does not cover required scopes: ${missing.join(', ')}`, missing);
  }
}
