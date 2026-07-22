import { describe, it, expect } from 'vitest';
import { probeSteelHealth, resolveSteelMode, isSteelRequired, detectWsl2, redactUrl, type EnvLike, type ProbeDeps } from './steelHealth';

const wsl2Proc = () => 'Linux version 6.6.87.2-microsoft-standard-WSL2 (root@x) #1 SMP';
const linuxProc = () => 'Linux version 6.5.0-1024-aws (buildd@x) #24-Ubuntu SMP';
const reachable: ProbeDeps['fetchImpl'] = async () => ({ ok: true, status: 200 });
const unreachable: ProbeDeps['fetchImpl'] = async () => { throw new Error('ECONNREFUSED'); };
const now = () => '2026-07-13T00:00:00.000Z';

const probe = (env: EnvLike, deps: Partial<ProbeDeps> = {}) =>
  probeSteelHealth(env, { readProcVersion: linuxProc, fetchImpl: reachable, now, ...deps });

describe('resolveSteelMode', () => {
  it('honors explicit modes', () => {
    expect(resolveSteelMode({ STEEL_CONNECTOR_MODE: 'cloud' })).toBe('cloud');
    expect(resolveSteelMode({ STEEL_CONNECTOR_MODE: 'external' })).toBe('external');
    expect(resolveSteelMode({ STEEL_CONNECTOR_MODE: 'self_hosted' })).toBe('self_hosted');
  });
  it('defaults to cloud when unset so missing credentials fail closed', () => {
    expect(resolveSteelMode({})).toBe('cloud');
  });
  it('infers cloud when STEEL_API_KEY is set', () => {
    expect(resolveSteelMode({ STEEL_API_KEY: 'ste-abc' })).toBe('cloud');
  });
  it('infers external when only STEEL_API_URL is set', () => {
    expect(resolveSteelMode({ STEEL_API_URL: 'http://steel:3000' })).toBe('external');
  });
});

describe('isSteelRequired', () => {
  it('parses truthy values', () => {
    expect(isSteelRequired({ STEEL_REQUIRED: 'true' })).toBe(true);
    expect(isSteelRequired({ STEEL_REQUIRED: '1' })).toBe(true);
    expect(isSteelRequired({ STEEL_REQUIRED: 'false' })).toBe(false);
    expect(isSteelRequired({})).toBe(false);
  });
});

describe('detectWsl2', () => {
  it('detects WSL2 from /proc/version', () => {
    expect(detectWsl2(wsl2Proc)).toBe(true);
    expect(detectWsl2(linuxProc)).toBe(false);
  });
  it('never throws when /proc/version is unreadable', () => {
    expect(detectWsl2(() => { throw new Error('no proc'); })).toBe(false);
  });
});

describe('redactUrl', () => {
  it('strips credentials and path, keeps host only', () => {
    expect(redactUrl('http://user:pass@steel.internal:3000/v1/sessions')).toBe('http://steel.internal:3000');
    expect(redactUrl('http://steel:3000')).toBe('http://steel:3000');
    expect(redactUrl('')).toBeNull();
    expect(redactUrl(undefined)).toBeNull();
  });
});

