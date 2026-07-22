import { describe, it, expect } from 'vitest';
import type { Browser } from 'playwright';
import { EnvelopeEncryptor } from '@sentinel/security';
import { CloudLiveBrowserProvider, createCloudLiveProvider, type HttpLike } from './cloud-live-provider';
import { createBrowserLinkProvider } from './factory';

function fakes() {
  const page = { goto: async () => null, addInitScript: async () => undefined, close: async () => undefined };
  const context = { pages: () => [page], newPage: async () => page, storageState: async () => ({ cookies: [], origins: [] }), close: async () => {} };
  const browser = { contexts: () => [context], newContext: async () => context, isConnected: () => true, close: async () => {} };
  const connected: string[] = [];
  const connect = async (cdp: string): Promise<Browser> => { connected.push(cdp); return browser as unknown as Browser; };
  return { page, context, browser, connect, connected };
}

const steelHttp: HttpLike = async (url, init) => {
  if (url.endsWith('/v1/sessions') && init?.method === 'POST') {
    // Mirrors Steel's real response shape.
    return { ok: true, status: 200, json: async () => ({ id: 'sess_1', websocketUrl: 'wss://connect.steel.dev?sessionId=sess_1', debugUrl: 'https://api.steel.dev/v1/sessions/sess_1/player', sessionViewerUrl: 'https://app.steel.dev/sessions/sess_1' }), text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

const CREATE = { tenantId: 't', artistWorkspaceId: 'aw', distributor: 'distrokid', targetLoginUrl: 'https://distrokid.com/signin', ttlMinutes: 20 };

describe('CloudLiveBrowserProvider (Steel)', () => {
  it('creates a session, connects over CDP, and returns the embeddable live-view URL', async () => {
    const f = fakes();
    const encryptor = new EnvelopeEncryptor();
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor, httpImpl: steelHttp,
      connect: f.connect, nowMs: () => 1_000, sessionTimeoutMs: 300_000,
    });
    const created = await p.createSession(CREATE);
    expect(p.provider).toBe('steel');
    // CDP endpoint carries the appended API key.
    expect(f.connected[0]).toBe('wss://connect.steel.dev?sessionId=sess_1&apiKey=key');
    expect(created.providerSessionRef).not.toContain('key');
    expect(created.expiresAt).toBe(new Date(301_000).toISOString());

    const access = await p.createUserAccessUrl(created.sessionId, { ttlMinutes: 20 });
    // The embeddable interactive player, not the dashboard.
    expect(access.url).toBe('https://api.steel.dev/v1/sessions/sess_1/player?interactive=true&showControls=true');

    const handoff = (await p.getRemoteSessionId(created.sessionId))!;
    const decoded = JSON.parse(encryptor.decrypt(handoff.slice('steel-handoff:'.length))) as Record<string, unknown>;
    expect(decoded).toEqual({ remoteId: 'sess_1' });
    expect(JSON.stringify(decoded)).not.toContain('apiKey');

    const conn = await p.attachAutomation(created.sessionId);
    expect(conn.baseUrl).toBe('https://distrokid.com');
    expect(await conn.newPage()).toBe(f.page);
  });

  it('anchors the advertised expiry before remote creation and browser setup', async () => {
    const f = fakes();
    let now = 1_000;
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: steelHttp,
      connect: async (cdp) => {
        // Model time consumed by the Steel POST, CDP connection, and initial navigation.
        now = 121_000;
        return f.connect(cdp);
      },
      nowMs: () => now,
      sessionTimeoutMs: 300_000,
    });

    const created = await p.createSession(CREATE);

    // The 300-second Steel lease began at t=1s, not after setup finished at t=121s.
    expect(created.expiresAt).toBe(new Date(301_000).toISOString());
  });

  it('keeps cloud semantics behind an HTTPS API proxy and omits the API key from handoff state', async () => {
    const f = fakes();
    const encryptor = new EnvelopeEncryptor();
    const provider = new CloudLiveBrowserProvider({
      service: 'steel',
      deploymentMode: 'cloud',
      apiKey: 'rotatable-cloud-key',
      baseUrl: 'https://steel-proxy.example/control',
      viewerOrigins: ['https://api.steel.dev'],
      encryptor,
      httpImpl: steelHttp,
      connect: f.connect,
    });

    const created = await provider.createSession(CREATE);
    const handoff = (await provider.getRemoteSessionId(created.sessionId))!;
    const decoded = JSON.parse(encryptor.decrypt(handoff.slice('steel-handoff:'.length))) as Record<string, unknown>;

    expect(Reflect.get(provider, 'selfHosted')).toBe(false);
    expect(decoded).toEqual({ remoteId: 'sess_1' });
    expect(JSON.stringify(decoded)).not.toContain('rotatable-cloud-key');
  });

  it('supports a SELF-HOSTED Steel Browser: no API key, custom base, internal CDP host rewrite', async () => {
    const f = fakes();
    const calls: string[] = [];
    const selfHostedHttp: HttpLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}${init?.headers?.['Steel-Api-Key'] ? ' +key' : ''}`);
      if (url.endsWith('/v1/sessions') && init?.method === 'POST') {
        // Self-hosted returns a CDP URL on the public CDP_DOMAIN + a browser-facing viewer URL, no debugUrl.
        return { ok: true, status: 200, json: async () => ({ id: 'sess_9', websocketUrl: 'ws://localhost:9223/devtools/browser/abc', sessionViewerUrl: 'http://localhost:3010/v1/sessions/sess_9/live' }), text: async () => '' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const p = new CloudLiveBrowserProvider({
      service: 'steel',
      baseUrl: 'http://steel:3000',
      cdpInternalHost: 'steel:9223',
      viewerOrigins: ['http://localhost:3010'],
      encryptor: new EnvelopeEncryptor(),
      httpImpl: selfHostedHttp,
      connect: f.connect,
    });
    const created = await p.createSession(CREATE);
    // POSTs to the self-hosted base, with NO API key header.
    expect(calls[0]).toBe('POST http://steel:3000/v1/sessions');
    // Backend connects CDP over the container network (host rewritten), no apiKey appended.
    expect(f.connected[0]).toBe('ws://steel:9223/devtools/browser/abc');
    // The user's browser gets the public live-view URL, untouched.
    const access = await p.createUserAccessUrl(created.sessionId, { ttlMinutes: 20 });
    expect(access.url).toBe('http://localhost:3010/v1/sessions/sess_9/live?interactive=true&showControls=true');
    const handoff = (await p.getRemoteSessionId(created.sessionId))!;
    expect(handoff).toMatch(/^steel-handoff:v1\./);
    expect(handoff).not.toContain('steel:9223');
    await p.detachLocalSession(created.sessionId);
    await (await p.attachRemoteSession(handoff, { releaseOnClose: false })).close();
    expect(f.connected[1]).toBe('ws://steel:9223/devtools/browser/abc');
  });

  it('releases a newly-created session instead of returning a viewer on an unapproved origin', async () => {
    const f = fakes();
    let releases = 0;
    const http: HttpLike = async (url, init) => {
      if (url.endsWith('/v1/sessions') && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'sess_phish',
            websocketUrl: 'wss://connect.steel.dev?sessionId=sess_phish',
            debugUrl: 'https://phishing.example/session/sess_phish',
          }),
          text: async () => '',
        };
      }
      if (url.includes('/sess_phish/release')) releases += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const provider = new CloudLiveBrowserProvider({
      service: 'steel',
      apiKey: 'key',
      viewerOrigins: ['https://api.steel.dev'],
      encryptor: new EnvelopeEncryptor(),
      httpImpl: http,
      connect: f.connect,
    });

    await expect(provider.createSession(CREATE)).rejects.toThrow(/unapproved origin/i);
    expect(releases).toBe(1);
    expect(f.connected).toEqual([]);
  });

  it('disconnects the API CDP client on handoff without closing or releasing the remote Steel session', async () => {
    let localDisconnects = 0;
    let contextCloses = 0;
    let remoteReleases = 0;
    let remoteAlive = true;
    const connected: string[] = [];
    const page = { goto: async () => null, addInitScript: async () => undefined, close: async () => undefined };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => { contextCloses += 1; remoteAlive = false; },
    };
    const connect = async (cdpUrl: string): Promise<Browser> => {
      if (!remoteAlive) throw new Error('remote Steel browser was closed');
      connected.push(cdpUrl);
      return {
        contexts: () => [context],
        newContext: async () => context,
        isConnected: () => true,
        // A connected Playwright Browser.close is a local client disconnect. Model that
        // separately from context.close/release, either of which would end the user session.
        close: async () => { localDisconnects += 1; },
      } as unknown as Browser;
    };
    const http: HttpLike = async (url, init) => {
      if (url.endsWith('/v1/sessions') && init?.method === 'POST') return steelHttp(url, init);
      if (url.includes('/release')) {
        remoteReleases += 1;
        remoteAlive = false;
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const provider = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: http, connect,
    });
    const created = await provider.createSession(CREATE);
    const handoff = (await provider.getRemoteSessionId(created.sessionId))!;

    await provider.detachLocalSession(created.sessionId);

    expect(localDisconnects).toBe(1);
    expect(contextCloses).toBe(0);
    expect(remoteReleases).toBe(0);
    expect(remoteAlive).toBe(true);
    await expect(provider.createUserAccessUrl(created.sessionId, { ttlMinutes: 20 })).rejects.toThrow(/Unknown session/i);

    const worker = await provider.attachRemoteSession(handoff, { releaseOnClose: false });
    await worker.close();
    expect(connected).toHaveLength(2);
    expect(remoteAlive).toBe(true);
  });

  it('does not propagate a credential-bearing CDP error message', async () => {
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'TOP-SECRET', encryptor: new EnvelopeEncryptor(), httpImpl: steelHttp,
      connect: async (url) => { throw new Error(`could not connect ${url}`); },
    });
    await expect(p.createSession(CREATE)).rejects.toSatisfy((err: unknown) => {
      return err instanceof Error && !err.message.includes('TOP-SECRET') && /initialize the Steel browser session/i.test(err.message);
    });
  });

  it('aborts a hung Steel create request at the configured REST deadline', async () => {
    let aborted = false;
    const hangingHttp: HttpLike = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted by test transport'));
      }, { once: true });
    });
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: hangingHttp,
      connect: fakes().connect, requestTimeoutMs: 5,
    });

    await expect(p.createSession(CREATE)).rejects.toThrow(/Steel API request timed out/i);
    expect(aborted).toBe(true);
  });

  it('keeps the create deadline active while a partial response body is parsed', async () => {
    let requestSignal: AbortSignal | undefined;
    const stalledBodyHttp: HttpLike = async (_url, init) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        status: 200,
        json: async () => new Promise<unknown>(() => undefined),
        text: async () => '',
      };
    };
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: stalledBodyHttp,
      connect: fakes().connect, requestTimeoutMs: 5,
    });

    await expect(p.createSession(CREATE)).rejects.toThrow(/Steel API request timed out/i);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('aborts a hung Steel release request and leaves it retryable', async () => {
    const f = fakes();
    let attempts = 0;
    let aborted = false;
    const http: HttpLike = async (_url, init) => {
      attempts += 1;
      if (attempts > 1) return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by test transport'));
        }, { once: true });
      });
    };
    const p = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: http,
      connect: f.connect, requestTimeoutMs: 5,
    });
    await p.attachRemoteSession('release-timeout', { releaseOnClose: false });

    await expect(p.releaseRemoteSession('release-timeout')).rejects.toThrow(/Steel API request timed out/i);
    expect(aborted).toBe(true);
    await expect(p.releaseRemoteSession('release-timeout')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('propagates terminate release failure, cleans up locally, and leaves remote release retryable', async () => {
    let releaseAttempts = 0;
    let browserCloses = 0;
    let contextCloses = 0;
    const page = { goto: async () => null, addInitScript: async () => undefined, close: async () => undefined };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => { contextCloses += 1; },
    };
    const browser = {
      contexts: () => [context],
      newContext: async () => context,
      isConnected: () => true,
      close: async () => { browserCloses += 1; },
    } as unknown as Browser;
    const http: HttpLike = async (url, init) => {
      if (url.endsWith('/v1/sessions') && init?.method === 'POST') return steelHttp(url, init);
      if (url.includes('/release')) {
        releaseAttempts += 1;
        if (releaseAttempts === 1) {
          return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
        }
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const provider = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: http,
      connect: async () => browser,
    });
    const created = await provider.createSession(CREATE);
    const handoff = (await provider.getRemoteSessionId(created.sessionId))!;

    await expect(provider.terminateSession(created.sessionId)).rejects.toThrow(/release failed with 500/i);
    expect(releaseAttempts).toBe(1);
    expect(contextCloses).toBe(1);
    expect(browserCloses).toBe(1);

    await expect(provider.releaseRemoteSession(handoff)).resolves.toBeUndefined();
    expect(releaseAttempts).toBe(2);
  });

  it('borrows one remote attachment across stages and releases exactly once at finalization', async () => {
    const f = fakes();
    const calls: string[] = [];
    const http: HttpLike = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const p = new CloudLiveBrowserProvider({ service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: http, connect: f.connect });

    const index = await p.attachRemoteSession('remote-1', { releaseOnClose: false });
    await index.newPage();
    await index.close();
    const chunk = await p.attachRemoteSession('remote-1', { releaseOnClose: false });
    await chunk.newPage();
    await chunk.close();

    expect(f.connected).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/release'))).toHaveLength(0);
    await p.releaseRemoteSession('remote-1');
    await p.releaseRemoteSession('remote-1');
    expect(calls.filter((c) => c.includes('/v1/sessions/remote-1/release'))).toHaveLength(1);
  });

  it('disconnects cached worker CDP transports on shutdown without releasing or closing the remote context', async () => {
    let browserCloses = 0;
    let contextCloses = 0;
    let releases = 0;
    const page = { close: async () => undefined, addInitScript: async () => undefined };
    const context = {
      pages: () => [],
      newPage: async () => page,
      close: async () => { contextCloses += 1; },
    };
    const browser = {
      contexts: () => [context],
      newContext: async () => context,
      isConnected: () => true,
      close: async () => { browserCloses += 1; },
    } as unknown as Browser;
    const http: HttpLike = async (url) => {
      if (url.includes('/release')) releases += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    const provider = new CloudLiveBrowserProvider({
      service: 'steel', apiKey: 'key', encryptor: new EnvelopeEncryptor(), httpImpl: http,
      connect: async () => browser,
    });

    const connection = await provider.attachRemoteSession('remote-worker', { releaseOnClose: false });
    await connection.close();
    await provider.disposeLocalConnections();
    await provider.disposeLocalConnections();

    expect(browserCloses).toBe(1);
    expect(contextCloses).toBe(0);
    expect(releases).toBe(0);
  });
});

describe('createCloudLiveProvider', () => {
  const enc = new EnvelopeEncryptor();
  it('picks SELF-HOSTED Steel when STEEL_API_URL is set (no key required)', () => {
    expect(createCloudLiveProvider({ STEEL_API_URL: 'http://steel:3000', STEEL_CDP_INTERNAL: 'steel:9223' } as NodeJS.ProcessEnv, enc)?.service).toBe('steel');
  });
  it('self_hosted + STEEL_API_URL picks Steel on a non-WSL2 host', () => {
    // detectWsl2() reads /proc/version, which is absent when the test runs on the host → false.
    expect(createCloudLiveProvider({ STEEL_CONNECTOR_MODE: 'self_hosted', STEEL_API_URL: 'http://steel:3000' } as NodeJS.ProcessEnv, enc)?.service).toBe('steel');
  });
  it('picks Steel CLOUD when mode=cloud + STEEL_API_KEY is set', () => {
    expect(createCloudLiveProvider({ STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc' } as NodeJS.ProcessEnv, enc)?.service).toBe('steel');
  });
  it('refuses an insecure or credential-bearing cloud API override', () => {
    expect(() => createCloudLiveProvider({
      STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc', STEEL_API_URL: 'http://api.steel.dev',
    } as NodeJS.ProcessEnv, enc)).toThrow(/HTTPS URL/);
    expect(() => createCloudLiveProvider({
      STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc', STEEL_API_URL: 'https://embedded@api.steel.dev',
    } as NodeJS.ProcessEnv, enc)).toThrow(/embedded credentials/);
  });
  it('infers cloud from STEEL_API_KEY alone (no explicit mode)', () => {
    expect(createCloudLiveProvider({ STEEL_API_KEY: 'ste-abc' } as NodeJS.ProcessEnv, enc)?.service).toBe('steel');
  });
  it('wires a valid STEEL_API_REQUEST_TIMEOUT_MS into the Steel provider', () => {
    const provider = createCloudLiveProvider({
      STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc', STEEL_API_REQUEST_TIMEOUT_MS: '2500',
    } as NodeJS.ProcessEnv, enc);
    expect(Reflect.get(provider!, 'requestTimeoutMs')).toBe(2_500);
  });
  it.each(['', '99', '60001', '-1', '2.5', 'Infinity', 'not-a-number'])(
    'falls back safely for invalid STEEL_API_REQUEST_TIMEOUT_MS=%j',
    (value) => {
      const provider = createCloudLiveProvider({
        STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc', STEEL_API_REQUEST_TIMEOUT_MS: value,
      } as NodeJS.ProcessEnv, enc);
      expect(Reflect.get(provider!, 'requestTimeoutMs')).toBe(10_000);
    },
  );
  it('returns null in cloud mode without an API key', () => {
    expect(createCloudLiveProvider({ STEEL_CONNECTOR_MODE: 'cloud' } as NodeJS.ProcessEnv, enc)).toBeNull();
  });
  it('returns null when nothing is configured', () => {
    expect(createCloudLiveProvider({} as NodeJS.ProcessEnv, enc)).toBeNull();
  });
  it('the generic production factory resolves steel to Steel, never to its mock default branch', () => {
    const provider = createBrowserLinkProvider({
      encryptor: enc,
      env: {
        NODE_ENV: 'production', BROWSER_LINK_PROVIDER: 'steel', STEEL_REQUIRED: 'true',
        STEEL_CONNECTOR_MODE: 'cloud', STEEL_API_KEY: 'ste-abc',
      } as NodeJS.ProcessEnv,
    });
    expect(provider.provider).toBe('steel');
  });
});
