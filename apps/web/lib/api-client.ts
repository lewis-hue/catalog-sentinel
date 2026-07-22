'use client';

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Your session has expired. Redirecting to sign in.');
    this.name = 'AuthenticationRequiredError';
  }
}

const ACTIVE_ORGANIZATION_KEY = 'sentinel.activeOrganizationId';

export function activeOrganizationId(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(ACTIVE_ORGANIZATION_KEY)?.trim() ?? '';
}

export function selectActiveOrganization(tenantId: string): void {
  const normalized = tenantId.trim();
  if (!normalized) window.localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
  else window.localStorage.setItem(ACTIVE_ORGANIZATION_KEY, normalized);
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

/** Same-origin API client. Bearer tokens remain in HttpOnly cookies and are added by the BFF. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const organizationId = activeOrganizationId();
  if (organizationId) headers.set('x-sentinel-organization-id', organizationId);
  const response = await fetch(apiHref(path), { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401) {
    if (typeof window !== 'undefined') {
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    throw new AuthenticationRequiredError();
  }
  return response;
}
