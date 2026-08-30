import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { KeycloakVerifier, readKeycloakConfig, hasAnyRole, identityFromPayload, ANONYMOUS_IDENTITY } from './keycloak-auth';

const ISSUER = 'https://kc.example/realms/sentinel';
const AUDIENCE = 'sentinel-api';
type KP = Awaited<ReturnType<typeof generateKeyPair>>;
let priv: KP['privateKey'];
let pub: KP['publicKey'];

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  priv = kp.privateKey;
  pub = kp.publicKey;
});

function token(claims: Record<string, unknown>, opts: { issuer?: string; exp?: string; audience?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('user-1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(priv);
}

describe('readKeycloakConfig', () => {
  it('is disabled only for explicit tests and enabled via ENABLE_KEYCLOAK_AUTH', () => {
    expect(readKeycloakConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).enabled).toBe(false);
    const cfg = readKeycloakConfig({ ENABLE_KEYCLOAK_AUTH: 'true', KEYCLOAK_BASE_URL: 'https://kc.example', KEYCLOAK_REALM: 'sentinel', KEYCLOAK_API_CLIENT_ID: AUDIENCE } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.issuer).toBe(ISSUER);
    expect(cfg.jwksUri).toBe(`${ISSUER}/protocol/openid-connect/certs`);
    expect(cfg.audience).toBe(AUDIENCE);
  });

  it('fails closed when enabled without issuer or API audience', () => {
    expect(() => readKeycloakConfig({ ENABLE_KEYCLOAK_AUTH: 'true', KEYCLOAK_API_CLIENT_ID: AUDIENCE } as NodeJS.ProcessEnv)).toThrow(/BASE_URL/);
    expect(() => readKeycloakConfig({ ENABLE_KEYCLOAK_AUTH: 'true', KEYCLOAK_BASE_URL: 'https://kc.example' } as NodeJS.ProcessEnv)).toThrow(/CLIENT_ID|AUDIENCE/);
  });

  it('supports a canonical issuer distinct from the internal JWKS endpoint', () => {
    const cfg = readKeycloakConfig({
      ENABLE_KEYCLOAK_AUTH: 'true',
      KEYCLOAK_BASE_URL: 'http://keycloak:8080',
      KEYCLOAK_ISSUER: ISSUER,
      KEYCLOAK_API_AUDIENCE: AUDIENCE,
    } as NodeJS.ProcessEnv);
    expect(cfg.issuer).toBe(ISSUER);
    expect(cfg.jwksUri).toBe('http://keycloak:8080/realms/sentinel/protocol/openid-connect/certs');
  });

  it('still requires an internal Keycloak base when a canonical issuer is provided', () => {
    expect(() => readKeycloakConfig({
      ENABLE_KEYCLOAK_AUTH: 'true',
      KEYCLOAK_ISSUER: ISSUER,
      KEYCLOAK_API_CLIENT_ID: AUDIENCE,
    } as NodeJS.ProcessEnv)).toThrow(/BASE_URL/);
  });

  it('allows disabled authentication only in isolated tests', () => {
    expect(readKeycloakConfig({ NODE_ENV: 'test', ENABLE_KEYCLOAK_AUTH: 'false' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(() => readKeycloakConfig({ NODE_ENV: 'development', ENABLE_KEYCLOAK_AUTH: 'false' } as NodeJS.ProcessEnv)).toThrow(/outside isolated tests/i);
    expect(() => readKeycloakConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toThrow(/outside isolated tests/i);
    expect(() => readKeycloakConfig({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'development', ENABLE_KEYCLOAK_AUTH: 'false' } as NodeJS.ProcessEnv)).toThrow(/must be enabled/i);
    expect(() => readKeycloakConfig({ NODE_ENV: 'production', ENABLE_KEYCLOAK_AUTH: 'false' } as NodeJS.ProcessEnv)).toThrow(/must be enabled/i);
    expect(() => readKeycloakConfig({ DEPLOYMENT_ENV: 'production', NODE_ENV: 'development', ENABLE_KEYCLOAK_AUTH: 'false' } as NodeJS.ProcessEnv)).toThrow(/must be enabled/i);
  });
});

describe('KeycloakVerifier', () => {
  it('ignores any signed tenant claim and scopes the identity to the subject', async () => {
    const v = new KeycloakVerifier({ enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pub });
    const id = await v.verify(await token({ tenant_id: 'tenant-A', realm_access: { roles: ['user'] }, preferred_username: 'lewis' }));
    expect(id).toMatchObject({ sub: 'user-1', tenantId: 'user-1', username: 'lewis', authenticated: true });
    expect(id.roles).toEqual(['user']);
    expect(id.emailVerified).toBe(false);
  });

  it('does not require a broker-specific tenant claim for a personal account', async () => {
    const v = new KeycloakVerifier({ enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pub });
    await expect(v.verify(await token({ realm_access: { roles: ['user'] } }))).resolves.toMatchObject({
      sub: 'user-1',
      tenantId: 'user-1',
    });
    await expect(v.verify(await token({ tenant_id: '   ', realm_access: { roles: ['user'] } }))).resolves.toMatchObject({
      sub: 'user-1',
      tenantId: 'user-1',
    });
  });

  it('rejects a token from the wrong issuer', async () => {
    const v = new KeycloakVerifier({ enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pub });
    await expect(v.verify(await token({ tenant_id: 'tenant-A', realm_access: { roles: ['user'] } }, { issuer: 'https://evil/realms/x' }))).rejects.toThrow();
  });

  it('rejects a token issued for another audience', async () => {
    const v = new KeycloakVerifier({ enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pub });
    await expect(v.verify(await token({ tenant_id: 'tenant-A', realm_access: { roles: ['user'] } }, { audience: 'some-other-api' }))).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const v = new KeycloakVerifier({ enabled: true, issuer: ISSUER, audience: AUDIENCE, keyInput: pub });
    await expect(v.verify(await token({ tenant_id: 'tenant-A', realm_access: { roles: ['user'] } }, { exp: '-1h' }))).rejects.toThrow();
  });
});

describe('hasAnyRole (RBAC)', () => {
  const id = (roles: string[]) => ({ ...ANONYMOUS_IDENTITY, authenticated: true, roles });
  it('empty requirement passes; matching role passes; non-match fails', () => {
    expect(hasAnyRole(id([]), [])).toBe(true);
    expect(hasAnyRole(id(['user']), ['user', 'tenant_admin'])).toBe(true);
    expect(hasAnyRole(id(['user']), ['tenant_admin'])).toBe(false);
  });
  it('platform_admin passes every check', () => {
    expect(hasAnyRole(id(['platform_admin']), ['tenant_admin'])).toBe(true);
  });
});

describe('identityFromPayload', () => {
  it('exposes only a verified, valid email for account-binding decisions', () => {
    const base = { sub: 'x', tenant_id: 'tenant-A', realm_access: { roles: ['user'] } };
    expect(identityFromPayload({ ...base, email: 'User@Example.com', email_verified: true })).toMatchObject({
      email: 'user@example.com',
      emailVerified: true,
    });
    expect(identityFromPayload({ ...base, email: 'user@example.com', email_verified: false })).toMatchObject({
      emailVerified: false,
    });
    expect(identityFromPayload({ ...base, email: 'not-an-email', email_verified: true })).toMatchObject({
      emailVerified: false,
    });
    expect(identityFromPayload({ ...base, email: 'user@example.com' })).not.toHaveProperty('email');
  });

  it('retains a bounded broker identity as informational metadata', () => {
    const identity = identityFromPayload({
      sub: 'x', tenant_id: 'tenant-A', realm_access: { roles: ['user'] }, identity_provider: 'google',
    });
    expect(identity.identityProvider).toBe('google');
    expect(identityFromPayload({
      sub: 'x', tenant_id: 'tenant-A', realm_access: { roles: ['user'] }, identity_provider: 'bad\nprovider',
    })).not.toHaveProperty('identityProvider');
  });

  it('rejects missing, empty, and arbitrary-only role claims', () => {
    expect(() => identityFromPayload({ sub: 'x', tenant_id: 'tenant-A' })).toThrow(/recognized Sentinel role/);
    expect(() => identityFromPayload({ sub: 'x', tenant_id: 'tenant-A', realm_access: { roles: [] } })).toThrow(/recognized Sentinel role/);
    expect(() => identityFromPayload({ sub: 'x', tenant_id: 'tenant-A', realm_access: { roles: ['realm-admin'] } })).toThrow(/recognized Sentinel role/);
  });

  it('retains only recognized Sentinel roles when Keycloak also supplies built-ins', () => {
    expect(identityFromPayload({
      sub: 'x',
      tenant_id: 'tenant-A',
      realm_access: { roles: ['offline_access', 'user'] },
    }).roles).toEqual(['user']);
  });
});
