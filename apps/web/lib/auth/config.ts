export interface KeycloakWebAuthConfig {
  mode: 'keycloak';
  apiTarget: string;
  secureCookies: boolean;
  appBaseUrl: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksEndpoint: string;
  logoutEndpoint: string;
  revocationEndpoint: string;
  clientId: string;
  apiAudience: string;
  clientSecret?: string;
  scope: string;
}

export type WebAuthConfig = KeycloakWebAuthConfig;

export const AUTH_COOKIES = {
  access: 'sentinel_access',
  refresh: 'sentinel_refresh',
  id: 'sentinel_id',
  state: 'sentinel_oauth_state',
  verifier: 'sentinel_pkce_verifier',
  nonce: 'sentinel_oidc_nonce',
  returnTo: 'sentinel_return_to',
} as const;

const TRUTHY = /^(1|true|yes|on)$/i;

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required when web authentication is enabled.`);
  return normalized;
}

function absoluteHttpUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an absolute http(s) URL.`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials.`);
  return url;
}

function baseUrl(name: string, value: string): string {
  const url = absoluteHttpUrl(name, value);
  if (url.search || url.hash) throw new Error(`${name} must not contain a query or fragment.`);
  return url.toString().replace(/\/+$/, '');
}

function applicationOrigin(value: string): string {
  const url = absoluteHttpUrl('APP_BASE_URL', value);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_BASE_URL must be an origin without a path, query, or fragment.');
  }
  return url.origin;
}

/**
 * Is this URL a loopback address (localhost / 127.0.0.0-8 / ::1)?
 *
 * Loopback traffic never leaves the machine, so plaintext HTTP over it carries none of the
 * interception risk that makes HTTPS mandatory for real hosts. This is the same carve-out Google's
 * own OAuth uses (http is permitted only for localhost). It lets a production-configured build be
 * exercised locally without weakening the HTTPS requirement for any routable hostname.
 */
function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** In production, a non-loopback endpoint that isn't HTTPS is a misconfiguration. */
function insecureInProduction(production: boolean, value: string): boolean {
  return production && !value.startsWith('https://') && !isLoopbackUrl(value);
}

/**
 * Resolve the server-side Keycloak configuration. Every running web process uses
 * the same real OIDC/BFF path; isolated tests inject complete Keycloak values.
 */
export function getWebAuthConfig(
  requestOrigin?: string,
  env: NodeJS.ProcessEnv = process.env,
): WebAuthConfig {
  const environments = [env.DEPLOYMENT_ENV, env.APP_ENV, env.NODE_ENV]
    .map((value) => value?.trim().toLowerCase());
  // The DEPLOYMENT/APP environment is the AUTHORITATIVE security signal, decoupled from NODE_ENV.
  //
  // `next start` only serves the app's route handlers when NODE_ENV=production, so a local run of
  // a production build must keep NODE_ENV=production — yet it also needs to talk to Keycloak over
  // plaintext http on the container network. Conflating the two (as a plain
  // `environments.includes('production')` does) makes those requirements contradictory. So an
  // explicit DEPLOYMENT_ENV/APP_ENV decides the transport posture; only when neither is set does
  // NODE_ENV fall back in. A real deployment therefore still fails closed to HTTPS either by
  // setting APP_ENV=production or by leaving it unset with NODE_ENV=production.
  const deploymentEnv = (env.DEPLOYMENT_ENV ?? env.APP_ENV)?.trim().toLowerCase();
  const production = deploymentEnv ? deploymentEnv === 'production' : environments.includes('production');
  const devOrTest = !production && (environments.some((value) => value === 'development' || value === 'test') || Boolean(env.VITEST));
  const rawMode = (env.WEB_AUTH_MODE ?? '').trim().toLowerCase();
  if (rawMode && rawMode !== 'keycloak') {
    throw new Error('WEB_AUTH_MODE=keycloak is required; anonymous web access is not supported.');
  }

  const enabledByFlag = TRUTHY.test(env.ENABLE_KEYCLOAK_AUTH ?? '');
  if (rawMode !== 'keycloak' && !enabledByFlag) {
    throw new Error('Set WEB_AUTH_MODE=keycloak or ENABLE_KEYCLOAK_AUTH=true; anonymous web access is not supported.');
  }

  const apiTargetValue = env.API_PROXY_TARGET?.trim() || (devOrTest ? 'http://localhost:4000' : '');
  const apiTarget = baseUrl('API_PROXY_TARGET', required('API_PROXY_TARGET', apiTargetValue));

  const internalBase = baseUrl('KEYCLOAK_BASE_URL', required('KEYCLOAK_BASE_URL', env.KEYCLOAK_BASE_URL));
  if (insecureInProduction(production, internalBase)) {
    throw new Error('KEYCLOAK_BASE_URL must use HTTPS in production because it carries tokens and signing keys.');
  }
  const publicBase = baseUrl(
    'KEYCLOAK_PUBLIC_BASE_URL',
    env.KEYCLOAK_PUBLIC_BASE_URL?.trim() || internalBase,
  );
  if (insecureInProduction(production, publicBase)) {
    throw new Error('KEYCLOAK_PUBLIC_BASE_URL must use HTTPS in production.');
  }
  const realm = required('KEYCLOAK_REALM', env.KEYCLOAK_REALM ?? 'sentinel');
  const clientId = required('KEYCLOAK_WEB_CLIENT_ID', env.KEYCLOAK_WEB_CLIENT_ID);
  const clientSecret = env.KEYCLOAK_WEB_CLIENT_SECRET?.trim() || undefined;
  if (production && !clientSecret) {
    throw new Error('KEYCLOAK_WEB_CLIENT_SECRET is required for the production confidential BFF client.');
  }
  const apiAudience = required(
    'KEYCLOAK_API_CLIENT_ID',
    env.KEYCLOAK_API_AUDIENCE ?? env.KEYCLOAK_API_CLIENT_ID,
  );
  const fallbackOrigin = devOrTest ? requestOrigin : undefined;
  const appBaseUrl = applicationOrigin(required('APP_BASE_URL', env.APP_BASE_URL ?? fallbackOrigin));
  if (insecureInProduction(production, appBaseUrl)) {
    throw new Error('APP_BASE_URL must use HTTPS in production.');
  }

  const internalRealm = `${internalBase}/realms/${encodeURIComponent(realm)}`;
  const publicRealm = `${publicBase}/realms/${encodeURIComponent(realm)}`;
  const issuer = baseUrl('KEYCLOAK_ISSUER', env.KEYCLOAK_ISSUER?.trim() || internalRealm);
  if (insecureInProduction(production, issuer)) {
    throw new Error('KEYCLOAK_ISSUER must use HTTPS in production.');
  }
  return {
    mode: 'keycloak',
    apiTarget,
    secureCookies: appBaseUrl.startsWith('https://'),
    appBaseUrl,
    issuer,
    authorizationEndpoint: `${publicRealm}/protocol/openid-connect/auth`,
    tokenEndpoint: `${internalRealm}/protocol/openid-connect/token`,
    jwksEndpoint: `${internalRealm}/protocol/openid-connect/certs`,
    logoutEndpoint: `${publicRealm}/protocol/openid-connect/logout`,
    revocationEndpoint: `${internalRealm}/protocol/openid-connect/revoke`,
    clientId,
    apiAudience,
    clientSecret,
    scope: env.KEYCLOAK_WEB_SCOPE?.trim() || 'openid profile email',
  };
}

export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const parsed = new URL(value, 'https://return.local');
    if (parsed.origin !== 'https://return.local') return '/';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}
