import type {
  EndpointStatus, EndpointRole, RegistryScope,
  DistributorEndpointProfile, EndpointRegistryStore,
} from '@sentinel/contracts';
import type { EndpointIdentity } from './endpoint-fingerprint';
import type { RankedCandidate } from './network-discovery';

/**
 * Endpoint registry.
 *
 * Discovery ranks candidates; the registry is the durable memory of which endpoint we actually
 * use, at which parser version, and whether it is currently healthy. This is what removes the
 * manual "read the logs and hard-code a URL" step: a candidate is promoted automatically once
 * it validates, and demoted automatically when its schema drifts.
 *
 * Lifecycle:
 *   CANDIDATE ──validate──> VALIDATING ──succeeds──> ACTIVE
 *        ▲                                             │ schema drift / repeated failures
 *        └────────────── RETIRED <── DEGRADED <────────┘
 *
 * The types and the store PORT live in `@sentinel/contracts` so the durable Postgres
 * implementation doesn't have to depend on this package (and therefore on Playwright).
 * Re-exported here so existing imports keep working.
 */

export type {
  EndpointStatus, EndpointRole, RegistryScope,
  DistributorEndpointProfile, EndpointRegistryStore,
} from '@sentinel/contracts';

/**
 * In-memory store, tests and single-process runs ONLY.
 *
 * Not durable and not shared: promotions are forgotten on restart, and two API/worker replicas
 * will disagree about which endpoint is ACTIVE. Production uses the Postgres store in
 * `@sentinel/persistence`; the composition root logs loudly when it falls back to this.
 */
export class InMemoryEndpointRegistryStore implements EndpointRegistryStore {
  private readonly rows = new Map<string, DistributorEndpointProfile>();
  private key(tenantId: string, d: string, f: string): string { return `${tenantId}\u0000${d}\u0000${f}`; }
  async get(scope: RegistryScope, fingerprint: string): Promise<DistributorEndpointProfile | null> {
    return this.rows.get(this.key(scope.tenantId, scope.distributor, fingerprint)) ?? null;
  }
  async list(scope: RegistryScope): Promise<DistributorEndpointProfile[]> {
    return [...this.rows.values()].filter((r) => r.distributor === scope.distributor && r.tenantId === scope.tenantId);
  }
  async put(profile: DistributorEndpointProfile): Promise<void> {
    this.rows.set(this.key(profile.tenantId, profile.distributor, profile.fingerprint), profile);
  }
}

/** Promotion thresholds, a candidate must actually work before production relies on it. */
export const VALIDATION_CAPTURES_REQUIRED = 3;
/** Consecutive failures before an ACTIVE endpoint is demoted. */
export const DEGRADE_AFTER_FAILURES = 3;

const nowIso = (): string => new Date().toISOString();

export class EndpointRegistry {
  /**
   * @param scope The tenant + distributor this registry reads and writes. Scope is explicit and
   *   immutable per instance: an ambient "current tenant" would be a cross-tenant bug waiting to
   *   happen, exactly like the mutable "current scan" the candidate sink used to carry. Build one
   *   registry per job over a shared durable store.
   */
  constructor(
    private readonly store: EndpointRegistryStore,
    private readonly scope: RegistryScope,
    private readonly onAlert: (alert: { level: 'warn' | 'error'; code: string; message: string; fingerprint: string }) => void = () => {},
  ) {}

  /** Record a discovery observation, creating/refreshing a CANDIDATE. */
  async observe(candidate: RankedCandidate, role: EndpointRole, parserVersion: string): Promise<DistributorEndpointProfile> {
    const existing = await this.store.get(this.scope, candidate.fingerprint);
    const profile: DistributorEndpointProfile = existing
      ? { ...existing, candidateScore: Math.max(existing.candidateScore, candidate.rank), lastSeenAt: nowIso() }
      : {
          id: `${this.scope.tenantId}:${this.scope.distributor}:${candidate.fingerprint.slice(0, 16)}`,
          tenantId: this.scope.tenantId,
          distributor: this.scope.distributor,
          role,
          fingerprint: candidate.fingerprint,
          method: candidate.identity.method,
          hostPattern: candidate.identity.host,
          pathPattern: candidate.identity.pathPattern,
          queryKeyShape: candidate.identity.queryKeys,
          ...(candidate.identity.graphqlOperationName ? { graphqlOperationName: candidate.identity.graphqlOperationName } : {}),
          schemaHash: candidate.schemaHash,
          // KEY NAMES only, and redaction markers dropped, a masked key is noise, not a key.
          schemaKeys: candidate.schemaKeys.filter((k) => k !== '{redacted}').slice(0, 60),
          parserVersion,
          candidateScore: candidate.rank,
          successfulCaptures: 0,
          failedCaptures: 0,
          schemaDriftCount: 0,
          status: 'CANDIDATE',
          firstSeenAt: nowIso(),
          lastSeenAt: nowIso(),
        };
    await this.store.put(profile);
    return profile;
  }

