import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { EnvelopeCrypto } from '@sentinel/security';
import { resolveSteelMode, detectWsl2, isSafeSteelCloudApiUrl } from '@sentinel/steel';
import {
  BrowserLinkUnavailableError,
  type AutomationConnection,
  type BrowserLinkProvider,
  type BrowserSessionStatusResult,
  type CreateBrowserSessionInput,
  type CreateBrowserSessionResult,
  type CreateUserAccessInput,
  type PersistStateInput,
  type PersistedBrowserStateRef,
  type RemoteAutomationOptions,
  type UserAccessUrl,
} from './types';
import { preparePageForEvaluate } from './page-helpers';

/** Minimal HTTP surface (injectable for tests). Matches global fetch. */
export type HttpLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Live attended browsing is Steel-only. */
export type CloudBrowserService = 'steel';

export interface CloudLiveProviderOptions {
  service: CloudBrowserService;
  /** Explicit Steel deployment mode; prevents a cloud HTTPS proxy from being mistaken for self-hosted Steel. */
  deploymentMode?: 'cloud' | 'external' | 'self_hosted';
  /** Optional for a SELF-HOSTED Steel Browser (no auth by default); required for cloud. */
  apiKey?: string;
  /** @deprecated Steel does not use a project id. Retained for source compatibility. */
  projectId?: string;
  /** Steel API base. Defaults to Steel cloud; set to a self-hosted Steel Browser (e.g. http://steel:3000). */
  baseUrl?: string;
  /**
   * For a self-hosted Steel reached over a container network: the API returns a CDP
   * websocketUrl built from its public CDP_DOMAIN (browser-facing), but our backend
   * connects over the internal network. When set (e.g. "steel:9223"), we rewrite the
   * websocketUrl host:port to this for the backend's CDP connection only. The
   * browser-facing live-view URL is left untouched.
   */
  cdpInternalHost?: string;
  encryptor: EnvelopeCrypto;
  httpImpl?: HttpLike;
  connect?: (cdpUrl: string) => Promise<Browser>;
  nowMs?: () => number;
  /** Remote session timeout (ms). Steel free plan caps at 15 min. */
  sessionTimeoutMs?: number;
  /** Hard deadline for Steel REST create/release calls. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  /** Exact browser-visible origins approved to host the attended Steel viewer. */
  viewerOrigins?: readonly string[];
}

const STEEL_CLOUD_BASE = 'https://api.steel.dev';
const DEFAULT_STEEL_API_REQUEST_TIMEOUT_MS = 10_000;
const MAX_STEEL_API_REQUEST_TIMEOUT_MS = 60_000;

interface RemoteSession {
  remoteId: string;
  cdpUrl: string;
  /** Embeddable interactive live view where the user completes the login. */
  liveViewUrl: string;
}

interface LiveSession {
  id: string;
  remoteId: string;
  cdpUrl: string;
  browser: Browser;
  context: BrowserContext;
  baseUrl: string;
  liveViewUrl: string;
  expiresAt: string;
}

interface PersistedPayload { storageState: Awaited<ReturnType<BrowserContext['storageState']>>; baseUrl: string }

interface RemoteAutomationSession {
  cdpUrl: string;
  browser: Browser;
  context: BrowserContext;
}

/**
 * Steel provider with an INTERACTIVE LIVE VIEW. The user logs into their distributor inside the embedded
 * live view; we drive read-only automation over the same CDP session. Runs the same
 * locally and on AWS. Provider secrets stay server-side.
 */
export class CloudLiveBrowserProvider implements BrowserLinkProvider {
  readonly provider = 'steel' as const;
  readonly service: CloudBrowserService;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly remoteAutomation = new Map<string, RemoteAutomationSession>();
  private readonly releasedRemoteIds = new Set<string>();
  private readonly http: HttpLike;
  private readonly connect: (cdpUrl: string) => Promise<Browser>;
  private readonly now: () => number;
  private readonly sessionTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly steelBase: string;
  private readonly selfHosted: boolean;
  private readonly viewerOrigins: ReadonlySet<string>;
  private counter = 0;

