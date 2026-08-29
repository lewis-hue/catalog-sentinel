import type { NetworkCandidate, CandidateSink, CandidateScope } from '@sentinel/browser-assist';

/**
 * Endpoint-candidate registry for the admin API.
 *
 * Discovery must not require an operator to read raw logs after every dashboard change: a scan
 * records ranked, SANITIZED candidates that an admin can inspect through the API.
 *
 * Scoping rules (a shared mutable "current scan" is a correctness bug, not a shortcut):
 *  - every write carries its {tenantId, scanId} EXPLICITLY, so concurrent scans can never
 *    contaminate each other and API replicas stay consistent;
 *  - every read is filtered by tenant AND scan, a tenant can never see another's candidates.
 *
 * What is stored: endpoint SHAPE (method/host/masked path/query KEY names/operationName), schema
 * KEY names, a schema hash, score, sizes, timestamps. What is never stored: cookies, auth
 * headers, tokens, query/POST values, response bodies, or any user/profile/payment data.
 *
 * NOTE: this is the process-local implementation. It is correct for a single API replica and for
 * tests; production should back `CandidateStore` with Postgres (see
 * docs/distrokid-metadata-live-test-report.md §10).
 */

export interface StoredCandidate {
  fingerprint: string;
  descriptor: string;
  method: string;
  host: string;
  pathPattern: string;
  queryKeys: string[];
  graphqlOperationName?: string;
  graphqlVariableKeys?: string[];
  status: number;
  contentType: string;
  score: number;
  schemaKeys: string[];
  schemaHash: string;
  bodyBytes: number;
  observations: number;
  releaseIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface CandidateStore {
  write(candidate: NetworkCandidate, scope: CandidateScope): Promise<void>;
  /** Ranked candidates for ONE tenant's scan. Never returns another tenant's rows. */
  list(tenantId: string, scanId: string): StoredCandidate[];
  clear(tenantId: string, scanId: string): void;
}

const key = (tenantId: string, scanId: string): string => `${tenantId}\u0000${scanId}`;

export class ScanCandidateStore implements CandidateSink, CandidateStore {
  /** (tenant, scan) → fingerprint → candidate. */
  private readonly buckets = new Map<string, Map<string, StoredCandidate>>();
  /** Insertion order of bucket keys, for bounded retention. */
  private readonly order: string[] = [];

  constructor(private readonly maxScans = 50, private readonly maxPerScan = 200) {}

  async write(c: NetworkCandidate, scope: CandidateScope): Promise<void> {
    const k = key(scope.tenantId, scope.scanId);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = new Map<string, StoredCandidate>();
      this.buckets.set(k, bucket);
      this.order.push(k);
      // Retention: drop the OLDEST scan buckets so memory stays bounded.
      while (this.order.length > this.maxScans) {
        const oldest = this.order.shift();
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
    }
    const existing = bucket.get(c.fingerprint);
    // `>=` (not `>`): with `>` the cap admitted one extra record.
    if (!existing && bucket.size >= this.maxPerScan) return;

    bucket.set(c.fingerprint, existing
      ? {
          ...existing,
          score: Math.max(existing.score, c.score),
          observations: existing.observations + 1,
          releaseIds: [...new Set([...existing.releaseIds, ...(c.releaseId ? [c.releaseId] : [])])].slice(0, 10),
          lastSeenAt: c.observedAt,
        }
      : {
          fingerprint: c.fingerprint,
          descriptor: c.descriptor,
          method: c.identity.method,
          host: c.identity.host,
          pathPattern: c.identity.pathPattern,
          queryKeys: c.identity.queryKeys,
          ...(c.identity.graphqlOperationName ? { graphqlOperationName: c.identity.graphqlOperationName } : {}),
          ...(c.graphqlVariableKeys ? { graphqlVariableKeys: c.graphqlVariableKeys } : {}),
          status: c.status,
          contentType: c.contentType,
          score: c.score,
          // Drop any redacted markers before exposing schema keys.
          schemaKeys: c.schemaKeys.filter((k2) => k2 !== '{redacted}').slice(0, 60),
          schemaHash: c.schemaHash,
          bodyBytes: c.bodyBytes,
          observations: 1,
          releaseIds: c.releaseId ? [c.releaseId] : [],
          firstSeenAt: c.observedAt,
          lastSeenAt: c.observedAt,
        });
  }

  list(tenantId: string, scanId: string): StoredCandidate[] {
    return [...(this.buckets.get(key(tenantId, scanId))?.values() ?? [])].sort((a, b) => b.score - a.score);
  }

  clear(tenantId: string, scanId: string): void {
    const k = key(tenantId, scanId);
    this.buckets.delete(k);
    const i = this.order.indexOf(k);
    if (i >= 0) this.order.splice(i, 1);
  }
}
