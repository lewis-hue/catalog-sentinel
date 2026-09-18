'use client';

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Your session has expired. Redirecting to sign in.');
    this.name = 'AuthenticationRequiredError';
  }
}

export type ApiRequestInit = RequestInit;

/** Header the API reads to resolve which tenant a request acts in (see docs/multi-tenancy.md). */
export const TENANT_HEADER = 'X-Sentinel-Tenant';

// The tenant the whole app is currently acting in. Null means the caller's personal tenant (the
// backend default), so an unset header behaves exactly as the app did before tenancy existed. The
// shell's tenant switcher sets this; every apiFetch then scopes to the selected tenant.
let activeTenantId: string | null = null;

/** Set (or clear, with null) the tenant every subsequent apiFetch scopes to. */
export function setActiveTenant(tenantId: string | null): void {
  activeTenantId = tenantId && tenantId.trim() ? tenantId.trim() : null;
}

/** The tenant apiFetch is currently scoping to, or null for the personal tenant. */
export function getActiveTenant(): string | null {
  return activeTenantId;
}

export function apiHref(path: string): string {
  if (!path.startsWith('/api/') && path !== '/api' && !path.startsWith('/health/')) {
    throw new Error('Only API and health paths may be sent through the authenticated proxy.');
  }
  return `/bff${path}`;
}

/** Return a safe API error for user-facing pages without exposing an unreadable raw response. */
export async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return body && typeof body.error === 'string' && body.error.trim()
    ? body.error
    : `${fallback} (HTTP ${response.status}).`;
}

function redirectToLogin(): never {
  if (typeof window !== 'undefined') {
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  throw new AuthenticationRequiredError();
}

/** Same-origin API client. Bearer tokens remain in HttpOnly cookies and are added by the BFF. */
export async function apiFetch(path: string, init?: ApiRequestInit): Promise<Response> {
  const href = apiHref(path);
  const headers = new Headers(init?.headers);
  // Scope the request to the selected tenant. Omitted for the personal tenant so behaviour is
  // unchanged from before tenancy; the BFF forwards this header to the API's tenant resolver.
  if (activeTenantId) headers.set(TENANT_HEADER, activeTenantId);
  const response = await fetch(href, {
    ...init,
    headers,
    credentials: 'same-origin',
  });
  if (response.status === 401) redirectToLogin();
  return response;
}