  constructor(private readonly opts: CloudLiveProviderOptions) {
    this.service = opts.service;
    this.http = opts.httpImpl ?? ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<HttpLike>);
    this.connect = opts.connect ?? ((cdp) => chromium.connectOverCDP(cdp));
    this.now = opts.nowMs ?? (() => Date.now());
    this.sessionTimeoutMs = opts.sessionTimeoutMs && Number.isFinite(opts.sessionTimeoutMs) && opts.sessionTimeoutMs > 0
      ? opts.sessionTimeoutMs
      : 890_000; // ~14.8 min (under Steel free cap)
    this.requestTimeoutMs = opts.requestTimeoutMs && Number.isFinite(opts.requestTimeoutMs) && opts.requestTimeoutMs > 0
      ? Math.max(1, Math.min(Math.trunc(opts.requestTimeoutMs), MAX_STEEL_API_REQUEST_TIMEOUT_MS))
      : DEFAULT_STEEL_API_REQUEST_TIMEOUT_MS;
    this.steelBase = (opts.baseUrl ?? STEEL_CLOUD_BASE).replace(/\/$/, '');
    // A cloud control-plane proxy is still cloud. Never infer deployment semantics from the
    // hostname: doing so can accidentally serialize the cloud API key into a reconnect handle.
    this.selfHosted = opts.deploymentMode
      ? opts.deploymentMode !== 'cloud'
      : !opts.apiKey;
    const defaultOrigins = this.selfHosted
      ? [new URL(this.steelBase).origin]
      : ['https://api.steel.dev', 'https://app.steel.dev'];
    try {
      this.viewerOrigins = new Set((opts.viewerOrigins ?? defaultOrigins).map(normalizeViewerOrigin));
    } catch {
      throw new BrowserLinkUnavailableError('steel', 'Steel viewer origins must be exact HTTP(S) origins without credentials, paths, queries, fragments, or wildcards.');
    }
    if (this.viewerOrigins.size === 0) {
      throw new BrowserLinkUnavailableError('steel', 'At least one exact Steel viewer origin is required.');
    }
    if (!this.selfHosted && !opts.apiKey) throw new BrowserLinkUnavailableError('steel', 'Steel cloud requires STEEL_API_KEY.');
  }

  async createSession(input: CreateBrowserSessionInput): Promise<CreateBrowserSessionResult> {
    // Keep our advertised expiry aligned with the timeout actually sent to Steel. The previous
    // code promised a 20-minute login window while the default Steel session expired after
    // 14.8 minutes, producing an unavoidable late-flow failure.
    const requestedTtlMs = Math.max(1, input.ttlMinutes) * 60_000;
    const effectiveTtlMs = Math.min(requestedTtlMs, this.sessionTimeoutMs);
    // Steel's timeout belongs to the remote session creation lifecycle. Anchor our public
    // deadline before the POST so CDP connection/navigation time can never extend the window
    // beyond what Steel was asked to keep alive.
    const creationStartedAt = this.now();
    const remote = await this.createRemoteSession(effectiveTtlMs);
    try {
      const browser = await this.connectSafe(remote.cdpUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(input.targetLoginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

      const sessionId = `${this.service}_${++this.counter}_${this.now().toString(36)}`;
      const expiresAt = new Date(creationStartedAt + effectiveTtlMs).toISOString();
      const providerSessionRef = await this.opts.encryptor.encrypt(`${this.service}-session:${sessionId}`);
      this.sessions.set(sessionId, { id: sessionId, remoteId: remote.remoteId, cdpUrl: remote.cdpUrl, browser, context, baseUrl: originOf(input.targetLoginUrl), liveViewUrl: remote.liveViewUrl, expiresAt });
      return { sessionId, status: 'CREATED', expiresAt, providerSessionRef };
    } catch {
      // Session creation succeeded remotely but local setup did not. No later owner exists, so
      // release immediately instead of billing/leaking it until timeout.
      await this.releaseRemote(remote.remoteId).catch(() => undefined);
      throw this.unavailable('Could not initialize the Steel browser session.');
    }
  }

  async getSessionStatus(sessionId: string): Promise<BrowserSessionStatusResult> {
    const s = this.require(sessionId);
    const expired = new Date(s.expiresAt).getTime() < this.now();
    return { sessionId, status: expired ? 'EXPIRED' : 'USER_ACTIVE', expiresAt: s.expiresAt, loggedInHint: null };
  }

  async createUserAccessUrl(sessionId: string, _input: CreateUserAccessInput): Promise<UserAccessUrl> {
    const s = this.require(sessionId);
    return { url: s.liveViewUrl, expiresAt: s.expiresAt };
  }

  async attachAutomation(sessionId: string): Promise<AutomationConnection> {
    const s = this.require(sessionId);
    // The CDP link can drop while the user is logging in (idle/close). Reconnect to
    // the SAME remote session — the login cookies persist server-side — so the
    // catalogue read still works.
    if (!s.browser.isConnected()) {
      s.browser = await this.connectSafe(s.cdpUrl);
      s.context = s.browser.contexts()[0] ?? (await s.browser.newContext());
    }
    const borrowedPages = new Set<Page>();
    return {
      baseUrl: s.baseUrl,
      newPage: async () => {
        const page = await s.context.newPage();
        borrowedPages.add(page);
        return preparePageForEvaluate(page);
      },
      close: async () => { await Promise.allSettled([...borrowedPages].map((page) => page.close())); },
    };
  }

  // --- Cross-process handoff (durable catalogue-read worker) -----------------
  // Steel cloud sessions are addressable by their REMOTE id from ANY process/container. So
  // after the user logs in on the API, a separate worker can re-attach to the SAME logged-in
  // browser (same session, same IP — no re-login) by remote id and do the long catalogue read
  // durably. The API hands off the remote id, detaches its local CDP handle WITHOUT releasing
  // the session, and the worker attaches, reads, then releases.

  /**
   * An opaque encrypted reconnect handle for a live Steel session. Cloud handles deliberately
   * contain only the remote id; workers reconstruct CDP with their own process-local Steel key,
   * so a long-lived provider credential is never copied into BullMQ job payloads. Self-hosted
   * handles retain the provider-specific CDP path but have no cloud API key.
   */
  async getRemoteSessionId(sessionId: string): Promise<string | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const payload = this.selfHosted
      ? { remoteId: session.remoteId, cdpUrl: session.cdpUrl }
      : { remoteId: session.remoteId };
    return `steel-handoff:${await this.opts.encryptor.encrypt(JSON.stringify(payload))}`;
  }

  /** Disconnect this process's CDP client without releasing or closing the authenticated Steel browser. */
  async detachLocalSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);

    // Playwright documents Browser.close() on a *connected* browser as a disconnect from the
    // browser server. For chromium.connectOverCDP specifically, Playwright closes its local
    // WebSocket transport; it does not send Chrome's Browser.close command. Do not close the
    // context here: this is Steel's persistent/default context and the user is still operating it
    // through the live viewer. Likewise, remote release belongs to the terminal pipeline owner.
    // Keep handoff non-blocking: a remote WebSocket close handshake must not prevent the API from
    // returning the already-durable viewer URL. Calling the async method starts teardown before
    // this method returns, and any transport error is intentionally local/best-effort.
    void session.browser.close({ reason: 'Steel session handed off to the durable worker' }).catch(() => undefined);
  }

  /** Attach to an existing Steel session by its REMOTE id (no in-memory session needed).
   *  The old single-job contract releases on close. Multi-stage pipelines pass false and
   *  explicitly release once at terminal finalization. */
  async attachRemoteSession(remoteHandle: string, options: RemoteAutomationOptions = {}): Promise<AutomationConnection> {
    const { remoteId, cdpUrl: handedOffCdpUrl } = await this.decodeRemoteHandle(remoteHandle);
    const releaseOnClose = options.releaseOnClose ?? true;
    let remote = this.remoteAutomation.get(remoteId);
    if (!remote) {
      const cdpUrl = handedOffCdpUrl ?? this.buildCdpUrl(remoteId);
      const browser = await this.connectSafe(cdpUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      remote = { cdpUrl, browser, context };
      this.remoteAutomation.set(remoteId, remote);
    }
    const state = remote;
    const borrowedPages = new Set<Page>();
    return {
      baseUrl: '',
      newPage: async () => {
        if (!state.browser.isConnected()) {
          state.browser = await this.connectSafe(state.cdpUrl);
          state.context = state.browser.contexts()[0] ?? (await state.browser.newContext());
        }
        const page = await state.context.newPage();
        borrowedPages.add(page);
        return preparePageForEvaluate(page);
      },
      close: async () => {
        await Promise.allSettled([...borrowedPages].map((page) => page.close()));
        if (releaseOnClose) await this.releaseRemoteSession(remoteHandle);
      },
    };
  }

  /** Release the remote Steel session exactly once for this provider instance. */
  async releaseRemoteSession(remoteHandle: string): Promise<void> {
    const { remoteId } = await this.decodeRemoteHandle(remoteHandle);
    if (this.releasedRemoteIds.has(remoteId)) return;
    await this.releaseRemote(remoteId);
    this.releasedRemoteIds.add(remoteId);
    const remote = this.remoteAutomation.get(remoteId);
    this.remoteAutomation.delete(remoteId);
    if (remote) {
      void remote.context.close().catch(() => undefined);
      void remote.browser.close().catch(() => undefined);
    }
  }

  /** Disconnect worker-local CDP transports without releasing the remote Steel sessions. */
  async disposeLocalConnections(): Promise<void> {
    const local = [...this.remoteAutomation.values()];
    this.remoteAutomation.clear();
    // These Browser objects came from chromium.connectOverCDP. Browser.close disconnects this
    // Playwright client; closing the persistent context would terminate the remote user session.
    await Promise.allSettled(local.map((session) => session.browser.close({ reason: 'worker shutdown' })));
  }

  /** Build the CDP websocket URL for a Steel remote session id (cloud or self-hosted). */
  private buildCdpUrl(remoteId: string): string {
    const base = this.selfHosted ? `ws://${this.opts.cdpInternalHost ?? 'localhost:9223'}` : 'wss://connect.steel.dev';
    let url = `${base}?sessionId=${encodeURIComponent(remoteId)}`;
    if (this.opts.apiKey) url += `&apiKey=${encodeURIComponent(this.opts.apiKey)}`;
    return url;
  }

  async persistState(sessionId: string, input: PersistStateInput): Promise<PersistedBrowserStateRef> {
    const s = this.require(sessionId);
    const payload: PersistedPayload = { storageState: await s.context.storageState(), baseUrl: s.baseUrl };
    return { kind: input.kind, encryptedRef: await this.opts.encryptor.encrypt(JSON.stringify(payload)), expiresAt: new Date(this.now() + input.ttlHours * 3_600_000).toISOString() };
  }

  async resumeFromState(stateRef: PersistedBrowserStateRef): Promise<AutomationConnection> {
    let payload: PersistedPayload;
    try {
      payload = JSON.parse(await this.opts.encryptor.decrypt(stateRef.encryptedRef)) as PersistedPayload;
    } catch {
      throw new BrowserLinkUnavailableError(this.service, 'Could not decrypt the persisted browser state.');
    }
    const remote = await this.createRemoteSession(this.sessionTimeoutMs);
    const browser = await this.connectSafe(remote.cdpUrl);
    const context = await browser.newContext({ storageState: payload.storageState });
    return {
      baseUrl: payload.baseUrl,
      newPage: async () => preparePageForEvaluate(await context.newPage()),
      close: async () => { await this.releaseRemoteSession(remote.remoteId).catch(() => undefined); await context.close().catch(() => undefined); await browser.close().catch(() => undefined); },
    };
  }

  async makeReadOnly(sessionId: string): Promise<void> { this.require(sessionId); }

  async terminateSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    try {
      // Release the REMOTE session FIRST — a cheap REST call that frees cloud credits and
      // ends the session server-side. This is the part that must happen, so its failure must
      // reach the caller: durable cancellation code then restores the encrypted handoff for a
      // retry instead of falsely reporting that Steel termination succeeded.
      await this.releaseRemoteSession(s.remoteId);
    } finally {
      // Local CDP cleanup is best-effort and must not mask the Steel REST result. Closing a
      // CDP-connected browser can wait on a remote websocket handshake, so initiate teardown
      // without making the cancellation response depend on that handshake.
      void s.context.close().catch(() => undefined);
      void s.browser.close().catch(() => undefined);
    }
  }

  async deletePersistedState(_stateRef: PersistedBrowserStateRef): Promise<void> { /* state lives only in our encrypted ref */ }

  // --- Service-specific REST calls -----------------------------------------
  private async createRemoteSession(timeoutMs: number): Promise<RemoteSession> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers['Steel-Api-Key'] = this.opts.apiKey;
    const data = await this.json<{ id: string; websocketUrl?: string; debugUrl?: string; sessionViewerUrl?: string }>(
      `${this.steelBase}/v1/sessions`,
      { method: 'POST', headers, body: JSON.stringify({ timeout: timeoutMs }) },
    );
    if (!data?.id) throw this.unavailable('Steel did not return a session id.');
    const wsBase = data.websocketUrl ?? (this.selfHosted ? `ws://${this.opts.cdpInternalHost ?? 'localhost:9223'}?sessionId=${data.id}` : `wss://connect.steel.dev?sessionId=${data.id}`);
    let cdpUrl = this.selfHosted && this.opts.cdpInternalHost ? rewriteHost(wsBase, this.opts.cdpInternalHost) : wsBase;
    if (this.opts.apiKey && !cdpUrl.includes('apiKey=')) cdpUrl = `${cdpUrl}${cdpUrl.includes('?') ? '&' : '?'}apiKey=${encodeURIComponent(this.opts.apiKey)}`;
    const rawLiveViewUrl = data.debugUrl ?? data.sessionViewerUrl;
    if (!rawLiveViewUrl) {
      await this.releaseRemote(data.id).catch(() => undefined);
      throw this.unavailable('Steel did not return a live-view URL.');
    }
    let liveViewUrl: string;
    try {
      liveViewUrl = interactiveSteelViewerUrl(rawLiveViewUrl, this.viewerOrigins);
    } catch {
      // A viewer URL is a bearer capability for the user's full-authority signed-in browser.
      // Never return an unapproved origin, and terminate the just-created remote session first.
      await this.releaseRemote(data.id).catch(() => undefined);
      throw this.unavailable('Steel returned a live-view URL on an unapproved origin.');
    }
    return { remoteId: data.id, cdpUrl, liveViewUrl };
  }

  private async releaseRemote(remoteId: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers['Steel-Api-Key'] = this.opts.apiKey;
    const resp = await this.request(`${this.steelBase}/v1/sessions/${encodeURIComponent(remoteId)}/release`, { method: 'POST', headers });
    // Release is idempotent from the application's perspective. A prior request may have reached
    // Steel even when its response was lost, so "already gone" is a successful terminal state.
    if (!resp.ok && resp.status !== 404 && resp.status !== 410) throw this.unavailable(`Steel API release failed with ${resp.status}`);
  }

  private async json<T>(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T | null> {
    try {
      return await this.withRequestDeadline(async (signal) => {
        const resp = await this.http(url, { ...init, signal });
        if (!resp.ok) throw this.unavailable(`Steel API ${init.method ?? 'GET'} request failed with ${resp.status}.`);
        return (await resp.json()) as T;
      });
    } catch (err) {
      if (err instanceof BrowserLinkUnavailableError) throw err;
      throw this.unavailable(`${this.service} API request failed.`);
    }
  }

  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Awaited<ReturnType<HttpLike>>> {
    return this.withRequestDeadline((signal) => this.http(url, { ...init, signal }));
  }

  private async withRequestDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = this.unavailable('Steel API request timed out.');
          reject(error);
          controller.abort();
        }, this.requestTimeoutMs);
      });
      return await Promise.race([
        operation(controller.signal),
        deadline,
      ]);
    } catch (err) {
      if (err instanceof BrowserLinkUnavailableError) throw err;
      throw this.unavailable('Steel API request failed.');
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async connectSafe(cdpUrl: string): Promise<Browser> {
    try {
      return await this.connect(cdpUrl);
    } catch {
      // CDP URLs may contain Steel credentials. Never propagate a third-party websocket error
      // whose message could echo the attempted URL into an API response, log, or saved result.
      throw this.unavailable('Could not attach to the Steel browser session.');
    }
  }

  private async decodeRemoteHandle(value: string): Promise<{ remoteId: string; cdpUrl?: string }> {
    if (!value.startsWith('steel-handoff:')) return { remoteId: value };
    try {
      const decoded = JSON.parse(await this.opts.encryptor.decrypt(value.slice('steel-handoff:'.length))) as {
        remoteId?: unknown;
        cdpUrl?: unknown;
      };
      if (typeof decoded.remoteId !== 'string' || !decoded.remoteId) throw new Error('invalid');
      if (decoded.cdpUrl === undefined) return { remoteId: decoded.remoteId };
      if (typeof decoded.cdpUrl !== 'string') throw new Error('invalid');
      const url = new URL(decoded.cdpUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || decoded.cdpUrl.length > 4096) throw new Error('invalid');
      return { remoteId: decoded.remoteId, cdpUrl: decoded.cdpUrl };
    } catch {
      throw this.unavailable('The encrypted Steel reconnect handle is invalid.');
    }
  }

  private unavailable(msg: string): BrowserLinkUnavailableError { return new BrowserLinkUnavailableError(this.service, msg); }
  private require(sessionId: string): LiveSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw this.unavailable(`Unknown session ${sessionId}`);
    return s;
  }
}

