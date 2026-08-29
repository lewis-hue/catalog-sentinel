import { jwtVerify, createRemoteJWKSet, type JWTPayload, type KeyLike, type JWK, type JWTVerifyGetKey } from 'jose';
import { isTestEnvironment } from './feature-flags';

/** Anything jose's jwtVerify accepts as its key argument (a key, JWKS resolver, etc.). */
type VerifyKey = KeyLike | Uint8Array | JWK | JWTVerifyGetKey;

/**
 * Keycloak (OIDC) authentication for the API. Validates RS256 bearer tokens against the
 * realm's JWKS, and extracts the caller's identity: subject, tenant, and roles (RBAC).
 *
 * Auth may be disabled only inside an explicit isolated test runtime. Every running application
 * otherwise fails closed unless ENABLE_KEYCLOAK_AUTH is enabled. No admin credentials or client secrets
 * are exposed to browser JavaScript; the web BFF uses Authorization Code + PKCE.
 */
export const SENTINEL_ROLES = ['user', 'artist_manager', 'tenant_admin', 'platform_admin', 'service_worker'] as const;
export type SentinelRole = (typeof SENTINEL_ROLES)[number];
export const SENTINEL_INTERACTIVE_ROLES = ['user', 'artist_manager', 'tenant_admin', 'platform_admin'] as const;

export interface AuthIdentity {
  sub: string;
  tenantId: string;
  roles: string[];
  username?: string;
  /**
   * Present only when the signed OIDC token asserts `email_verified: true` and carries a
   * syntactically valid email address. Callers must never use an unverified email claim for an
   * invitation or other account-binding decision.
   */
  email?: string;
  emailVerified: boolean;
  /** Identity broker recorded by Keycloak (for example `google`). Informational, not RBAC. */
  identityProvider?: string;
  authenticated: boolean;
}

/** Unauthenticated request identity used for public health probes and isolated tests. */
export const ANONYMOUS_IDENTITY: AuthIdentity = {
  sub: 'anonymous',
  tenantId: 'default',
  roles: [],
  emailVerified: false,
  authenticated: false,
};

export interface KeycloakAuthConfig {
  enabled: boolean;
  issuer?: string;
  jwksUri?: string;
  /** Required API audience. Normally KEYCLOAK_API_CLIENT_ID. */
  audience?: string;
  /** Test/DI hook: a key or JWKS resolver to use instead of the remote JWKS. */
  keyInput?: VerifyKey;
}

export function readKeycloakConfig(env: NodeJS.ProcessEnv = process.env): KeycloakAuthConfig {
  const enabled = /^(1|true|yes|on)$/i.test(env.ENABLE_KEYCLOAK_AUTH ?? '');
  if (!enabled && !isTestEnvironment(env)) {
    throw new Error(
      'Keycloak authentication must be enabled outside isolated tests; anonymous application mode is not supported.',
    );
  }
  const base = (env.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, '');
  const realm = env.KEYCLOAK_REALM ?? 'sentinel';
  const issuer = (env.KEYCLOAK_ISSUER ?? '').trim() || (base ? `${base}/realms/${realm}` : undefined);
  const audience = (env.KEYCLOAK_API_AUDIENCE ?? env.KEYCLOAK_API_CLIENT_ID ?? '').trim() || undefined;
  if (enabled && !base) throw new Error('ENABLE_KEYCLOAK_AUTH requires KEYCLOAK_BASE_URL.');
  if (enabled && !audience) {
    throw new Error('ENABLE_KEYCLOAK_AUTH requires KEYCLOAK_API_CLIENT_ID (or KEYCLOAK_API_AUDIENCE).');
  }
  const jwksUri = base ? `${base}/realms/${realm}/protocol/openid-connect/certs` : undefined;
  return { enabled, issuer, jwksUri, audience };
}

/**
 * Extract our identity from a verified Keycloak token payload.
 *
 * Locally registered users do not have a custom `tenant_id`, so the verified Keycloak subject is
 * their canonical personal tenant. A signed tenant claim is retained as a candidate organization
 * context for backwards-compatible deployments, but the API independently requires durable
 * membership before it can use a value that differs from the subject.
 */
export function identityFromPayload(p: JWTPayload): AuthIdentity {
  const realmAccess = (p as { realm_access?: { roles?: string[] } }).realm_access;
  const claimedRoles = Array.isArray(realmAccess?.roles)
    ? realmAccess.roles.filter((role): role is string => typeof role === 'string')
    : [];
  // Keycloak commonly adds built-in roles (for example offline_access). Ignore those, but never
  // turn a token carrying only arbitrary/unknown roles into an authorized Sentinel principal.
  const roles = claimedRoles.filter((role): role is SentinelRole =>
    (SENTINEL_ROLES as readonly string[]).includes(role));
  const sub = typeof p.sub === 'string' ? p.sub.trim() : '';
  if (!sub) throw new Error('Authenticated token is missing the required subject claim.');
  const claimedTenantId = typeof p.tenant_id === 'string' ? p.tenant_id.trim() : '';
  if (roles.length === 0) {
    throw new Error('Authenticated token has no recognized Sentinel role.');
  }
  const assertedEmail = typeof p.email === 'string' ? p.email.trim().toLowerCase() : '';
  const emailVerified = p.email_verified === true
    && assertedEmail.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assertedEmail);
  const identityProviderClaim = typeof p.identity_provider === 'string' ? p.identity_provider.trim() : '';
  const identityProvider = identityProviderClaim
    && identityProviderClaim.length <= 128
    && ![...identityProviderClaim].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
    ? identityProviderClaim
    : undefined;
  return {
    sub,
    tenantId: claimedTenantId || sub,
    roles,
    username: typeof p.preferred_username === 'string' ? p.preferred_username : undefined,
    ...(emailVerified ? { email: assertedEmail } : {}),
    emailVerified,
    ...(identityProvider ? { identityProvider } : {}),
    authenticated: true,
  };
}

export class KeycloakVerifier {
  private readonly key: VerifyKey | undefined;
  constructor(private readonly cfg: KeycloakAuthConfig) {
    if (cfg.enabled && !cfg.issuer) throw new Error('Keycloak issuer is required when authentication is enabled.');
    if (cfg.enabled && !cfg.audience) throw new Error('Keycloak API audience/client is required when authentication is enabled.');
    if (cfg.keyInput) this.key = cfg.keyInput;
    else if (cfg.enabled && cfg.jwksUri) this.key = createRemoteJWKSet(new URL(cfg.jwksUri));
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Verify a bearer token (RS256 signature + issuer + API audience). Throws on any failure. */
  async verify(token: string): Promise<AuthIdentity> {
    if (!this.key) throw new Error('Keycloak auth is not configured (KEYCLOAK_BASE_URL missing).');
    const opts = { issuer: this.cfg.issuer!, audience: this.cfg.audience!, algorithms: ['RS256'] };
    // jose has separate overloads for a key vs. a JWKS resolver function, narrow on type.
    const { payload } =
      typeof this.key === 'function'
        ? await jwtVerify(token, this.key as JWTVerifyGetKey, opts)
        : await jwtVerify(token, this.key as KeyLike | Uint8Array | JWK, opts);
    return identityFromPayload(payload);
  }
}

/** RBAC check: does the identity hold any of the required roles? (platform_admin passes all.) */
export function hasAnyRole(identity: AuthIdentity, required: readonly string[]): boolean {
  if (required.length === 0) return true;
  if (identity.roles.includes('platform_admin')) return true;
  return required.some((r) => identity.roles.includes(r));
}
