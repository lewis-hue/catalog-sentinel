/**
 * Steel Browser connector-mode resolution + health probing.
 *
 * Steel is the attended cloud browser users log into their distributor inside. It runs
 * fine on native Linux (AWS/GCP/EC2) but a self-hosted Chromium may not launch under
 * Windows/WSL2/Docker Desktop. The connector has three real modes:
 *
 *   STEEL_CONNECTOR_MODE = cloud        → Steel's hosted cloud (steel.dev) via STEEL_API_KEY.
 *                                         Runs an isolated managed browser from every
 *                                         supported development host.
 *                        = external     → connect to a REMOTE Linux Steel via STEEL_API_URL
 *                                         (e.g. an SSH tunnel to a Linux host).
 *                        = self_hosted  → Steel runs as a PRIVATE service alongside the app
 *                                         on Linux (compose / K8s / ECS), via STEEL_API_URL.
 *
 *   STEEL_REQUIRED = false → app starts even if Steel is unavailable (login degrades).
 *                  = true  → readiness FAILS if Steel is not READY (production gate).
 *
 * This module NEVER throws and NEVER returns secrets (the API URL is host-only redacted).
 */
import { readFileSync } from 'node:fs';

export type SteelConnectorMode = 'cloud' | 'external' | 'self_hosted';

export type SteelStatusCode =
  | 'READY' // Steel reachable → real live login available
  | 'DISABLED' // Steel intentionally off
  | 'UNREACHABLE' // configured but the API can't be reached
  | 'UNSUPPORTED_LOCAL_ENV' // self_hosted on Windows/WSL2, Chromium can't launch here
  | 'MISCONFIGURED'; // cloud without STEEL_API_KEY, or external/self_hosted without STEEL_API_URL

/** How distributor login behaves given the current Steel status. */
export type LoginMode = 'steel' | 'disabled';

export interface SteelHealth {
  status: SteelStatusCode;
  mode: SteelConnectorMode;
  required: boolean;
  /** True only when a real Steel instance is reachable and usable right now. */
  liveLoginAvailable: boolean;
  /** What the Connect flow will actually use. */
  loginMode: LoginMode;
  /** Whether this process is running under Windows/WSL2 (Steel's Chromium can't launch). */
  wsl2: boolean;
  /** Host-only, credential-stripped API URL (never the raw value). */
  apiUrl: string | null;
  /** Safe, human-readable status message for the UI/logs. */
  message: string;
  checkedAt: string;
}

const WSL2_MESSAGE =
  'Self-hosted Steel is unavailable in this Windows/WSL2 environment. Use Steel cloud or connect to a remote Linux Steel instance.';

const TRUTHY = /^(1|true|yes|on)$/i;

export interface EnvLike {
  STEEL_CONNECTOR_MODE?: string;
  STEEL_API_URL?: string;
  STEEL_API_KEY?: string;
  STEEL_REQUIRED?: string;
  STEEL_HEALTH_PATH?: string;
  [k: string]: string | undefined;
}

/** Steel's hosted cloud API base (used when cloud mode leaves STEEL_API_URL unset). */
export const STEEL_CLOUD_BASE = 'https://api.steel.dev';

/** Cloud credentials may only be sent to an absolute HTTPS URL without URL credentials. */
export function isSafeSteelCloudApiUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Resolve the connector mode. Explicit STEEL_CONNECTOR_MODE wins; otherwise infer from the
 * env (STEEL_API_KEY → cloud, STEEL_API_URL → external), otherwise cloud so missing
 * credentials are surfaced as MISCONFIGURED rather than selecting a substitute provider.
 */
export function resolveSteelMode(env: EnvLike): SteelConnectorMode {
  const raw = (env.STEEL_CONNECTOR_MODE ?? '').trim().toLowerCase();
  if (raw === 'cloud' || raw === 'external' || raw === 'self_hosted') return raw;
  if (env.STEEL_API_KEY && env.STEEL_API_KEY.trim()) return 'cloud';
  return env.STEEL_API_URL && env.STEEL_API_URL.trim() ? 'external' : 'cloud';
}

