import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationRequiredError, apiFetch, apiHref } from './api-client';

function installWindow() {
  const assign = vi.fn();
  vi.stubGlobal('window', {
    location: {
      pathname: '/overview',
      search: '',
      hash: '',
      assign,
    },
  });
  return { assign };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiHref', () => {
  it('routes API and health paths through the same-origin proxy', () => {
    expect(apiHref('/api/searches')).toBe('/bff/api/searches');
    expect(apiHref('/health/ready')).toBe('/bff/health/ready');
  });

  it('refuses a path outside the authenticated proxy surface', () => {
    expect(() => apiHref('/other')).toThrow();
  });
});

describe('apiFetch', () => {
  it('forwards the request as-is and returns a successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/searches', { method: 'POST', headers: { 'x-test': '1' } });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [href, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(href).toBe('/bff/api/searches');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-test')).toBe('1');
    expect(init.credentials).toBe('same-origin');
  });

  it('redirects to sign in and throws on an expired session', async () => {
    const { assign } = installWindow();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/searches')).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(assign).toHaveBeenCalledWith('/auth/login?returnTo=%2Foverview');
  });
});
