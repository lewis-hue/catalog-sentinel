import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeOrganizationId,
  apiFetch,
  selectActiveOrganization,
} from './api-client';

function installWindow() {
  const values = new Map<string, string>();
  const assign = vi.fn();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    location: {
      pathname: '/overview',
      search: '',
      hash: '',
      assign,
    },
  });
  return { assign };
}

function organizationHeader(call: unknown[]): string | null {
  const init = call[1] as RequestInit;
  return new Headers(init.headers).get('x-sentinel-organization-id');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('apiFetch organization selection recovery', () => {
  it('clears an invalid stored selector and retries a GET exactly once without it', async () => {
    installWindow();
    selectActiveOrganization('revoked-org');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 403,
        headers: { 'x-sentinel-organization-selection': 'invalid' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/searches');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(organizationHeader(fetchMock.mock.calls[0])).toBe('revoked-org');
    expect(organizationHeader(fetchMock.mock.calls[1])).toBeNull();
    expect(activeOrganizationId()).toBe('');
  });

  it('clears an invalid stored selector but never replays a mutation', async () => {
    installWindow();
    selectActiveOrganization('revoked-org');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 403,
      headers: { 'x-sentinel-organization-selection': 'invalid' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/searches', { method: 'POST' });

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activeOrganizationId()).toBe('');
  });

  it('does not clear or retry an unrelated 403', async () => {
    installWindow();
    selectActiveOrganization('active-org');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/searches');

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activeOrganizationId()).toBe('active-org');
  });

  it('uses a candidate override without persisting, clearing, or recovery retry', async () => {
    installWindow();
    selectActiveOrganization('active-org');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 403,
      headers: { 'x-sentinel-organization-selection': 'invalid' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await apiFetch('/api/organization/workspace-memberships', {
      organizationId: 'candidate-org',
    });

    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(organizationHeader(fetchMock.mock.calls[0])).toBe('candidate-org');
    expect(activeOrganizationId()).toBe('active-org');
  });

  it('explicitly omits the selector from identity-scoped requests', async () => {
    installWindow();
    selectActiveOrganization('active-org');
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/integrations/steel/status', { organizationId: null });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(organizationHeader(fetchMock.mock.calls[0])).toBeNull();
    expect(activeOrganizationId()).toBe('active-org');
  });
});
