import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, type AuthorizationFlow } from './authorization';
import { safeReturnTo, type KeycloakWebAuthConfig } from './config';

const cfg: KeycloakWebAuthConfig = {
  mode: 'keycloak',
  apiTarget: 'https://api.internal.example',
  secureCookies: true,
  appBaseUrl: 'https://sentinel.example',
  issuer: 'https://login.example/realms/sentinel',
  authorizationEndpoint: 'https://login.example/realms/sentinel/protocol/openid-connect/auth',
  tokenEndpoint: 'https://keycloak.internal.example/realms/sentinel/protocol/openid-connect/token',
  jwksEndpoint: 'https://keycloak.internal.example/realms/sentinel/protocol/openid-connect/certs',
  logoutEndpoint: 'https://login.example/realms/sentinel/protocol/openid-connect/logout',
  revocationEndpoint: 'https://keycloak.internal.example/realms/sentinel/protocol/openid-connect/revoke',
  clientId: 'sentinel-web',
  apiAudience: 'sentinel-api',
  clientSecret: 'server-only-secret',
  scope: 'openid profile email',
};

const transaction = {
  state: 'state-value',
  nonce: 'nonce-value',
  codeChallenge: 'pkce-challenge',
};

describe('Keycloak authorization URL construction', () => {
  it('preserves the complete state, nonce, and S256 PKCE contract', () => {
    const url = buildAuthorizationUrl(cfg, transaction, 'sign-in');

    expect(url.origin).toBe('https://login.example');
    expect(url.searchParams.get('client_id')).toBe('sentinel-web');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://sentinel.example/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe(transaction.state);
    expect(url.searchParams.get('nonce')).toBe(transaction.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(transaction.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('kc_idp_hint')).toBe(false);
  });

  it('uses only the fixed Google broker for account creation', () => {
    const url = buildAuthorizationUrl(cfg, transaction, 'google-sign-up');

    expect(url.searchParams.getAll('kc_idp_hint')).toEqual(['google']);
  });

  it('fails closed for an unsupported authorization flow', () => {
    expect(() => buildAuthorizationUrl(
      cfg,
      transaction,
      'caller-selected-provider' as AuthorizationFlow,
    )).toThrow(/unsupported authorization flow/i);
  });
});

describe('authorization return target validation', () => {
  it.each([
    ['https://attacker.example/catalog', '/'],
    ['//attacker.example/catalog', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
  ])('rejects external or non-path target %j', (candidate, expected) => {
    expect(safeReturnTo(candidate)).toBe(expected);
  });

  it('retains an internal path, query, and fragment', () => {
    expect(safeReturnTo('/catalog?page=2#release')).toBe('/catalog?page=2#release');
  });
});