export function isSteelRequired(env: EnvLike): boolean {
  return TRUTHY.test((env.STEEL_REQUIRED ?? '').trim());
}

/** Detect Windows/WSL2 from the kernel string in /proc/version. Never throws. */
export function detectWsl2(readProcVersion: () => string = defaultReadProcVersion): boolean {
  try {
    return /microsoft|wsl/i.test(readProcVersion());
  } catch {
    return false;
  }
}

function defaultReadProcVersion(): string {
  // /proc/version only exists on Linux; on other platforms this throws and detectWsl2
  // catches it → false. (Consumed only by the Node API/worker/scripts, never the browser.)
  return readFileSync('/proc/version', 'utf8');
}

/** Strip any credentials + path/query from an API URL, leaving scheme://host:port. */
export function redactUrl(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    // Not a full URL, strip anything after the host-ish token, never echo raw creds.
    return url.replace(/:\/\/[^@/\s]+@/, '://***@').split(/[/?#]/)[0] ?? null;
  }
}

export interface ProbeDeps {
  fetchImpl?: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{
    ok: boolean;
    status: number;
    /** Native fetch bodies must be consumed or cancelled so one-shot probes can exit cleanly. */
    body?: { cancel(): Promise<void> } | null;
  }>;
  readProcVersion?: () => string;
  now?: () => string;
  timeoutMs?: number;
}

/**
 * Capability probe of the Steel API. A dependency is ready only when it returns 2xx;
 * authentication errors and missing endpoints must never be promoted to READY.
 */
async function probeReachable(
  baseUrl: string,
  healthPath: string,
  deps: ProbeDeps,
  headers?: Record<string, string>,
): Promise<boolean> {
  const fetchImpl: NonNullable<ProbeDeps['fetchImpl']> = deps.fetchImpl ?? ((u, init) =>
    fetch(u, init as RequestInit));
  const url = `${baseUrl.replace(/\/$/, '')}${healthPath}`;
  const controller = new AbortController();
  const configuredTimeoutMs = deps.timeoutMs;
  const timeoutMs = configuredTimeoutMs !== undefined && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 4000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;
  try {
    // Promise.race keeps this function bounded even when an injected/non-standard fetch
    // implementation ignores AbortSignal. Native fetch also receives the abort so its socket
    // can be cancelled rather than left running in the background.
    const timedOut = Symbol('steel-health-timeout');
    const timeoutResult = new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => {
        didTimeOut = true;
        controller.abort();
        resolve(timedOut);
      }, timeoutMs);
    });
    const fetchResult = fetchImpl(url, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      signal: controller.signal,
    }).then(async (response) => {
      // An injected fetch is allowed to ignore AbortSignal. If it resolves after the timeout,
      // close its body here as well instead of leaving an unread socket behind.
      if (didTimeOut) await response.body?.cancel().catch(() => undefined);
      return response;
    });
    const response = await Promise.race([
      fetchResult,
      timeoutResult,
    ]);
    if (response === timedOut) return false;
    const reachable = response.status >= 200 && response.status < 300;
    // The Sessions capability endpoint can have a JSON payload. Health only needs the status;
    // explicitly cancel the stream so undici/Node can release the connection deterministically.
    await response.body?.cancel().catch(() => undefined);
    return reachable;
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Resolve Steel status for the given env. Pure w.r.t. injected deps (testable). Returns a
 * safe status object suitable for `/api/integrations/steel/status` and `/health/dependencies`.
 */
