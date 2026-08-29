import { id } from '@sentinel/core';
import {
  type AuditLogger,
  isProductionEnvironment,
} from '@sentinel/security';
import {
  CONSENT_DISCLOSURE_VERSION,
  CONSENT_PURPOSE,
  CONSENT_RETENTION_DAYS,
  type ConsentRevocationActor,
  type ConsentRevocationIntent,
  type ConsentRevocationWrite,
  type DistributorLinkRepository,
  type LinkConsent,
  type TenantContext,
} from '@sentinel/db';

export type ConsentRevocationTerminator = (
  ctx: TenantContext,
  consentId: string,
) => Promise<number>;

export interface ConsentRevocationReconciliation {
  claimed: number;
  completed: number;
  retried: number;
  stale: number;
  sessionsTerminated: number;
}

export interface ConsentRevocationStatus extends ConsentRevocationReconciliation {
  cleanupPending: boolean;
}

export const CONSENT_REVOCATION_LEASE_MS = 30_000;
const CONSENT_REVOCATION_RETRY_BASE_MS = 1_000;
const CONSENT_REVOCATION_RETRY_MAX_MS = 5 * 60_000;

/** Consent must remain valid for the entire immutable Steel lease plus terminal cleanup. */
export const CONSENT_LEASE_GRACE_MS = 5 * 60_000;

export function requiredConsentRemainingMs(env: NodeJS.ProcessEnv): number {
  const configuredLease = Number(env.STEEL_SESSION_TIMEOUT_MS);
  const leaseMs = Number.isSafeInteger(configuredLease) && configuredLease > 0
    ? configuredLease
    : Math.max(1, Number(env.BROWSER_SESSION_TTL_MINUTES) || 20) * 60_000;
  return leaseMs + CONSENT_LEASE_GRACE_MS;
}

/**
 * Tenant-scoped consent authority for the attended Steel connect flow. Browser
 * sessions and catalogue execution are owned by DistributorConnect and the worker;
 * this service persists only grants and their durable revocation outbox.
 */
