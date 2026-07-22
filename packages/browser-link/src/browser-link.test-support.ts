import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { EnvelopeCrypto } from '@sentinel/security';
import { preparePageForEvaluate } from './page-helpers';
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
  type UserAccessUrl,
} from './types';

interface TestSession {
  id: string;
  status: BrowserSessionStatusResult['status'];
  expiresAt: string;
  loggedIn: boolean;
}

export interface TestBrowserLinkProviderOptions {
  /** file:// (or http://) base URL of the DistroKid fixture pages. */
  fixturesBaseUrl: string;
  encryptor: EnvelopeCrypto;
  nowMs?: () => number;
  /** Simulate a session where the user has NOT logged in (login-required fixture). */
  simulateLoggedOut?: boolean;
}

/**
 * Deterministic test-only browser-link double. It is intentionally excluded from
 * the package runtime entrypoint.
 */
export class TestBrowserLinkProvider implements BrowserLinkProvider {
  readonly provider = 'steel' as const;
  private readonly sessions = new Map<string, TestSession>();
  private readonly now: () => number;
  private counter = 0;
  private browser: Browser | null = null;
  private readonly contexts = new Set<BrowserContext>();

  constructor(private readonly opts: TestBrowserLinkProviderOptions) {
    this.now = opts.nowMs ?? (() => Date.now());
  }

  async createSession(input: CreateBrowserSessionInput): Promise<CreateBrowserSessionResult> {
    const sessionId = `test_sess_${++this.counter}`;
    const expiresAt = new Date(this.now() + input.ttlMinutes * 60_000).toISOString();
    this.sessions.set(sessionId, { id: sessionId, status: 'CREATED', expiresAt, loggedIn: !this.opts.simulateLoggedOut });
    return {
      sessionId,
      status: 'CREATED',
      expiresAt,
      // Backend-only, will be stored encrypted. Not the real provider secret.
      providerSessionRef: await this.opts.encryptor.encrypt(`test-provider-session:${sessionId}`),
    };
  }

  async getSessionStatus(sessionId: string): Promise<BrowserSessionStatusResult> {
    const s = this.require(sessionId);
    const expired = new Date(s.expiresAt).getTime() < this.now();
    return {
      sessionId,
      status: expired ? 'EXPIRED' : s.status,
      expiresAt: s.expiresAt,
      // Safe hint only — never exposes cookies/tokens.
      loggedInHint: expired ? null : s.loggedIn,
    };
  }

  async createUserAccessUrl(sessionId: string, _input: CreateUserAccessInput): Promise<UserAccessUrl> {
    const s = this.require(sessionId);
    s.status = 'USER_ACTIVE';
    // Same-origin HTTP path to the simulated sign-in page (served by the API and
    // reached through the web proxy), so it renders in the login iframe. A real
    // provider returns its own interactive https live URL here instead.
    return { url: `https://viewer.test.invalid/session/${sessionId}`, expiresAt: s.expiresAt };
  }

  async attachAutomation(sessionId: string): Promise<AutomationConnection> {
    const s = this.require(sessionId);
    s.status = 'LOGIN_CONFIRMED';
    return this.createAutomationConnection(await this.ensureBrowser());
  }

  async persistState(sessionId: string, input: PersistStateInput): Promise<PersistedBrowserStateRef> {
    this.require(sessionId);
    // Encrypt a placeholder so persistence and TTL behavior can be exercised.
    return {
      kind: input.kind,
      encryptedRef: await this.opts.encryptor.encrypt(JSON.stringify({ testSession: true, sessionId })),
      expiresAt: new Date(this.now() + input.ttlHours * 3_600_000).toISOString(),
    };
  }

  async resumeFromState(_stateRef: PersistedBrowserStateRef): Promise<AutomationConnection> {
    return this.createAutomationConnection(await this.ensureBrowser());
  }

  async makeReadOnly(sessionId: string): Promise<void> {
    this.require(sessionId);
  }

  async terminateSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.status = 'TERMINATED';
    this.sessions.delete(sessionId);
  }

  async deletePersistedState(_stateRef: PersistedBrowserStateRef): Promise<void> {
    /* This test double has no durable provider resource. */
  }

  /** Test helper: close the shared browser. */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.contexts].map((context) => this.closeContext(context)));
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }

  private createAutomationConnection(browser: Browser): AutomationConnection {
    const ownedContexts = new Set<BrowserContext>();
    return {
      baseUrl: this.opts.fixturesBaseUrl,
      newPage: async () => {
        const context = await browser.newContext();
        ownedContexts.add(context);
        this.contexts.add(context);
        try {
          return await preparePageForEvaluate(await context.newPage());
        } catch (error) {
          ownedContexts.delete(context);
          await this.closeContext(context);
          throw error;
        }
      },
      close: async () => {
        const contexts = [...ownedContexts];
        ownedContexts.clear();
        await Promise.allSettled(contexts.map((context) => this.closeContext(context)));
      },
    };
  }

  private async closeContext(context: BrowserContext): Promise<void> {
    this.contexts.delete(context);
    await context.close().catch(() => undefined);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) this.browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    return this.browser;
  }

  private require(sessionId: string): TestSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new BrowserLinkUnavailableError('steel', `Unknown test session ${sessionId}`);
    return s;
  }
}
