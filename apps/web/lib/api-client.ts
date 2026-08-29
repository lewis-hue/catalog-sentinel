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

/**
 * Per-request organization selection.
 *
 * - `undefined` uses the selection stored by the organization manager.
 * - `null` deliberately omits the selector (for identity-scoped endpoints).
 * - a string validates/uses that organization without persisting it.
 */
export interface ApiRequestInit extends RequestInit {
  organizationId?: string | null;
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

function isInvalidOrganizationSelection(response: Response): boolean {
  return response.status === 403
    && response.headers.get('x-sentinel-organization-selection')?.trim().toLowerCase() === 'invalid';
}

function requestHeaders(source: HeadersInit | undefined, organizationId: string): Headers {
  const headers = new Headers(source);
  // The typed option above is the sole source of this selector. This prevents a stale header in
  // a reused Headers object from surviving an explicit organization omission or recovery retry.
  headers.delete('x-sentinel-organization-id');
  if (organizationId) headers.set('x-sentinel-organization-id', organizationId);
  return headers;
}

/** Same-origin API client. Bearer tokens remain in HttpOnly cookies and are added by the BFF. */
export async function apiFetch(path: string, init?: ApiRequestInit): Promise<Response> {
  const hasOverride = Object.prototype.hasOwnProperty.call(init ?? {}, 'organizationId');
  const storedOrganizationId = hasOverride ? '' : activeOrganizationId();
  const organizationId = (
    hasOverride
      ? (init?.organizationId ?? '')
      : storedOrganizationId
  ).trim();
  const { organizationId: _organizationId, ...fetchInit } = init ?? {};
  const href = apiHref(path);
  const response = await fetch(href, {
    ...fetchInit,
    headers: requestHeaders(fetchInit.headers, organizationId),
    credentials: 'same-origin',
  });
  if (response.status === 401) redirectToLogin();

  if (!hasOverride && organizationId && isInvalidOrganizationSelection(response)) {
    // A durable server-side membership check is authoritative. Remove the now-invalid local
    // selector even for mutations, but never replay a mutation under the identity home tenant.
    selectActiveOrganization('');
    const method = (fetchInit.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const recovered = await fetch(href, {
        ...fetchInit,
        headers: requestHeaders(fetchInit.headers, ''),
        credentials: 'same-origin',
      });
      if (recovered.status === 401) redirectToLogin();
      return recovered;
    }
  }
  return response;
}
