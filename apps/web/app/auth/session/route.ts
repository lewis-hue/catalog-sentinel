import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig } from '@/lib/auth/config';
import {
  accessTokenIsFresh,
  clearSessionCookies,
  refreshTokenSet,
  sessionDisplayFromAccessToken,
  setSessionCookies,
  validateAccessToken,
} from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const cfg = getWebAuthConfig(request.nextUrl.origin);
    let accessToken = request.cookies.get(AUTH_COOKIES.access)?.value;
    let refreshed = null;
    if (!accessTokenIsFresh(accessToken)) {
      const refreshToken = request.cookies.get(AUTH_COOKIES.refresh)?.value;
      if (refreshToken) {
        try {
          refreshed = await refreshTokenSet(cfg, refreshToken, request.cookies.get(AUTH_COOKIES.id)?.value);
          accessToken = refreshed.accessToken;
        } catch {
          accessToken = undefined;
        }
      }
    }

    if (accessToken) {
      try { await validateAccessToken(accessToken, cfg); } catch { accessToken = undefined; }
    }
    const display = accessToken ? sessionDisplayFromAccessToken(accessToken) : null;
    if (!display) {
      const response = NextResponse.json({ mode: 'keycloak', authenticated: false }, { status: 401 });
      clearSessionCookies(response, cfg.secureCookies);
      response.headers.set('cache-control', 'no-store');
      return response;
    }
    const response = NextResponse.json({ mode: 'keycloak', authenticated: true, ...display });
    if (refreshed) setSessionCookies(response, cfg, refreshed);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return NextResponse.json({ error: 'Authentication is unavailable because the server configuration is incomplete.' }, { status: 503 });
  }
}
