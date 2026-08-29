/**
 * Endpoint registry + candidate PORTS.
 *
 * These live in contracts, not in the package that uses them, because the durable implementations
 * are backed by Postgres and must not drag a browser (Playwright) into the persistence layer.
 * The consumer (`@sentinel/browser-assist`) and the implementation (`@sentinel/persistence`) both
 * depend on this file and on each other not at all.
 *
 * TENANT SCOPING. An endpoint's shape is technically a property of the distributor, not of a
 * tenant, so a global registry is tempting. It is also a shared mutable surface across tenants:
 * one account whose dashboard serves an unusual payload could promote a bad profile, or degrade a
 * good one, for everybody. Each tenant therefore validates independently. That costs a few extra
 * validation captures per tenant and contains the blast radius to one account, which is the right
 * side of that trade.
 */

export type EndpointStatus = 'CANDIDATE' | 'VALIDATING' | 'ACTIVE' | 'DEGRADED' | 'RETIRED';

/** Which role an endpoint plays, never assume one endpoint returns every field. */
export type EndpointRole =
  | 'catalogIndex'
  | 'releaseDetails'
  | 'trackIdentifiers'
  | 'artwork'
  | 'storeDeliveryStatus'
  | 'lyricsStatus'
  | 'creditsStatus';

export const ENDPOINT_ROLES: readonly EndpointRole[] = [
  'catalogIndex', 'releaseDetails', 'trackIdentifiers', 'artwork',
  'storeDeliveryStatus', 'lyricsStatus', 'creditsStatus',
];

/** Who a registry read/write belongs to. Every store call carries it, there is no ambient scope. */
export interface RegistryScope {
  tenantId: string;
  distributor: string;
}

export interface DistributorEndpointProfile {
  id: string;
  tenantId: string;
  distributor: string;
  role: EndpointRole;
  /** Sanitized identity hash. Never contains query values, cookies, headers or tokens. */
  fingerprint: string;
  method: string;
  hostPattern: string;
  /** Path with identifiers masked, e.g. `/api/album/{uuid}`. */
  pathPattern: string;
  queryKeyShape: string[];
  graphqlOperationName?: string;
  /** Hash of the response's KEY NAMES. A change here means the source schema moved. */
  schemaHash: string;
  /** The response's KEY NAMES, never values. Kept so a restarted worker still knows the shape. */
  schemaKeys?: string[];
  parserVersion: string;
  candidateScore: number;
  successfulCaptures: number;
  failedCaptures: number;
  /** Times this endpoint's schema drifted. Durable, because drift often causes the restart. */
  schemaDriftCount?: number;
  status: EndpointStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  approvedAt?: string;
  retiredAt?: string;
}

export interface EndpointRegistryStore {
  get(scope: RegistryScope, fingerprint: string): Promise<DistributorEndpointProfile | null>;
  list(scope: RegistryScope): Promise<DistributorEndpointProfile[]>;
  /** The profile carries its own tenant + distributor, so a write cannot land in another scope. */
  put(profile: DistributorEndpointProfile): Promise<void>;
}

// ---------------------------------------------------------------------------
// Candidates (discovery output)
// ---------------------------------------------------------------------------

/**
 * Tenant + scan every candidate is attributed to. Passed EXPLICITLY on every write: a shared
 * mutable "current scan" would let concurrent scans (or API replicas) write into the wrong bucket.
 */
export interface CandidateScope {
  tenantId: string;
  scanId: string;
}

/** The sanitized identity of an endpoint. Shape only, a path is masked, values never appear. */
export interface EndpointIdentity {
  method: string;
  host: string;
  /** Path with identifiers masked, e.g. `/api/album/{uuid}`. */
  pathPattern: string;
  /** Query parameter KEY names. Never the values. */
  queryKeys: string[];
  graphqlOperationName?: string;
}

/**
 * How strongly a captured response is tied to the release we asked for.
 *
 * The distinction matters because "arrived while we were reading R1" is not evidence that a
 * response IS R1's data. A catalog index, a recommendations payload, a still-settling request from
 * the PREVIOUS navigation, another tab in the same browser context, or a service-worker background
 * fetch can all land during R1's window. Treating that as correlation is how one release's ISRCs
 * get filed under another, silently, and plausibly.
 */
export type CorrelationKind =
  /** The REQUEST itself names this release (path segment, query value, GraphQL variable, body). */
  | 'REQUEST_ID_MATCH'
  /** Came from the expected endpoint profile, but the request names no release at all. */
  | 'PROFILE_MATCH_ONLY'
  /** Arrived during this release's window and nothing more. Proves nothing on its own. */
  | 'TEMPORAL_ASSOCIATION'
  /** The request names a DIFFERENT release, or there is no association at all. */
  | 'NO_CORRELATION';

/** A sanitized observation of one catalog-ish JSON response. */
export interface NetworkCandidate {
  fingerprint: string;
  identity: EndpointIdentity;
  descriptor: string;
  status: number;
  contentType: string;
  score: number;
  schemaKeys: string[];
  schemaHash: string;
  bodyBytes: number;
  observedAt: string;
  /**
   * The release the browser was NAVIGATING when this arrived. This is a temporal marker, NOT
   * correlation, read `correlation` for that. Kept because the discovery report benefits from
   * knowing a payload varies per navigation.
   */
  releaseId?: string;
  /** Request-derived correlation category. A CATEGORY only: the matched value never leaves memory. */
  correlation?: CorrelationKind;
  /** GraphQL variable KEY names. Never the values. */
  graphqlVariableKeys?: string[];
}

/** Where sanitized candidates are recorded (memory in tests, Postgres in production). */
export interface CandidateSink {
  write(candidate: NetworkCandidate, scope: CandidateScope): Promise<void>;
}

/**
 * A sanitized endpoint observation.
 *
 * Everything here is SHAPE. There is deliberately no field that could hold a value from the
 * response, a query string, a header or a cookie, the type itself is the enforcement.
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
  /** Ranked candidates for ONE tenant's scan. Must never return another tenant's rows. */
  list(tenantId: string, scanId: string): Promise<StoredCandidate[]>;
  clear(tenantId: string, scanId: string): Promise<void>;
}
