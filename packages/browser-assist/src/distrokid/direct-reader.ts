import type { Page } from 'playwright';
import { isInspectableUrl } from './redaction';

/**
 * Direct authenticated JSON reader — a GATED optimization, OFF by default.
 *
 * Passive capture (observing the JSON the dashboard itself fetches during normal navigation) is
 * the default and is already sufficient to fix the render-timing problem. Calling an
 * undocumented endpoint directly is a different act with different obligations, so it requires
 * BOTH a feature flag and a recorded legal review, and it refuses to run otherwise.
 *
 * Constraints enforced here:
 *  - both flags must be true;
 *  - the URL must be same-origin to the distributor and not a sensitive route;
 *  - only release ids DISCOVERED from the connected user's own catalog may be requested
 *    (callers pass `allowedReleaseIds`) — never enumerate other users' ids;
 *  - a minimum delay between requests (rate-limit preservation);
 *  - stop immediately on reauth/CAPTCHA/forbidden/rate-limit.
 */

export interface DirectReaderFlags {
  enabled: boolean;
  legalApproved: boolean;
  minDelayMs: number;
}

export function readDirectReaderFlags(env: NodeJS.ProcessEnv): DirectReaderFlags {
  const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v ?? '');
  return {
    enabled: truthy(env.ENABLE_DISTROKID_DIRECT_JSON_READER),
    legalApproved: truthy(env.LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED),
    minDelayMs: Number(env.DISTROKID_REQUEST_MIN_DELAY_MS) || 750,
  };
}

/** Direct reading is permitted ONLY when the feature flag AND the legal review flag are set. */
export function isDirectReaderAllowed(flags: DirectReaderFlags): boolean {
  return flags.enabled && flags.legalApproved;
}

export type DirectReadOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'DISABLED' | 'NOT_AUTHORIZED' | 'REAUTH_REQUIRED' | 'RATE_LIMITED' | 'REQUEST_FAILED' | 'FORBIDDEN_URL' | 'NOT_OWNED'; detail: string };

export class DirectJsonReader {
  private lastRequestAt = 0;
  private halted: DirectReadOutcome | null = null;

  constructor(
    private readonly flags: DirectReaderFlags,
    private readonly origin: string,
    /** Release ids discovered from the CONNECTED user's own catalog. Nothing else may be read. */
    private readonly allowedReleaseIds: ReadonlySet<string>,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Once we hit reauth/CAPTCHA/forbidden/rate-limit we stop for the rest of the run. */
  get isHalted(): boolean { return this.halted !== null; }

  async fetchRelease(page: Page, releaseId: string, endpointUrl: string): Promise<DirectReadOutcome> {
    if (!isDirectReaderAllowed(this.flags)) {
      return { ok: false, reason: 'DISABLED', detail: 'direct JSON reader requires ENABLE_DISTROKID_DIRECT_JSON_READER and LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED' };
    }
    if (this.halted) return this.halted;
    if (!this.allowedReleaseIds.has(releaseId)) {
      return { ok: false, reason: 'NOT_OWNED', detail: 'release id was not discovered from the connected account catalog' };
    }
    if (!isInspectableUrl(endpointUrl, this.origin)) {
      return { ok: false, reason: 'FORBIDDEN_URL', detail: 'endpoint is not same-origin or is a sensitive route' };
    }

    // Preserve rate limits.
    const since = this.now() - this.lastRequestAt;
    if (since < this.flags.minDelayMs) await this.sleep(this.flags.minDelayMs - since);
    this.lastRequestAt = this.now();

    try {
      // page.request shares the authenticated context's cookie jar — no session data is copied
      // out of the browser, and we never read or log it.
      const response = await page.request.get(endpointUrl, { failOnStatusCode: false, headers: { accept: 'application/json' }, timeout: 30_000 });
      const status = response.status();
      if (status === 401 || status === 419) { this.halted = { ok: false, reason: 'REAUTH_REQUIRED', detail: `HTTP ${status}` }; return this.halted; }
      if (status === 403) { this.halted = { ok: false, reason: 'NOT_AUTHORIZED', detail: 'HTTP 403 (may be CAPTCHA/bot check)' }; return this.halted; }
      if (status === 429) { this.halted = { ok: false, reason: 'RATE_LIMITED', detail: 'HTTP 429' }; return this.halted; }
      if (!response.ok()) return { ok: false, reason: 'REQUEST_FAILED', detail: `HTTP ${status}` };
      return { ok: true, payload: await response.json() };
    } catch {
      return { ok: false, reason: 'REQUEST_FAILED', detail: 'request error' };
    }
  }
}
