import { createHash } from 'node:crypto';
import { maskPath, sanitizedQueryKeys } from './redaction';

/**
 * Endpoint fingerprinting.
 *
 * A fingerprint identifies an endpoint's SHAPE so we can recognize it again across scans -
 * without retaining anything sensitive. We hash: method, host, masked path, query KEY names
 * (never values), and the GraphQL operationName (never variables).
 */

export interface EndpointIdentity {
  method: string;
  host: string;
  /** Path with ids masked, e.g. /api/album/{uuid} */
  pathPattern: string;
  /** Sorted query KEY names (values dropped; sensitive names masked). */
  queryKeys: string[];
  /** GraphQL operation name, when the request is a GraphQL POST. */
  graphqlOperationName?: string;
}

/** Build a sanitized identity from a request URL + optional GraphQL operation. */
export function endpointIdentity(method: string, rawUrl: string, graphqlOperationName?: string): EndpointIdentity {
  const u = new URL(rawUrl);
  return {
    method: method.toUpperCase(),
    host: u.hostname,
    pathPattern: maskPath(u.pathname),
    queryKeys: sanitizedQueryKeys(u),
    ...(graphqlOperationName ? { graphqlOperationName } : {}),
  };
}

/** Human-readable, sanitized descriptor for operator logs/UI. Contains no values. */
export function describeEndpoint(id: EndpointIdentity): string {
  const q = id.queryKeys.length ? `?${id.queryKeys.join(',')}` : '';
  const op = id.graphqlOperationName ? `#${id.graphqlOperationName}` : '';
  return `${id.method} ${id.host}${id.pathPattern}${q}${op}`;
}

/** Stable hash of the endpoint shape. Safe to persist and compare across scans. */
export function fingerprintEndpoint(id: EndpointIdentity): string {
  const normalized = [id.method, id.host, id.pathPattern, id.queryKeys.join(','), id.graphqlOperationName ?? ''].join('|');
  return createHash('sha256').update(normalized).digest('hex');
}

/** Convenience: identity + fingerprint in one step. */
export function fingerprintFromUrl(method: string, rawUrl: string, graphqlOperationName?: string): { identity: EndpointIdentity; fingerprint: string; descriptor: string } {
  const identity = endpointIdentity(method, rawUrl, graphqlOperationName);
  return { identity, fingerprint: fingerprintEndpoint(identity), descriptor: describeEndpoint(identity) };
}

/**
 * Hash of a payload's SCHEMA (sorted key names), not its data. Lets us detect schema drift:
 * if an ACTIVE endpoint's schemaHash changes, the parser may no longer be valid.
 */
export function schemaHash(schemaKeys: string[]): string {
  return createHash('sha256').update([...schemaKeys].sort().join(',')).digest('hex').slice(0, 32);
}

/**
 * Hash of a payload's VALUES, used ONLY to tell whether an endpoint's response varies between
 * releases (release-specific data) or is identical every time (config/nav). The hash is one-way
 * and never stored alongside the payload, so no data is retained.
 */
export function payloadVarianceHash(payload: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(payload) ?? '').digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

/** Extract a GraphQL operationName from a POST body without retaining variables. */
export function extractGraphqlOperationName(postData: string | null | undefined): string | undefined {
  if (!postData) return undefined;
  try {
    const body = JSON.parse(postData) as { operationName?: unknown };
    return typeof body.operationName === 'string' && body.operationName ? body.operationName : undefined;
  } catch {
    return undefined;
  }
}

/** GraphQL variable KEY names only (never values), part of the endpoint shape. */
export function extractGraphqlVariableKeys(postData: string | null | undefined): string[] {
  if (!postData) return [];
  try {
    const body = JSON.parse(postData) as { variables?: unknown };
    if (!body.variables || typeof body.variables !== 'object') return [];
    return Object.keys(body.variables as Record<string, unknown>).sort();
  } catch {
    return [];
  }
}
