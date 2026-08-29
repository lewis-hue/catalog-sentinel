import { describe, expect, it } from 'vitest';
import { getWebAuthConfig } from './config';

const production = {
  NODE_ENV: 'production',
  WEB_AUTH_MODE: 'keycloak',
  ENABLE_KEYCLOAK_AUTH: 'true',
  API_PROXY_TARGET: 'https://api.internal.example',
  APP_BASE_URL: 'https://sentinel.example',
  KEYCLOAK_BASE_URL: 'https://keycloak.internal.example',
  KEYCLOAK_PUBLIC_BASE_URL: 'https://login.example',
  KEYCLOAK_ISSUER: 'https://login.example/realms/sentinel',
  KEYCLOAK_REALM: 'sentinel',
  KEYCLOAK_WEB_CLIENT_ID: 'sentinel-web',
  KEYCLOAK_WEB_CLIENT_SECRET: 'server-only-secret',
  KEYCLOAK_API_CLIENT_ID: 'sentinel-api',
} as NodeJS.ProcessEnv;

describe('production web auth transport', () => {
  it('requires HTTPS for the internal token and JWKS endpoint', () => {
    expect(() => getWebAuthConfig(undefined, {
      ...production,
      KEYCLOAK_BASE_URL: 'http://keycloak.internal.example',
    })).toThrow(/KEYCLOAK_BASE_URL must use HTTPS/i);
  });

  it('builds token and JWKS endpoints only from the approved HTTPS internal base', () => {
    const config = getWebAuthConfig(undefined, production);
    expect(config.mode).toBe('keycloak');
    if (config.mode !== 'keycloak') throw new Error('expected Keycloak mode');
    expect(config.tokenEndpoint).toBe('https://keycloak.internal.example/realms/sentinel/protocol/openid-connect/token');
    expect(config.jwksEndpoint).toBe('https://keycloak.internal.example/realms/sentinel/protocol/openid-connect/certs');
  });

  it('fails closed without the confidential BFF secret', () => {
    expect(() => getWebAuthConfig(undefined, {
      ...production,
      KEYCLOAK_WEB_CLIENT_SECRET: '',
    })).toThrow(/KEYCLOAK_WEB_CLIENT_SECRET is required/i);
  });

  it('STILL rejects a routable hostname over HTTP in production (the guard is intact)', () => {
    // The loopback carve-out below must not become a hole for real hosts.
    expect(() => getWebAuthConfig(undefined, {
      ...production,
      APP_BASE_URL: 'http://sentinel.example',
    })).toThrow(/APP_BASE_URL must use HTTPS/i);
    expect(() => getWebAuthConfig(undefined, {
      ...production,
      KEYCLOAK_PUBLIC_BASE_URL: 'http://login.example',
    })).toThrow(/KEYCLOAK_PUBLIC_BASE_URL must use HTTPS/i);
  });
});

describe('loopback carve-out: a production build runs locally over http without weakening the guard', () => {
  const localhost = {
    NODE_ENV: 'production',
    ENABLE_KEYCLOAK_AUTH: 'true',
    API_PROXY_TARGET: 'http://scanner:4000',
    APP_BASE_URL: 'http://localhost:3000',
    KEYCLOAK_BASE_URL: 'http://keycloak:8080',
    KEYCLOAK_PUBLIC_BASE_URL: 'http://localhost:8080',
    KEYCLOAK_ISSUER: 'http://localhost:8080/realms/sentinel',
    KEYCLOAK_REALM: 'sentinel',
    KEYCLOAK_WEB_CLIENT_ID: 'sentinel-web',
    KEYCLOAK_WEB_CLIENT_SECRET: 'secret',
    KEYCLOAK_API_CLIENT_ID: 'sentinel-api',
  } as NodeJS.ProcessEnv;

  it('allows http for localhost / loopback endpoints even in production', () => {
    // `KEYCLOAK_BASE_URL=http://keycloak:8080` is NOT loopback, it is a docker service name, so
    // it would fail the guard. Loopback is localhost/127.x/::1 only. Use loopback for the internal
    // base too in the pure-localhost case.
    const cfg = getWebAuthConfig(undefined, { ...localhost, KEYCLOAK_BASE_URL: 'http://127.0.0.1:8080' });
    expect(cfg.mode).toBe('keycloak');
    if (cfg.mode !== 'keycloak') throw new Error('expected Keycloak mode');
    expect(cfg.appBaseUrl).toBe('http://localhost:3000');
    // Over plain http, cookies must NOT be marked Secure or the browser would drop them.
    expect(cfg.secureCookies).toBe(false);
    expect(cfg.issuer).toBe('http://localhost:8080/realms/sentinel');
  });

  it('treats ::1 and 127.x as loopback', () => {
    expect(() => getWebAuthConfig(undefined, { ...localhost, KEYCLOAK_BASE_URL: 'http://[::1]:8080', APP_BASE_URL: 'http://127.0.0.1:3000', KEYCLOAK_PUBLIC_BASE_URL: 'http://127.0.0.1:8080', KEYCLOAK_ISSUER: 'http://127.0.0.1:8080/realms/sentinel' })).not.toThrow();
  });
});

describe('APP_ENV is the authoritative transport signal (decoupled from NODE_ENV)', () => {
  // The docker-local reality: NODE_ENV MUST be production (or `next start` won't serve routes),
  // but the web talks to Keycloak at the non-loopback service name keycloak:8080 over http.
  const base = {
    NODE_ENV: 'production',
    ENABLE_KEYCLOAK_AUTH: 'true',
    API_PROXY_TARGET: 'http://scanner:4000',
    APP_BASE_URL: 'http://localhost:3000',
    KEYCLOAK_BASE_URL: 'http://keycloak:8080',
    KEYCLOAK_PUBLIC_BASE_URL: 'http://localhost:8080',
    KEYCLOAK_ISSUER: 'http://localhost:8080/realms/sentinel',
    KEYCLOAK_REALM: 'sentinel',
    KEYCLOAK_WEB_CLIENT_ID: 'sentinel-web',
    KEYCLOAK_WEB_CLIENT_SECRET: 'secret',
    KEYCLOAK_API_CLIENT_ID: 'sentinel-api',
  } as NodeJS.ProcessEnv;

  it('APP_ENV=development permits http on the container network even with NODE_ENV=production', () => {
    const cfg = getWebAuthConfig(undefined, { ...base, APP_ENV: 'development' });
    expect(cfg.mode).toBe('keycloak');
    if (cfg.mode !== 'keycloak') throw new Error('expected Keycloak mode');
    expect(cfg.tokenEndpoint).toBe('http://keycloak:8080/realms/sentinel/protocol/openid-connect/token');
    expect(cfg.secureCookies).toBe(false); // http → cookies must not be Secure
  });

  it('leaves the fail-safe intact: NODE_ENV=production with no APP_ENV still enforces HTTPS', () => {
    // The common prod case (only NODE_ENV set) must NOT be downgraded.
    expect(() => getWebAuthConfig(undefined, base)).toThrow(/must use HTTPS/i);
  });

  it('APP_ENV=production forces HTTPS enforcement regardless of a stray dev NODE_ENV', () => {
    expect(() => getWebAuthConfig(undefined, { ...base, NODE_ENV: 'development', APP_ENV: 'production' }))
      .toThrow(/must use HTTPS/i);
  });
});
