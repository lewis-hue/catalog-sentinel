import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIES, getWebAuthConfig, type KeycloakWebAuthConfig } from '@/lib/auth/config';
import {
  accessTokenIsFresh,
  clearSessionCookies,
  mutationHasSameOrigin,
  refreshTokenSet,
  setSessionCookies,
  type KeycloakTokenSet,
} from '@/lib/auth/server';
import { forwardedBffResponseHeaders } from '@/lib/bff-response-headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ path: string[] }> };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'if-match', 'if-none-match', 'range',
]);
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

class BodyTooLargeError extends Error {}

function maxBodyBytes(): number {
  const configured = Number(process.env.BFF_MAX_BODY_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 25 * 1024 * 1024)
    : DEFAULT_MAX_BODY_BYTES;
}

async function boundedBody(request: NextRequest): Promise<ArrayBuffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return undefined;
  const limit = maxBodyBytes();
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body.buffer;
}

function apiTarget(base: string, path: string[], search: string): URL | null {
  if (!path.length || path.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (path[0] !== 'api' && path[0] !== 'health') return null;
  const root = new URL(`${base}/`);
  const target = new URL(path.map(encodeURIComponent).join('/'), root);
  if (target.origin !== root.origin || !target.pathname.startsWith(root.pathname)) return null;
  target.search = search;
  return target;
}

function forwardedHeaders(request: NextRequest, accessToken?: string): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return headers;
}

async function callApi(request: NextRequest, target: URL, body: ArrayBuffer | undefined, accessToken?: string): Promise<Response> {
  return fetch(target, {
    method: request.method,
    headers: forwardedHeaders(request, accessToken),
    body,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(60_000),
  });
}

function proxyResponse(upstream: Response, refreshed?: { cfg: KeycloakWebAuthConfig; tokens: KeycloakTokenSet }): NextResponse {
  const headers = forwardedBffResponseHeaders(upstream.headers);
  const response = new NextResponse(upstream.body, { status: upstream.status, headers });
  response.headers.set('cache-control', 'private, no-store, max-age=0');
  if (refreshed) setSessionCookies(response, refreshed.cfg, refreshed.tokens);
  return response;
}

async function handler(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const cfg = getWebAuthConfig(request.nextUrl.origin);
    const { path } = await context.params;
    const target = apiTarget(cfg.apiTarget, path, request.nextUrl.search);
    if (!target) return NextResponse.json({ error: 'Unsupported proxy target.' }, { status: 404 });
    if (!SAFE_METHODS.has(request.method) && !mutationHasSameOrigin(request, cfg.appBaseUrl)) {
      return NextResponse.json({ error: 'Cross-origin request rejected.' }, { status: 403 });
    }

    const body = await boundedBody(request);
    let accessToken = request.cookies.get(AUTH_COOKIES.access)?.value;
    const refreshToken = request.cookies.get(AUTH_COOKIES.refresh)?.value;
    const idToken = request.cookies.get(AUTH_COOKIES.id)?.value;
    let refreshed: KeycloakTokenSet | undefined;
    if (!accessTokenIsFresh(accessToken) && refreshToken) {
      try {
        refreshed = await refreshTokenSet(cfg, refreshToken, idToken);
        accessToken = refreshed.accessToken;
      } catch {
        accessToken = undefined;
      }
    }
    if (!accessToken) {
      const response = NextResponse.json({ error: 'authentication required' }, { status: 401 });
      clearSessionCookies(response, cfg.secureCookies);
      return response;
    }

    let upstream = await callApi(request, target, body, accessToken);
    if (upstream.status === 401 && refreshToken && !refreshed) {
      try {
        refreshed = await refreshTokenSet(cfg, refreshToken, idToken);
        upstream = await callApi(request, target, body, refreshed.accessToken);
      } catch {
        // The final 401 below clears the unusable local session.
      }
    }
    const response = proxyResponse(upstream, refreshed ? { cfg, tokens: refreshed } : undefined);
    if (upstream.status === 401) clearSessionCookies(response, cfg.secureCookies);
    return response;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: 'Request body exceeds the gateway limit.' }, { status: 413 });
    }
    return NextResponse.json({ error: 'The API gateway is temporarily unavailable.' }, { status: 502 });
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS, handler as HEAD };