export async function probeSteelHealth(env: EnvLike, deps: ProbeDeps = {}): Promise<SteelHealth> {
  const mode = resolveSteelMode(env);
  const required = isSteelRequired(env);
  const wsl2 = detectWsl2(deps.readProcVersion);
  const apiUrl = redactUrl(env.STEEL_API_URL);
  const checkedAt = deps.now ? deps.now() : new Date().toISOString();
  const base = { mode, required, wsl2, apiUrl, checkedAt };
  const requestedMode = (env.STEEL_CONNECTOR_MODE ?? '').trim().toLowerCase();
  if (requestedMode && !['cloud', 'external', 'self_hosted'].includes(requestedMode)) {
    return {
      ...base,
      status: 'MISCONFIGURED',
      liveLoginAvailable: false,
      loginMode: 'disabled',
      message: 'STEEL_CONNECTOR_MODE must be cloud, external, or self_hosted.',
    };
  }

  // cloud, Steel's hosted service (steel.dev). Needs an API key, not an API URL; runs on
  // Steel's infra so it is NOT affected by the local WSL2 Chromium limitation.
  if (mode === 'cloud') {
    const cloudBase = env.STEEL_API_URL && env.STEEL_API_URL.trim() ? env.STEEL_API_URL.trim() : STEEL_CLOUD_BASE;
    const cloudApiUrl = redactUrl(cloudBase);
    if (!isSafeSteelCloudApiUrl(cloudBase)) {
      return {
        ...base,
        apiUrl: cloudApiUrl,
        status: 'MISCONFIGURED',
        liveLoginAvailable: false,
        loginMode: 'disabled',
        message: 'Steel cloud API URL must be an absolute HTTPS URL without embedded credentials.',
      };
    }
    if (!env.STEEL_API_KEY || !env.STEEL_API_KEY.trim()) {
      return {
        ...base,
        apiUrl: cloudApiUrl,
        status: 'MISCONFIGURED',
        liveLoginAvailable: false,
        loginMode: 'disabled',
        message: 'Steel cloud mode requires STEEL_API_KEY. Create one at https://steel.dev and set it in your environment.',
      };
    }
    // Steel's cloud health endpoint is not an authorization check. Probe the authenticated
    // Sessions API instead so an invalid/revoked key (401/403) fails readiness. Do not allow a
    // generic health-path override in cloud mode: a public 2xx health endpoint would recreate
    // the exact false-positive this authenticated capability probe is meant to prevent.
    const reachable = await probeReachable(
      cloudBase,
      '/v1/sessions',
      deps,
      { 'steel-api-key': env.STEEL_API_KEY.trim() },
    );
    if (!reachable) {
      return {
        ...base,
        apiUrl: cloudApiUrl,
        status: 'UNREACHABLE',
        liveLoginAvailable: false,
        loginMode: 'disabled',
        message: `Could not authenticate with or reach Steel cloud at ${cloudApiUrl}. Check STEEL_API_KEY and network egress from this service.`,
      };
    }
    return {
      ...base,
      apiUrl: cloudApiUrl,
      status: 'READY',
      liveLoginAvailable: true,
      loginMode: 'steel',
      message: `Steel cloud is ready (${cloudApiUrl}). Distributor live login runs in an isolated managed browser.`,
    };
  }

  // external / self_hosted both need an API URL.
  if (!env.STEEL_API_URL || !env.STEEL_API_URL.trim()) {
    return {
      ...base,
      status: 'MISCONFIGURED',
      liveLoginAvailable: false,
      loginMode: 'disabled',
      message: `Steel mode "${mode}" requires STEEL_API_URL. Point it at your Steel instance (e.g. http://host.docker.internal:3900 for a tunnelled remote Linux Steel, or http://steel:3000 for a private compose service).`,
    };
  }

  // self_hosted local Steel cannot run on Windows/WSL2 (Chromium won't launch).
  if (mode === 'self_hosted' && wsl2) {
    return {
      ...base,
      status: 'UNSUPPORTED_LOCAL_ENV',
      liveLoginAvailable: false,
      loginMode: 'disabled',
      message: WSL2_MESSAGE,
    };
  }

  const reachable = await probeReachable(env.STEEL_API_URL, env.STEEL_HEALTH_PATH ?? '/v1/health', deps);
  if (!reachable) {
    return {
      ...base,
      status: 'UNREACHABLE',
      liveLoginAvailable: false,
      loginMode: 'disabled',
      message: `Could not reach the Steel instance at ${apiUrl}. Check that it is running and reachable from this service.`,
    };
  }

  return {
    ...base,
    status: 'READY',
    liveLoginAvailable: true,
    loginMode: 'steel',
    message: `Steel is ready (${mode} at ${apiUrl}). Distributor live login is available.`,
  };
}
