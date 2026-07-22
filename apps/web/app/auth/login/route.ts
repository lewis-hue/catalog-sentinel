import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig, safeReturnTo } from '@/lib/auth/config';
import { pkceChallenge, randomUrlSafe } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cfg = getWebAuthConfig(request.nextUrl.origin);
    const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
    const state = randomUrlSafe();
    const verifier = randomUrlSafe(48);
    const nonce = randomUrlSafe();
    const authorize = new URL(cfg.authorizationEndpoint);
    authorize.searchParams.set('client_id', cfg.clientId);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('redirect_uri', `${cfg.appBaseUrl}/auth/callback`);
    authorize.searchParams.set('scope', cfg.scope);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('nonce', nonce);
    authorize.searchParams.set('code_challenge', pkceChallenge(verifier));
    authorize.searchParams.set('code_challenge_method', 'S256');

    const response = NextResponse.redirect(authorize);
    const options = { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax' as const, path: '/auth/callback', maxAge: 600 };
    response.cookies.set(AUTH_COOKIES.state, state, options);
    response.cookies.set(AUTH_COOKIES.verifier, verifier, options);
    response.cookies.set(AUTH_COOKIES.nonce, nonce, options);
    response.cookies.set(AUTH_COOKIES.returnTo, returnTo, options);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return NextResponse.json({ error: 'Authentication is unavailable because the server configuration is incomplete.' }, { status: 503 });
  }
}
