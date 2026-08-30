'use client';

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Your session has expired. Redirecting to sign in.');
    this.name = 'AuthenticationRequiredError';
  }
}

export type ApiRequestInit = RequestInit;

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
  const response = await fetch(href, {
    ...init,
    credentials: 'same-origin',
  });
  if (response.status === 401) redirectToLogin();
  return response;
}