describe('probeSteelHealth', () => {
  it('rejects unsupported connector modes without a fallback', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'unsupported' });
    expect(h.status).toBe('MISCONFIGURED');
    expect(h.loginMode).toBe('disabled');
    expect(h.liveLoginAvailable).toBe(false);
    expect(h.apiUrl).toBeNull();
  });

  it('cloud mode WITHOUT STEEL_API_KEY → MISCONFIGURED', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'cloud' });
    expect(h.status).toBe('MISCONFIGURED');
    expect(h.mode).toBe('cloud');
    expect(h.message).toMatch(/STEEL_API_KEY/);
  });

  it('cloud mode WITH key, reachable → READY at api.steel.dev (no URL needed)', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-secret-key' });
    expect(h.status).toBe('READY');
    expect(h.loginMode).toBe('steel');
    expect(h.liveLoginAvailable).toBe(true);
    expect(h.apiUrl).toBe('https://api.steel.dev');
  });

  it.each(['http://api.steel.dev', 'https://key@api.steel.dev', 'not-a-url'])(
    'fails closed before sending a cloud key to unsafe override %s',
    async (url) => {
      let fetched = false;
      const h = await probeSteelHealth(
        { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-secret-key', STEEL_API_URL: url },
        { readProcVersion: linuxProc, fetchImpl: async () => { fetched = true; return { ok: true, status: 200 }; } },
      );
      expect(h.status).toBe('MISCONFIGURED');
      expect(h.message).toMatch(/HTTPS URL/);
      expect(fetched).toBe(false);
    },
  );

  it('probes the authenticated cloud Sessions API with the official Steel key header', async () => {
    let request: { url: string; init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } } | undefined;
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-secret-key' },
      { fetchImpl: async (url, init) => { request = { url, init }; return { ok: true, status: 200 }; } },
    );

    expect(h.status).toBe('READY');
    expect(request?.url).toBe('https://api.steel.dev/v1/sessions');
    expect(request?.init?.method).toBe('GET');
    expect(request?.init?.headers).toEqual({ 'steel-api-key': 'ste-secret-key' });
    expect(request?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('closes an authenticated probe response body after reading the status', async () => {
    let cancelled = 0;
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-secret-key' },
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: { async cancel() { cancelled++; } },
        }),
      },
    );

    expect(h.status).toBe('READY');
    expect(cancelled).toBe(1);
  });

  it.each([401, 403, 404])('cloud HTTP %i is not READY', async (status) => {
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'bad-or-revoked-key' },
      { fetchImpl: async () => ({ ok: false, status }) },
    );

    expect(h.status).toBe('UNREACHABLE');
    expect(h.liveLoginAvailable).toBe(false);
    expect(h.loginMode).toBe('disabled');
  });

  it('does not let a public health-path override bypass the authenticated cloud probe', async () => {
    let requested = '';
    const health = await probeSteelHealth(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'key', STEEL_HEALTH_PATH: '/v1/health' },
      {
        readProcVersion: () => 'Linux',
        fetchImpl: async (url) => { requested = url; return { ok: false, status: 401 }; },
      },
    );
    expect(requested).toBe('https://api.steel.dev/v1/sessions');
    expect(health.status).toBe('UNREACHABLE');
  });

  it('requires a 2xx response even when a fetch implementation reports ok inconsistently', async () => {
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-key' },
      { fetchImpl: async () => ({ ok: true, status: 302 }) },
    );
    expect(h.status).toBe('UNREACHABLE');
  });

  it('aborts and returns within the configured bound when the cloud probe hangs', async () => {
    let aborted = false;
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-key' },
      {
        timeoutMs: 5,
        fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          }, { once: true });
        }),
      },
    );

    expect(h.status).toBe('UNREACHABLE');
    expect(aborted).toBe(true);
  });

  it('cloud mode works on WSL2 (Steel runs remotely) → READY', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-secret-key' }, { readProcVersion: wsl2Proc });
    expect(h.status).toBe('READY');
    expect(h.wsl2).toBe(true);
    expect(h.liveLoginAvailable).toBe(true);
  });

  it('cloud mode never leaks the API key in the payload', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-super-secret-key' });
    expect(JSON.stringify(h)).not.toContain('ste-super-secret-key');
    expect(JSON.stringify(h)).not.toContain('secret');
  });

  it('cloud unreachable + NOT required → UNREACHABLE, disables login without fallback', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-key' }, { fetchImpl: unreachable });
    expect(h.status).toBe('UNREACHABLE');
    expect(h.loginMode).toBe('disabled');
  });

  it('external mode WITHOUT STEEL_API_URL → MISCONFIGURED', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'external' });
    expect(h.status).toBe('MISCONFIGURED');
  });

  it('self_hosted mode WITHOUT STEEL_API_URL → MISCONFIGURED', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'self_hosted' });
    expect(h.status).toBe('MISCONFIGURED');
  });

  it('self_hosted on WSL2 → UNSUPPORTED_LOCAL_ENV with the WSL2 message', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'self_hosted', STEEL_API_URL: 'http://steel:3000' }, { readProcVersion: wsl2Proc });
    expect(h.status).toBe('UNSUPPORTED_LOCAL_ENV');
    expect(h.wsl2).toBe(true);
    expect(h.message).toMatch(/Windows\/WSL2 environment/i);
    expect(h.liveLoginAvailable).toBe(false);
  });

  it('external on WSL2 is fine (Steel runs remotely) → READY when reachable', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'external', STEEL_API_URL: 'http://host.docker.internal:3900' }, { readProcVersion: wsl2Proc });
    expect(h.status).toBe('READY');
    expect(h.liveLoginAvailable).toBe(true);
    expect(h.loginMode).toBe('steel');
  });

  it('preserves the unauthenticated /v1/health probe for external Steel', async () => {
    let request: { url: string; headers?: Record<string, string> } | undefined;
    const h = await probe(
      { STEEL_CONNECTOR_MODE: 'external', STEEL_API_URL: 'http://steel.example:3000', STEEL_API_KEY: 'not-for-external-health' },
      { fetchImpl: async (url, init) => { request = { url, headers: init?.headers }; return { ok: true, status: 204 }; } },
    );

    expect(h.status).toBe('READY');
    expect(request).toEqual({ url: 'http://steel.example:3000/v1/health', headers: undefined });
  });

  it('self_hosted on Linux, reachable → READY', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'self_hosted', STEEL_API_URL: 'http://steel:3000' });
    expect(h.status).toBe('READY');
    expect(h.apiUrl).toBe('http://steel:3000');
  });

  it('unreachable + NOT required → UNREACHABLE, disables login without fallback', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'external', STEEL_API_URL: 'http://steel:3000', STEEL_REQUIRED: 'false' }, { fetchImpl: unreachable });
    expect(h.status).toBe('UNREACHABLE');
    expect(h.required).toBe(false);
    expect(h.loginMode).toBe('disabled');
  });

  it('unreachable + REQUIRED → UNREACHABLE, login disabled', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'self_hosted', STEEL_API_URL: 'http://steel:3000', STEEL_REQUIRED: 'true' }, { fetchImpl: unreachable });
    expect(h.status).toBe('UNREACHABLE');
    expect(h.required).toBe(true);
    expect(h.loginMode).toBe('disabled');
  });

  it('never leaks credentials in apiUrl or message', async () => {
    const h = await probe({ STEEL_CONNECTOR_MODE: 'external', STEEL_API_URL: 'http://user:SECRET@steel:3000/x' }, { fetchImpl: unreachable });
    expect(JSON.stringify(h)).not.toContain('SECRET');
  });
});