function originOf(url: string): string { try { return new URL(url).origin; } catch { return url; } }

function normalizeViewerOrigin(raw: string): string {
  if (raw.includes('*')) throw new Error('wildcard');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('invalid origin');
  return url.origin;
}

/** Steel viewers need both flags for human keyboard/mouse control. */
function interactiveSteelViewerUrl(raw: string, allowedOrigins: ReadonlySet<string>): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowedOrigins.has(url.origin)) {
    throw new Error('unapproved Steel viewer origin');
  }
  url.searchParams.set('interactive', 'true');
  url.searchParams.set('showControls', 'true');
  return url.toString();
}

/** Swap the host:port of a ws(s):// URL, preserving scheme, path, and query. */
function rewriteHost(wsUrl: string, hostPort: string): string {
  try { const u = new URL(wsUrl); u.host = hostPort; return u.toString(); } catch { return wsUrl; }
}

/** Build a cloud live-view provider from the environment, or null if unconfigured. */
export function createCloudLiveProvider(env: NodeJS.ProcessEnv, encryptor: EnvelopeCrypto): CloudLiveBrowserProvider | null {
  const timeout = env.STEEL_SESSION_TIMEOUT_MS ? Number(env.STEEL_SESSION_TIMEOUT_MS) : undefined;
  const sessionTimeoutMs = timeout && Number.isFinite(timeout) ? timeout : undefined;
  const t = sessionTimeoutMs ? { sessionTimeoutMs } : {};
  const configuredApiRequestTimeout = env.STEEL_API_REQUEST_TIMEOUT_MS?.trim();
  const parsedApiRequestTimeout = configuredApiRequestTimeout ? Number(configuredApiRequestTimeout) : undefined;
  const requestTimeoutMs = parsedApiRequestTimeout !== undefined
    && Number.isInteger(parsedApiRequestTimeout)
    && parsedApiRequestTimeout >= 100
    && parsedApiRequestTimeout <= MAX_STEEL_API_REQUEST_TIMEOUT_MS
    ? parsedApiRequestTimeout
    : undefined;
  const rt = requestTimeoutMs ? { requestTimeoutMs } : {};
  const viewerOrigins = env.STEEL_VIEWER_ORIGINS?.split(/[\s,]+/).filter(Boolean);
  const vo = viewerOrigins?.length ? { viewerOrigins } : {};
  // Steel is the attended cloud browser users log into their distributor inside.
  //   • mode=cloud       → Steel's hosted service (steel.dev) via STEEL_API_KEY. Its isolated
  //                        managed browser works from every supported development host.
  //                        STEEL_API_URL optionally overrides the cloud base (else api.steel.dev).
  //   • mode=external     → a REMOTE Linux Steel via STEEL_API_URL (e.g. an SSH tunnel).
  //   • mode=self_hosted  → a PRIVATE Steel service via STEEL_API_URL. STEEL_CDP_INTERNAL
  //                        (e.g. steel:9223) lets the backend reach CDP over the container net
  //                        while the user's browser uses Steel's public live-view URL.
  //   • mode=self_hosted on WSL2  → null: use cloud/external Steel; never a local fallback.
  const mode = resolveSteelMode(env as Record<string, string | undefined>);
  if (mode === 'cloud') {
    if (!env.STEEL_API_KEY || !env.STEEL_API_KEY.trim()) return null; // no key → let connect flow degrade
    const cloudBase = env.STEEL_API_URL?.trim();
    if (cloudBase && !isSafeSteelCloudApiUrl(cloudBase)) {
      throw new BrowserLinkUnavailableError(
        'steel',
        'Steel cloud API URL must be an absolute HTTPS URL without embedded credentials.',
      );
    }
    return new CloudLiveBrowserProvider({
      service: 'steel',
      deploymentMode: 'cloud',
      apiKey: env.STEEL_API_KEY.trim(),
      ...(cloudBase ? { baseUrl: cloudBase } : {}),
      encryptor,
      ...vo,
      ...t,
      ...rt,
    });
  }
  if ((mode === 'external' || mode === 'self_hosted') && env.STEEL_API_URL) {
    if (mode === 'self_hosted' && detectWsl2()) return null;
    return new CloudLiveBrowserProvider({
      service: 'steel',
      deploymentMode: mode,
      baseUrl: env.STEEL_API_URL,
      encryptor,
      ...vo,
      ...(env.STEEL_CDP_INTERNAL ? { cdpInternalHost: env.STEEL_CDP_INTERNAL } : {}),
      ...t,
      ...rt,
    });
  }
  return null;
}
