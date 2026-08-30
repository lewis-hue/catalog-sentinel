import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { buildAuthorizationUrl, type AuthorizationFlow } from './authorization';
import {
  AUTH_COOKIES,
  getWebAuthConfig,
  safeReturnTo,
  type KeycloakWebAuthConfig,
} from './config';

export interface KeycloakTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

export interface SessionDisplay {
  subject: string;
  displayName: string;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  refresh_expires_in?: unknown;
  error?: unknown;
}

interface JwtHeader { alg?: unknown; kid?: unknown }
interface JwtClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  preferred_username?: unknown;
  name?: unknown;
  email?: unknown;
}

const SESSION_COOKIE_AGE = 30 * 24 * 60 * 60;
type SigningJwk = JsonWebKey & { kid?: string };
const jwksCache = new Map<string, { expiresAt: number; keys: SigningJwk[] }>();

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Start a browser-bound authorization transaction with state, nonce, and PKCE.
 * Both sign-in and brokered sign-up use the same callback validation path.
 */
export function beginAuthorization(
  request: NextRequest,
  flow: AuthorizationFlow,
): NextResponse {
  const cfg = getWebAuthConfig(request.nextUrl.origin);
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const state = randomUrlSafe();
  const verifier = randomUrlSafe(48);
  const nonce = randomUrlSafe();
  const authorize = buildAuthorizationUrl(cfg, {
    state,
    nonce,
    codeChallenge: pkceChallenge(verifier),
  }, flow);

  const response = NextResponse.redirect(authorize);
  const options = {
    httpOnly: true,
    secure: cfg.secureCookies,
    sameSite: 'lax' as const,
    path: '/auth/callback',
    maxAge: 600,
  };
  response.cookies.set(AUTH_COOKIES.state, state, options);
  response.cookies.set(AUTH_COOKIES.verifier, verifier, options);
  response.cookies.set(AUTH_COOKIES.nonce, nonce, options);
  response.cookies.set(AUTH_COOKIES.returnTo, returnTo, options);
  response.headers.set('cache-control', 'no-store');
  return response;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function decodeJwt(token: string): { encodedHeader: string; encodedPayload: string; signature: Uint8Array; header: JwtHeader; claims: JwtClaims } {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw new Error('Malformed JSON Web Token.');
  return {
    encodedHeader,
    encodedPayload,
    signature: Buffer.from(encodedSignature, 'base64url'),
    header: decodePart<JwtHeader>(encodedHeader),
    claims: decodePart<JwtClaims>(encodedPayload),
  };
}

function claimAudienceIncludes(aud: unknown, clientId: string): boolean {
  return aud === clientId || (Array.isArray(aud) && aud.some((item) => item === clientId));
}

async function signingKeys(endpoint: string, forceRefresh = false): Promise<SigningJwk[]> {
  const cached = jwksCache.get(endpoint);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Could not validate the identity provider response.');
  const body = (await response.json()) as { keys?: SigningJwk[] };
  if (!Array.isArray(body.keys)) throw new Error('The identity provider returned an invalid signing-key set.');
  jwksCache.set(endpoint, { expiresAt: Date.now() + 5 * 60_000, keys: body.keys });
  return body.keys;
}

async function verifiedJwtClaims(token: string, cfg: KeycloakWebAuthConfig): Promise<JwtClaims> {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== 'RS256' || typeof decoded.header.kid !== 'string' || !decoded.header.kid) {
    throw new Error('The identity provider returned an unsupported token.');
  }

  const matchesKey = (candidate: SigningJwk) =>
    candidate.kid === decoded.header.kid && candidate.kty === 'RSA' &&
    (!candidate.use || candidate.use === 'sig') && (!candidate.alg || candidate.alg === 'RS256');
  let jwk = (await signingKeys(cfg.jwksEndpoint)).find(matchesKey);
  if (!jwk) jwk = (await signingKeys(cfg.jwksEndpoint, true)).find(matchesKey);
  if (!jwk) throw new Error('The identity provider signing key was not found.');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${decoded.encodedHeader}.${decoded.encodedPayload}`);
  const signature = new Uint8Array(new ArrayBuffer(decoded.signature.byteLength));
  signature.set(decoded.signature);
  const validSignature = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
  if (!validSignature) throw new Error('The identity provider returned an invalid token signature.');

  return decoded.claims;
}

/** Verify the OIDC ID token signature and the claims that bind it to this browser transaction. */
export async function validateIdToken(token: string, expectedNonce: string, cfg: KeycloakWebAuthConfig): Promise<void> {
  const claims = await verifiedJwtClaims(token, cfg);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== cfg.issuer) throw new Error('The ID token issuer is invalid.');
  if (!claimAudienceIncludes(claims.aud, cfg.clientId)) throw new Error('The ID token audience is invalid.');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== cfg.clientId) {
    throw new Error('The ID token authorized party is invalid.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) throw new Error('The ID token subject is missing.');
  if (typeof claims.exp !== 'number' || claims.exp <= now - 30) throw new Error('The ID token has expired.');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw new Error('The ID token issue time is invalid.');
  if (typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, expectedNonce)) {
    throw new Error('The ID token nonce is invalid.');
  }
}

/** Validate access-token identity before rendering it; API authorization is still authoritative. */
export async function validateAccessToken(token: string, cfg: KeycloakWebAuthConfig): Promise<void> {
  const claims = await verifiedJwtClaims(token, cfg);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== cfg.issuer) throw new Error('The access token issuer is invalid.');
  if (!claimAudienceIncludes(claims.aud, cfg.apiAudience)) throw new Error('The access token audience is invalid.');
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) throw new Error('The access token subject is missing.');
  if (typeof claims.exp !== 'number' || claims.exp <= now - 30) throw new Error('The access token has expired.');
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) throw new Error('The access token issue time is invalid.');
}

async function tokenRequest(cfg: KeycloakWebAuthConfig, form: URLSearchParams): Promise<TokenEndpointResponse> {
  form.set('client_id', cfg.clientId);
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const response = await fetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as TokenEndpointResponse;
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new Error(`Identity provider token exchange failed (${detail}).`);
  }
  return body;
}

function asPositiveSeconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function requireToken(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Identity provider response is missing ${name}.`);
  return value;
}

