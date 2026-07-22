import { randomUUID } from 'node:crypto';
import { InMemoryTenantStore, type TenantContext, type TenantEntity, type TenantStore } from './tenant-repo';

// Tenant-owned entities for the Secure Distributor Link feature.

export const CONSENT_DISCLOSURE_VERSION = 'distrokid-read-catalog-2026-07-22.v1';
export const CONSENT_PURPOSE = 'Read authorized DistroKid catalog metadata and verify store presence.';
export const CONSENT_RETENTION_DAYS = 30;

export interface LinkConsent extends TenantEntity {
  artistWorkspaceId: string;
  /** Proof fields are optional only on legacy rows; production refuses to reuse rows lacking them. */
  grantedByUserId?: string;
  grantedAt?: string;
  purpose?: string;
  disclosureVersion?: string;
  retentionDays?: number;
  /** Distributor this grant is bound to. Optional only for legacy rows, which are not reusable. */
  distributor?: string;
  scope: string;
  provider: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface LinkSession extends TenantEntity {
  /** Optional only for legacy rows; interactive use fails closed without it. */
  ownerUserId?: string;
  artistWorkspaceId: string;
  distributor: string;
  provider: string;
  status: string;
  expiresAt: string;
  /** Envelope-encrypted, backend-only. Never returned to the frontend. */
  providerSessionRef: string;
  consentId: string;
}
export interface LinkStateRef extends TenantEntity {
  kind: string;
  encryptedRef: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface LinkConnection extends TenantEntity {
  /** Optional only for legacy rows; interactive use fails closed without it. */
  ownerUserId?: string;
  artistWorkspaceId: string;
  distributor: string;
  status: string;
  connectionMode: string;
  browserStateRefId: string | null;
  revokedAt: string | null;
}
export interface LinkDeepScan extends TenantEntity {
  /** Optional only for legacy rows; interactive reads fail closed without it. */
  ownerUserId?: string;
  artistWorkspaceId: string;
  distributorConnectionId: string;
  /** Consent this scan runs under. Persisted so a cross-process worker can reload
   *  the full run context (consent gate) from just the scan id. */
  consentId: string;
  status: string;
  progressPercent: number;
  currentStep: string;
  releasesFound: number;
  tracksFound: number;
  warningsCount: number;
  events: unknown[];
  snapshotId: string | null;
  issues: unknown[];
  snapshot: unknown | null;
}

/**
 * Durable outbox row created in the SAME database statement that revokes a
 * consent. Keeping the cleanup request beside the consent closes the crash
 * window between "consent is revoked" and "the Steel session was released".
 */
export interface ConsentRevocationIntent extends TenantEntity {
  consentId: string;
  artistWorkspaceId: string;
  attempts: number;
  availableAt: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedConsentRevocationIntent extends ConsentRevocationIntent {
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface ConsentRevocationWrite {
  consent: LinkConsent;
  intent: ConsentRevocationIntent;
}

/** Server-derived authorization for a consent revocation. Never construct this from JSON. */
export interface ConsentRevocationActor {
  actorUserId: string;
  /** Tenant administrators may revoke another user's grant as an emergency safety action. */
  allowTenantAdmin: boolean;
}

export interface ClaimConsentRevocationOptions {
  now: string;
  leaseMs: number;
  limit: number;
  /** Restrict a synchronous, best-effort reconciliation to the just-created intent. */
  intentId?: string;
}

/**
 * Tenant-scoped persistence port for the distributor-link feature. The API
 * depends only on this interface; PostgreSQL powers runtime use and the
 * process-local implementation is restricted to isolated automated tests.
 */
export interface DistributorLinkRepository {
  consents: TenantStore<LinkConsent>;
  sessions: TenantStore<LinkSession>;
  stateRefs: TenantStore<LinkStateRef>;
  connections: TenantStore<LinkConnection>;
  scans: TenantStore<LinkDeepScan>;
  /** Atomically revoke the consent and persist its Steel-cleanup outbox row. */
  revokeConsentAndCreateIntent(
    ctx: TenantContext,
    consentId: string,
    revokedAt: string,
    actor: ConsentRevocationActor,
  ): Promise<ConsentRevocationWrite | null>;
  getConsentRevocationIntent(ctx: TenantContext, consentId: string): Promise<ConsentRevocationIntent | null>;
  /** Lease due work. The Postgres implementation uses FOR UPDATE SKIP LOCKED. */
  claimConsentRevocationIntents(options: ClaimConsentRevocationOptions): Promise<ClaimedConsentRevocationIntent[]>;
  /** Token-checked compare-and-set; a stale/reclaimed worker cannot acknowledge work. */
  completeConsentRevocationIntent(intentId: string, leaseToken: string, completedAt: string): Promise<boolean>;
  /** Token-checked compare-and-set that makes failed work eligible after a relative delay. */
  retryConsentRevocationIntent(intentId: string, leaseToken: string, retryAfterMs: number, lastError: string): Promise<boolean>;
  deleteTenant(tenantId: string): Promise<void>;
  close(): Promise<void>;
}

/** Process-local repository for isolated automated tests only. @internal */
export class InMemoryDistributorLinkRepository implements DistributorLinkRepository {
  consents = new InMemoryTenantStore<LinkConsent>();
  sessions = new InMemoryTenantStore<LinkSession>();
  stateRefs = new InMemoryTenantStore<LinkStateRef>();
  connections = new InMemoryTenantStore<LinkConnection>();
  scans = new InMemoryTenantStore<LinkDeepScan>();
  private readonly revocationIntents = new Map<string, ConsentRevocationIntent>();
  private mutationTail: Promise<void> = Promise.resolve();

  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async revokeConsentAndCreateIntent(
    ctx: TenantContext,
    consentId: string,
    revokedAt: string,
    actor: ConsentRevocationActor,
  ): Promise<ConsentRevocationWrite | null> {
    return this.exclusively(async () => {
      const consent = await this.consents.get(ctx, consentId);
      if (!consent) return null;
      // Legacy grants without a subject are deliberately admin-only. Returning the same null as
      // a missing row prevents this repository boundary becoming a same-tenant ownership oracle.
      if (!actor.allowTenantAdmin && consent.grantedByUserId !== actor.actorUserId) return null;
      const revoked = await this.consents.update(ctx, consentId, { revokedAt: consent.revokedAt ?? revokedAt });
      if (!revoked) return null;
      const existing = [...this.revocationIntents.values()].find(
        (intent) => intent.tenantId === ctx.tenantId && intent.consentId === consentId,
      );
      const intent: ConsentRevocationIntent = existing ?? {
        id: `consent-revoke-${randomUUID()}`,
        tenantId: ctx.tenantId,
        consentId,
        artistWorkspaceId: consent.artistWorkspaceId,
        attempts: 0,
        availableAt: revokedAt,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: null,
        createdAt: revokedAt,
        updatedAt: revokedAt,
      };
      if (!existing) this.revocationIntents.set(intent.id, intent);
      return { consent: structuredClone(revoked), intent: structuredClone(intent) };
    });
  }

  async getConsentRevocationIntent(ctx: TenantContext, consentId: string): Promise<ConsentRevocationIntent | null> {
    const found = [...this.revocationIntents.values()].find(
      (intent) => intent.tenantId === ctx.tenantId && intent.consentId === consentId,
    );
    return found ? structuredClone(found) : null;
  }

  async claimConsentRevocationIntents(options: ClaimConsentRevocationOptions): Promise<ClaimedConsentRevocationIntent[]> {
    return this.exclusively(async () => {
      const nowMs = Date.parse(options.now);
      const leaseMs = Math.max(1, options.leaseMs);
      const limit = Math.max(0, Math.floor(options.limit));
      const due = [...this.revocationIntents.values()]
        .filter((intent) => (
          !intent.completedAt
          && Date.parse(intent.availableAt) <= nowMs
          && (!intent.leaseExpiresAt || Date.parse(intent.leaseExpiresAt) <= nowMs)
          && (!options.intentId || intent.id === options.intentId)
        ))
        .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
      return due.map((intent) => {
        intent.leaseToken = randomUUID();
        intent.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
        intent.attempts += 1;
        intent.updatedAt = options.now;
        this.revocationIntents.set(intent.id, intent);
        return structuredClone(intent) as ClaimedConsentRevocationIntent;
      });
    });
  }

  async completeConsentRevocationIntent(intentId: string, leaseToken: string, completedAt: string): Promise<boolean> {
    return this.exclusively(async () => {
      const intent = this.revocationIntents.get(intentId);
      if (!intent || intent.completedAt || intent.leaseToken !== leaseToken) return false;
      intent.completedAt = completedAt;
      intent.leaseToken = null;
      intent.leaseExpiresAt = null;
      intent.lastError = null;
      intent.updatedAt = completedAt;
      this.revocationIntents.set(intentId, intent);
      return true;
    });
  }

  async retryConsentRevocationIntent(intentId: string, leaseToken: string, retryAfterMs: number, lastError: string): Promise<boolean> {
    return this.exclusively(async () => {
      const intent = this.revocationIntents.get(intentId);
      if (!intent || intent.completedAt || intent.leaseToken !== leaseToken) return false;
      intent.availableAt = new Date(Date.now() + Math.max(0, retryAfterMs)).toISOString();
      intent.leaseToken = null;
      intent.leaseExpiresAt = null;
      intent.lastError = lastError;
      intent.updatedAt = new Date().toISOString();
      this.revocationIntents.set(intentId, intent);
      return true;
    });
  }

  async deleteTenant(tenantId: string): Promise<void> {
    await this.consents.deleteAllForTenant(tenantId);
    await this.sessions.deleteAllForTenant(tenantId);
    await this.stateRefs.deleteAllForTenant(tenantId);
    await this.connections.deleteAllForTenant(tenantId);
    await this.scans.deleteAllForTenant(tenantId);
    for (const [id, intent] of this.revocationIntents) {
      if (intent.tenantId === tenantId) this.revocationIntents.delete(id);
    }
  }

  async close(): Promise<void> {}
}

export type { TenantContext };
