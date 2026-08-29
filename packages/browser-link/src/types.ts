import type { Page } from 'playwright';

/**
 * Attended cloud-browser provider abstraction (spec "Provider abstraction").
 * The user logs into their distributor INSIDE an isolated remote browser session
 * the provider hosts; our backend only ever attaches automation AFTER the user
 * confirms login, and validates authentication using safe, non-sensitive page
 * state. We never receive the raw password.
 */
/** `steel` is the only provider name a live attended-login flow may report. */
export type BrowserLinkProviderName = 'steel';

export const BROWSER_SESSION_STATUSES = [
  'CREATED',
  'READY',
  'USER_ACTIVE',
  'LOGIN_CONFIRMED',
  'VALIDATED',
  'QUEUED_SCAN',
  'EXPIRED',
  'TERMINATED',
  'FAILED',
] as const;
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

export const BROWSER_STATE_KINDS = ['PROVIDER_PROFILE', 'PLAYWRIGHT_STORAGE_STATE', 'REMOTE_SESSION_ID', 'LOCAL_ONLY'] as const;
export type BrowserStateKind = (typeof BROWSER_STATE_KINDS)[number];

export interface CreateBrowserSessionInput {
  tenantId: string;
  artistWorkspaceId: string;
  distributor: string;
  /** Distributor login URL the isolated browser is pointed at. */
  targetLoginUrl: string;
  ttlMinutes: number;
}

export interface CreateBrowserSessionResult {
  sessionId: string;
  status: BrowserSessionStatus;
  expiresAt: string;
  /**
   * Provider-side session identifier, returned to the BACKEND only, to be
   * stored encrypted. NEVER sent to the frontend.
   */
  providerSessionRef: string;
  /** Admin/connect token, backend-only, stored encrypted. Never to the frontend. */
  providerAdminToken?: string;
  providerConnectUrl?: string;
}

export interface BrowserSessionStatusResult {
  sessionId: string;
  status: BrowserSessionStatus;
  expiresAt: string;
  /** Safe, non-sensitive signal only. Never exposes cookies/tokens. */
  loggedInHint: boolean | null;
}

export interface CreateUserAccessInput {
  ttlMinutes: number;
}

export interface UserAccessUrl {
  /** The stream/embed URL shown to the user to log in. Contains no secrets. */
  url: string;
  expiresAt: string;
}

/**
 * A backend automation attachment to the live/persisted browser session. Exposes
 * only what the scanner needs: a way to open pages and the base URL to navigate.
 */
export interface AutomationConnection {
  /** Base URL the scanner should navigate from. */
  baseUrl: string;
  newPage(): Promise<Page>;
  /** Borrowed pipeline attachments close without releasing their remote session. */
  close(): Promise<void>;
}

export interface RemoteAutomationOptions {
  /** Backwards-compatible default is true. Multi-job pipelines pass false. */
  releaseOnClose?: boolean;
}

export interface PersistStateInput {
  kind: BrowserStateKind;
  ttlHours: number;
}

export interface PersistedBrowserStateRef {
  kind: BrowserStateKind;
  /** Encrypted reference blob (envelope-encrypted). Opaque; never plaintext. */
  encryptedRef: string;
  expiresAt: string;
}

export interface BrowserLinkProvider {
  readonly provider: BrowserLinkProviderName;
  createSession(input: CreateBrowserSessionInput): Promise<CreateBrowserSessionResult>;
  getSessionStatus(sessionId: string): Promise<BrowserSessionStatusResult>;
  createUserAccessUrl(sessionId: string, input: CreateUserAccessInput): Promise<UserAccessUrl>;
  attachAutomation(sessionId: string): Promise<AutomationConnection>;
  persistState?(sessionId: string, input: PersistStateInput): Promise<PersistedBrowserStateRef>;
  resumeFromState?(stateRef: PersistedBrowserStateRef): Promise<AutomationConnection>;
  makeReadOnly?(sessionId: string): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
  deletePersistedState?(stateRef: PersistedBrowserStateRef): Promise<void>;
  /** Cloud providers only: the remote session id, for handing a live session to a worker
   *  in another process to attach to (via the concrete provider's attachRemoteSession). */
  getRemoteSessionId?(sessionId: string): Promise<string | null>;
  /** Cloud providers only: drop the local handle WITHOUT releasing the remote session. */
  detachLocalSession?(sessionId: string): Promise<void>;
  /** Attach to an existing remote session; a multi-job pipeline borrows it. */
  attachRemoteSession?(remoteSessionId: string, options?: RemoteAutomationOptions): Promise<AutomationConnection>;
  /** Explicit terminal owner action. */
  releaseRemoteSession?(remoteSessionId: string): Promise<void>;
}

/** Thrown when a provider path exists but isn't usable (no token, disabled). */
export class BrowserLinkUnavailableError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserLinkUnavailableError';
  }
}