export async function exchangeAuthorizationCode(
  cfg: KeycloakWebAuthConfig,
  code: string,
  verifier: string,
): Promise<KeycloakTokenSet> {
  const body = await tokenRequest(cfg, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${cfg.appBaseUrl}/auth/callback`,
    code_verifier: verifier,
  }));
  return {
    accessToken: requireToken(body.access_token, 'access_token'),
    refreshToken: requireToken(body.refresh_token, 'refresh_token'),
    idToken: requireToken(body.id_token, 'id_token'),
    accessExpiresIn: asPositiveSeconds(body.expires_in, 300),
    refreshExpiresIn: asPositiveSeconds(body.refresh_expires_in, SESSION_COOKIE_AGE),
  };
}

export async function refreshTokenSet(
  cfg: KeycloakWebAuthConfig,
  refreshToken: string,
  previousIdToken?: string,
): Promise<KeycloakTokenSet> {
  const body = await tokenRequest(cfg, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  const tokens = {
    accessToken: requireToken(body.access_token, 'access_token'),
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : refreshToken,
    idToken: typeof body.id_token === 'string' && body.id_token ? body.id_token : previousIdToken,
    accessExpiresIn: asPositiveSeconds(body.expires_in, 300),
    refreshExpiresIn: asPositiveSeconds(body.refresh_expires_in, SESSION_COOKIE_AGE),
  };
  // Never persist or forward a refreshed token merely because the token endpoint returned 200.
  // Verify its signature, issuer, API audience, subject, tenant, and time bounds first.
  await validateAccessToken(tokens.accessToken, cfg);
  return tokens;
}

export async function revokeRefreshToken(cfg: KeycloakWebAuthConfig, refreshToken: string | undefined): Promise<boolean> {
  if (!refreshToken) return true;
  const form = new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: cfg.clientId });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  try {
    const response = await fetch(cfg.revocationEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function cookieOptions(cfg: { secureCookies: boolean }, maxAge: number) {
  return { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax' as const, path: '/', maxAge };
}

export function setSessionCookies(response: NextResponse, cfg: KeycloakWebAuthConfig, tokens: KeycloakTokenSet): void {
  response.cookies.set(AUTH_COOKIES.access, tokens.accessToken, cookieOptions(cfg, tokens.accessExpiresIn));
  response.cookies.set(AUTH_COOKIES.refresh, tokens.refreshToken, cookieOptions(cfg, tokens.refreshExpiresIn));
  if (tokens.idToken) response.cookies.set(AUTH_COOKIES.id, tokens.idToken, cookieOptions(cfg, tokens.refreshExpiresIn));
}

export function clearSessionCookies(response: NextResponse, secureCookies: boolean): void {
  for (const name of [AUTH_COOKIES.access, AUTH_COOKIES.refresh, AUTH_COOKIES.id]) {
    response.cookies.set(name, '', { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/', maxAge: 0 });
  }
}

export function clearTransactionCookies(response: NextResponse, secureCookies: boolean): void {
  for (const name of [AUTH_COOKIES.state, AUTH_COOKIES.verifier, AUTH_COOKIES.nonce, AUTH_COOKIES.returnTo]) {
    response.cookies.set(name, '', { httpOnly: true, secure: secureCookies, sameSite: 'lax', path: '/auth/callback', maxAge: 0 });
  }
}

export function accessTokenIsFresh(token: string | undefined, minimumLifetimeSeconds = 30): boolean {
  if (!token) return false;
  try {
    const [, payload] = token.split('.');
    if (!payload) return false;
    const claims = decodePart<JwtClaims>(payload);
    return typeof claims.exp === 'number' && claims.exp > Math.floor(Date.now() / 1000) + minimumLifetimeSeconds;
  } catch {
    return false;
  }
}

/** Display-only claims. Authorization is always decided by the API after signature validation. */
export function sessionDisplayFromAccessToken(token: string): SessionDisplay | null {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const claims = decodePart<JwtClaims>(payload);
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    const candidate = [claims.name, claims.preferred_username, claims.email, claims.sub]
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    return {
      subject: claims.sub,
      displayName: candidate?.trim() ?? 'Signed-in user',
    };
  } catch {
    return null;
  }
}

export function mutationHasSameOrigin(request: NextRequest, appBaseUrl: string): boolean {
  const expected = new URL(appBaseUrl).origin;
  const origin = request.headers.get('origin');
  if (origin) {
    try { return new URL(origin).origin === expected; } catch { return false; }
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try { return new URL(referer).origin === expected; } catch { return false; }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}
