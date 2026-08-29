import type { KeycloakWebAuthConfig } from './config';

export type AuthorizationFlow = 'sign-in' | 'google-sign-up';

export interface AuthorizationTransaction {
  state: string;
  nonce: string;
  codeChallenge: string;
}

/**
 * Construct the public OIDC authorization request.
 *
 * Registration is intentionally limited to the configured Google broker. The
 * identity-provider hint is selected from a closed, server-owned flow enum,
 * never copied from request parameters.
 */
export function buildAuthorizationUrl(
  cfg: KeycloakWebAuthConfig,
  transaction: AuthorizationTransaction,
  flow: AuthorizationFlow,
): URL {
  const authorize = new URL(cfg.authorizationEndpoint);
  authorize.searchParams.set('client_id', cfg.clientId);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', `${cfg.appBaseUrl}/auth/callback`);
  authorize.searchParams.set('scope', cfg.scope);
  authorize.searchParams.set('state', transaction.state);
  authorize.searchParams.set('nonce', transaction.nonce);
  authorize.searchParams.set('code_challenge', transaction.codeChallenge);
  authorize.searchParams.set('code_challenge_method', 'S256');

  if (flow === 'google-sign-up') {
    authorize.searchParams.set('kc_idp_hint', 'google');
  } else if (flow !== 'sign-in') {
    throw new Error('Unsupported authorization flow.');
  }

  return authorize;
}
