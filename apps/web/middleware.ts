import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig } from './lib/auth/config';
import { frontendRouteKind } from './lib/auth/gate';
import { runtimeSecurityHeaders } from './lib/security-headers';

export function middleware(request: NextRequest): NextResponse {
  try {
    const path = request.nextUrl.pathname;
    const routeKind = frontendRouteKind(path);
    let response: NextResponse;
    // This deployment does not use `next/image`; keep the native image decoder unreachable even
    // when a caller requests the optimizer endpoint directly.
    if (path === '/_next/image') {
      response = new NextResponse('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    } else if (routeKind !== 'protected-ui') {
      response = NextResponse.next();
    } else {
      const cfg = getWebAuthConfig(request.nextUrl.origin);
      const hasSession = Boolean(
        request.cookies.get(AUTH_COOKIES.access)?.value || request.cookies.get(AUTH_COOKIES.refresh)?.value,
      );
      if (hasSession) {
        response = NextResponse.next();
      } else {
        const signIn = new URL('/sign-in', cfg.appBaseUrl);
        signIn.searchParams.set('returnTo', `${request.nextUrl.pathname}${request.nextUrl.search}`);
        response = NextResponse.redirect(signIn);
      }
    }
    for (const [name, value] of Object.entries(runtimeSecurityHeaders())) response.headers.set(name, value);
    return response;
  } catch {
    return new NextResponse('Authentication is unavailable because the server configuration is incomplete.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico|icon.svg).*)'],
};