  /** A capture+parse succeeded. Promotes CANDIDATE→VALIDATING→ACTIVE automatically. */
  async recordSuccess(fingerprint: string, schemaHashSeen: string): Promise<DistributorEndpointProfile | null> {
    const p = await this.store.get(this.scope, fingerprint);
    if (!p) return null;
    const successfulCaptures = p.successfulCaptures + 1;
    let status: EndpointStatus = p.status;
    if (p.status === 'CANDIDATE') status = 'VALIDATING';
    if ((p.status === 'VALIDATING' || p.status === 'DEGRADED') && successfulCaptures >= VALIDATION_CAPTURES_REQUIRED) status = 'ACTIVE';
    const next: DistributorEndpointProfile = {
      ...p, successfulCaptures, failedCaptures: 0, status,
      schemaHash: schemaHashSeen, lastSeenAt: nowIso(),
      ...(status === 'ACTIVE' && !p.approvedAt ? { approvedAt: nowIso() } : {}),
    };
    await this.store.put(next);
    return next;
  }

  /** A capture/parse failed. Demotes to DEGRADED after repeated failures + alerts. */
  async recordFailure(fingerprint: string, reason: string): Promise<DistributorEndpointProfile | null> {
    const p = await this.store.get(this.scope, fingerprint);
    if (!p) return null;
    const failedCaptures = p.failedCaptures + 1;
    const status: EndpointStatus = failedCaptures >= DEGRADE_AFTER_FAILURES && p.status === 'ACTIVE' ? 'DEGRADED' : p.status;
    if (status === 'DEGRADED' && p.status === 'ACTIVE') {
      this.onAlert({ level: 'error', code: 'ENDPOINT_DEGRADED', message: `Endpoint degraded after ${failedCaptures} failures: ${reason}`, fingerprint });
    }
    const next = { ...p, failedCaptures, status, lastSeenAt: nowIso() };
    await this.store.put(next);
    return next;
  }

  /**
   * The response schema changed under an ACTIVE endpoint. We do NOT guess: mark DEGRADED, keep
   * the old parser, and alert. Silent partial data is worse than a loud failure.
   */
  async recordSchemaDrift(fingerprint: string, newSchemaHash: string): Promise<DistributorEndpointProfile | null> {
    const p = await this.store.get(this.scope, fingerprint);
    if (!p) return null;
    if (p.schemaHash === newSchemaHash) return p;
    this.onAlert({
      level: 'error', code: 'SOURCE_SCHEMA_CHANGED',
      message: `Schema drift on ${p.method} ${p.hostPattern}${p.pathPattern} (parser ${p.parserVersion}); endpoint marked DEGRADED`,
      fingerprint,
    });
    // Count the drift durably. It is the metric that tells you whether an endpoint is having a
    // bad day or has genuinely moved, and it is most needed right after the restart that a
    // drift tends to cause, which is exactly when an in-memory counter is gone.
    const next: DistributorEndpointProfile = {
      ...p, status: 'DEGRADED', schemaDriftCount: (p.schemaDriftCount ?? 0) + 1, lastSeenAt: nowIso(),
    };
    await this.store.put(next);
    return next;
  }

  async retire(fingerprint: string): Promise<void> {
    const p = await this.store.get(this.scope, fingerprint);
    if (!p) return;
    await this.store.put({ ...p, status: 'RETIRED', retiredAt: nowIso() });
  }

  /** The endpoint production should use for a role: ACTIVE first, else best VALIDATING/CANDIDATE. */
  async activeFor(role: EndpointRole): Promise<DistributorEndpointProfile | null> {
    const all = (await this.store.list(this.scope)).filter((p) => p.role === role && p.status !== 'RETIRED');
    const rank = (s: EndpointStatus): number => (s === 'ACTIVE' ? 3 : s === 'VALIDATING' ? 2 : s === 'CANDIDATE' ? 1 : 0);
    return all.sort((a, b) => rank(b.status) - rank(a.status) || b.candidateScore - a.candidateScore)[0] ?? null;
  }

  async list(): Promise<DistributorEndpointProfile[]> { return this.store.list(this.scope); }
}

/** Does a response identity match a registered profile? (Shape match, never values.) */
export function matchesProfile(profile: DistributorEndpointProfile, identity: EndpointIdentity): boolean {
  return (
    profile.method === identity.method &&
    profile.hostPattern === identity.host &&
    profile.pathPattern === identity.pathPattern &&
    (profile.graphqlOperationName ?? undefined) === (identity.graphqlOperationName ?? undefined)
  );
}
