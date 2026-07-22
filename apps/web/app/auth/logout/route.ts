import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig } from '@/lib/auth/config';
import { clearSessionCookies, mutationHasSameOrigin, revokeRefreshToken } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  let redirectBase = request.nextUrl.origin;
  let secureCookies = request.nextUrl.protocol === 'https:';
  try {
    const cfg = getWebAuthConfig(request.nextUrl.origin);
    redirectBase = cfg.appBaseUrl;
    secureCookies = cfg.secureCookies;
    if (!mutationHasSameOrigin(request, cfg.appBaseUrl)) {
      return NextResponse.json({ error: 'Cross-origin logout was rejected.' }, { status: 403 });
    }

    await revokeRefreshToken(cfg, request.cookies.get(AUTH_COOKIES.refresh)?.value);
    const logout = new URL(cfg.logoutEndpoint);
    logout.searchParams.set('client_id', cfg.clientId);
    logout.searchParams.set('post_logout_redirect_uri', cfg.appBaseUrl);
    const idToken = request.cookies.get(AUTH_COOKIES.id)?.value;
    if (idToken) logout.searchParams.set('id_token_hint', idToken);
    const response = NextResponse.redirect(logout, 303);
    clearSessionCookies(response, cfg.secureCookies);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    const response = NextResponse.redirect(new URL('/', redirectBase), 303);
    clearSessionCookies(response, secureCookies);
    return response;
  }
}