export class DistributorLinkService {
  private readonly repo: DistributorLinkRepository;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly audit: AuditLogger,
    opts: {
      repo: DistributorLinkRepository;
      env?: NodeJS.ProcessEnv;
    },
  ) {
    const env = opts.env ?? process.env;
    this.env = env;
    this.repo = opts.repo;
  }

  /** Release repository resources. */
  async close(): Promise<void> {
    await this.repo.close();
  }

  async grantConsent(ctx: TenantContext, input: { distributor: string; scope?: string; ttlMinutes?: number; provider?: 'steel'; actorUserId?: string }): Promise<LinkConsent> {
    const requestedTtl = Number.isFinite(input.ttlMinutes) && (input.ttlMinutes ?? 0) > 0
      ? Math.ceil(input.ttlMinutes!)
      : undefined;
    const leaseBoundTtl = Math.ceil(requiredConsentRemainingMs(this.env) / 60_000);
    // A production caller cannot create a consent that will expire while the immutable Steel
    // lease is still running. Development/tests may request a deliberately short TTL to exercise
    // expiry behavior; the default remains lease-safe everywhere.
    const ttlMinutes = isProductionEnvironment(this.env)
      ? Math.max(60, leaseBoundTtl, requestedTtl ?? 0)
      : requestedTtl ?? Math.max(60, leaseBoundTtl);
    const actorUserId = input.actorUserId?.trim() || 'anonymous';
    if (isProductionEnvironment(this.env) && actorUserId === 'anonymous') {
      throw new Error('Authenticated actor identity is required to grant production consent.');
    }
    const rec: LinkConsent = {
      id: id('consent'),
      tenantId: ctx.tenantId,
      grantedByUserId: actorUserId,
      grantedAt: new Date().toISOString(),
      purpose: CONSENT_PURPOSE,
      disclosureVersion: CONSENT_DISCLOSURE_VERSION,
      retentionDays: CONSENT_RETENTION_DAYS,
      distributor: input.distributor,
      scope: input.scope ?? 'distributor:read-catalog',
      provider: input.provider ?? 'steel',
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      revokedAt: null,
    };
    await this.repo.consents.put(ctx, rec);
    await this.audit.log({ tenantId: ctx.tenantId, actorUserId, action: 'consent.granted', targetType: 'ConsentGrant', targetId: rec.id, metadata: { scope: rec.scope, distributor: input.distributor, disclosureVersion: rec.disclosureVersion, retentionDays: rec.retentionDays } });
    return rec;
  }

  /**
   * Atomically revoke durable authority and create the cleanup outbox row. The caller may crash
   * immediately after this method returns; a later replica can still lease and finish cleanup.
   */
  async requestConsentRevocation(
    ctx: TenantContext,
    consentId: string,
    actor: ConsentRevocationActor,
  ): Promise<ConsentRevocationWrite | null> {
    const write = await this.repo.revokeConsentAndCreateIntent(ctx, consentId, new Date().toISOString(), actor);
    if (!write) return null;
    try {
      await this.audit.log({ tenantId: ctx.tenantId, actorUserId: actor.actorUserId, action: 'consent.revoked', targetType: 'ConsentGrant', targetId: consentId, metadata: { cleanupIntentId: write.intent.id, tenantAdminOverride: actor.allowTenantAdmin && write.consent.grantedByUserId !== actor.actorUserId } });
    } catch (err) {
      // Revocation is a safety control. Once durable consent is revoked, an audit sink outage
      // must not prevent the caller from continuing to terminate the live Steel session.
      console.error('[distributor-link] consent revocation audit persistence failed', {
        errorType: err instanceof Error ? err.name : 'Error',
      });
    }
    return write;
  }

  /** Backwards-compatible boolean facade used by older call sites/tests. */
  async revokeConsent(ctx: TenantContext, consentId: string, actor: ConsentRevocationActor): Promise<boolean> {
    return Boolean(await this.requestConsentRevocation(ctx, consentId, actor));
  }

  /**
   * Lease and reconcile due cleanup intents. Completion/retry is compare-and-set by lease token,
   * so another replica can safely reclaim expired work without a stale worker acknowledging it.
   */
  async reconcileConsentRevocations(
    terminate: ConsentRevocationTerminator,
    options: { limit?: number; intentId?: string; now?: Date; leaseMs?: number } = {},
  ): Promise<ConsentRevocationReconciliation> {
    const now = options.now ?? new Date();
    const maxClaims = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const leaseMs = Math.max(1, options.leaseMs ?? CONSENT_REVOCATION_LEASE_MS);
    const result: ConsentRevocationReconciliation = {
      claimed: 0,
      completed: 0,
      retried: 0,
      stale: 0,
      sessionsTerminated: 0,
    };
    // Claim on demand instead of leasing a whole batch before sequential Steel calls. A later
    // item must not spend its entire visibility window waiting behind slow releases and then be
    // reclaimed by another replica before its first attempt even starts.
    for (let index = 0; index < maxClaims; index += 1) {
      const [intent] = await this.repo.claimConsentRevocationIntents({
        now: now.toISOString(),
        leaseMs,
        limit: 1,
        ...(options.intentId ? { intentId: options.intentId } : {}),
      });
      if (!intent) break;
      result.claimed += 1;
      try {
        const terminated = await terminate({ tenantId: intent.tenantId }, intent.consentId);
        const completedAt = new Date().toISOString();
        const accepted = await this.repo.completeConsentRevocationIntent(
          intent.id,
          intent.leaseToken,
          completedAt,
        );
        if (accepted) {
          result.completed += 1;
          result.sessionsTerminated += terminated;
        } else {
          // The lease was reclaimed while this worker was terminating the external session.
          // Cancellation is idempotent, so the current owner may safely repeat it.
          result.stale += 1;
        }
      } catch (err) {
        const exponent = Math.max(0, Math.min(8, intent.attempts - 1));
        const delayMs = Math.min(CONSENT_REVOCATION_RETRY_MAX_MS, CONSENT_REVOCATION_RETRY_BASE_MS * (2 ** exponent));
        // Provider errors can embed remote session ids, signed viewer URLs, or upstream response
        // bodies. The durable row records only a fixed operational category; detailed diagnostics
        // belong in the already-redacted application telemetry path.
        const message = 'consent_authority_cleanup_failed';
        const accepted = await this.repo.retryConsentRevocationIntent(
          intent.id,
          intent.leaseToken,
          delayMs,
          message,
        );
        if (accepted) result.retried += 1;
        else result.stale += 1;
      }
      // A targeted HTTP reconciliation owns only this exact outbox row. Never spin and reclaim it
      // in the same request if an adapter uses a zero-delay retry policy.
      if (options.intentId) break;
    }
    return result;
  }

  /** Immediate, best-effort reconciliation for the HTTP request that created an intent. */
  async reconcileConsentRevocation(
    ctx: TenantContext,
    consentId: string,
    intent: ConsentRevocationIntent,
    terminate: ConsentRevocationTerminator,
  ): Promise<ConsentRevocationStatus> {
    const result = intent.completedAt
      ? { claimed: 0, completed: 0, retried: 0, stale: 0, sessionsTerminated: 0 }
      : await this.reconcileConsentRevocations(terminate, { limit: 1, intentId: intent.id });
    const current = await this.repo.getConsentRevocationIntent(ctx, consentId);
    return { ...result, cleanupPending: !current?.completedAt };
  }

  /** Validate the grant used by the active Steel connect flow before opening any browser. */
  async assertReadConsent(
    ctx: TenantContext,
    consentId: string,
    expected: { distributor: string; provider: string; actorUserId: string; minimumRemainingMs?: number },
  ): Promise<LinkConsent> {
    const c = await this.repo.consents.get(ctx, consentId);
    const minimumExpiry = Date.now() + Math.max(0, expected.minimumRemainingMs ?? 0);
    const proofValid = !isProductionEnvironment(this.env) || Boolean(
      c?.grantedByUserId && c.grantedAt && c.purpose === CONSENT_PURPOSE
      && c.disclosureVersion === CONSENT_DISCLOSURE_VERSION
      && c.retentionDays === CONSENT_RETENTION_DAYS,
    );
    // Per-user isolation: the grant is bound to the exact granting subject. There is no workspace.
    const valid = Boolean(
      c && !c.revokedAt && new Date(c.expiresAt).getTime() >= minimumExpiry &&
      c.scope === 'distributor:read-catalog' &&
      c.distributor === expected.distributor && c.provider === expected.provider &&
      c.grantedByUserId === expected.actorUserId && proofValid,
    );
    if (!valid) throw new Error('active read-only consent is not bound to this Steel connection');
    return c!;
  }

}
