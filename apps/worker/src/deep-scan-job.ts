import type { BrowserLinkProvider, PersistedBrowserStateRef } from '@sentinel/browser-link';
import {
  runDistributorDeepScan,
  type DeepScanConfig,
  type DeepScanResult,
  type DistributorScanner,
} from '@sentinel/scanner';

/** Consent must be active for a scan to run (spec: revoked consent blocks scan). */
export interface ConsentSnapshot {
  scope: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** Persisted browser state with revocation, checked before resuming (spec: expired state cannot be used). */
export interface BrowserStateRefRecord extends PersistedBrowserStateRef {
  revokedAt?: string | null;
}

export interface DeepScanJobInput {
  provider: BrowserLinkProvider;
  scanner: DistributorScanner;
  consent: ConsentSnapshot;
  /** Persisted state to resume from; if absent, attaches to a live session id. */
  stateRef?: BrowserStateRefRecord | null;
  sessionId?: string;
  config: DeepScanConfig;
  nowMs?: number;
}

export type DeepScanRunStatus = DeepScanResult['status'] | 'BLOCKED_CONSENT' | 'BLOCKED_STATE_EXPIRED';

export interface DeepScanJobResult {
  status: DeepScanRunStatus;
  result: DeepScanResult | null;
  error?: string;
}

/**
 * The runDistributorDeepScan BullMQ job body. Enforces the security preconditions
 * (active consent, non-expired/non-revoked browser state) BEFORE resuming the
 * browser, then runs the rate-limited, resumable scan via the provider + scanner.
 * Idempotent (resume checkpoint), tenant-scoped (config carries the ids), and
 * observable (progress events flow through config.onEvent).
 */
export async function runDeepScanJob(input: DeepScanJobInput): Promise<DeepScanJobResult> {
  const now = input.nowMs ?? Date.now();

  // 1. Consent gate.
  if (input.consent.revokedAt || new Date(input.consent.expiresAt).getTime() <= now) {
    return { status: 'BLOCKED_CONSENT', result: null, error: 'Consent is revoked or expired; scan blocked.' };
  }

  // 2. Browser-state gate (expired/revoked state cannot be resumed).
  if (input.stateRef) {
    if (input.stateRef.revokedAt || new Date(input.stateRef.expiresAt).getTime() <= now) {
      return { status: 'BLOCKED_STATE_EXPIRED', result: null, error: 'Browser state reference is expired or revoked.' };
    }
  } else if (!input.sessionId) {
    return { status: 'FAILED', result: null, error: 'No browser state ref or live session id provided.' };
  }

  // 3. Resume the browser/session via the provider abstraction.
  let connection;
  try {
    connection =
      input.stateRef && input.provider.resumeFromState
        ? await input.provider.resumeFromState(input.stateRef)
        : await input.provider.attachAutomation(input.sessionId!);
  } catch (err) {
    return { status: 'FAILED', result: null, error: `Could not resume browser session: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 4. Run the scan.
  try {
    const result = await runDistributorDeepScan(input.scanner, connection, input.config);
    return { status: result.status, result };
  } finally {
    await connection.close().catch(() => undefined);
  }
}
