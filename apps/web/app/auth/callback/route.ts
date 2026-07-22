import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig, safeReturnTo } from '@/lib/auth/config';
import {
  clearSessionCookies,
  clearTransactionCookies,
  constantTimeEqual,
  exchangeAuthorizationCode,
  setSessionCookies,
  validateAccessToken,
  validateIdToken,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function failure(message: string, status: number, secureCookies: boolean): NextResponse {
  const response = NextResponse.json({ error: message }, { status });
  clearTransactionCookies(response, secureCookies);
  clearSessionCookies(response, secureCookies);
  response.headers.set('cache-control', 'no-store');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  let secureCookies = request.nextUrl.protocol === 'https:';
  try {
    const cfg = getWebAuthConfig(request.nextUrl.origin);
    secureCookies = cfg.secureCookies;
    if (request.nextUrl.searchParams.get('error')) return failure('Sign-in was not completed.', 401, secureCookies);
    const code = request.nextUrl.searchParams.get('code');
    const returnedState = request.nextUrl.searchParams.get('state');
    const expectedState = request.cookies.get(AUTH_COOKIES.state)?.value;
    const verifier = request.cookies.get(AUTH_COOKIES.verifier)?.value;
    const nonce = request.cookies.get(AUTH_COOKIES.nonce)?.value;
    if (!code || !returnedState || !expectedState || !verifier || !nonce || !constantTimeEqual(returnedState, expectedState)) {
      return failure('The sign-in response could not be verified. Please start again.', 400, secureCookies);
    }

    const tokens = await exchangeAuthorizationCode(cfg, code, verifier);
    if (!tokens.idToken) return failure('The identity provider did not return an ID token.', 502, secureCookies);
    await validateIdToken(tokens.idToken, nonce, cfg);
    await validateAccessToken(tokens.accessToken, cfg);

    const returnTo = safeReturnTo(request.cookies.get(AUTH_COOKIES.returnTo)?.value);
    const response = NextResponse.redirect(new URL(returnTo, cfg.appBaseUrl));
    setSessionCookies(response, cfg, tokens);
    clearTransactionCookies(response, cfg.secureCookies);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return failure('Sign-in failed. Please try again or contact an administrator.', 502, secureCookies);
  }
}
