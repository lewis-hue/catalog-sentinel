import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  KeycloakVerifier,
  readKeycloakConfig,
  hasAnyRole,
  ANONYMOUS_IDENTITY,
  SENTINEL_INTERACTIVE_ROLES,
  type AuthIdentity,
  type KeycloakAuthConfig,
} from '@sentinel/security';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthIdentity;
  }
}

/**
 * Registers authentication. When ENABLE_KEYCLOAK_AUTH is set, every request must carry a
 * valid Keycloak bearer token; `req.auth` is populated with the caller's tenant + roles.
 * Only an explicit isolated test runtime may disable the verifier. Every running application
 * fails closed during configuration. Only coarse health probes stay public;
 * documentation and OpenAPI require the same authenticated interactive principal as the API.
 */
export function registerAuth(app: FastifyInstance, configOverride?: Partial<KeycloakAuthConfig>): KeycloakVerifier {
  const cfg = { ...readKeycloakConfig(process.env), ...configOverride };
  const verifier = new KeycloakVerifier(cfg);
  // Probes return only coarse process/readiness state and must work without a user token for
  // container orchestrators. Documentation and the OpenAPI surface remain authenticated in
  // production: they enumerate capabilities and are not health checks.
  const publicPaths = (url: string): boolean =>
    url === '/health' || url === '/health/live' || url === '/health/ready';

  app.decorateRequest('auth', null as unknown as AuthIdentity);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!verifier.enabled) { req.auth = { ...ANONYMOUS_IDENTITY }; return; }
    // Browser CORS preflights intentionally carry no bearer token. The OPTIONS route applies a
    // strict configured-origin/method/header policy and performs no application action.
    if (req.method === 'OPTIONS') { req.auth = { ...ANONYMOUS_IDENTITY }; return; }
    if (publicPaths(req.url.split('?')[0] ?? req.url)) { req.auth = { ...ANONYMOUS_IDENTITY }; return; }
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!token) { req.auth = { ...ANONYMOUS_IDENTITY }; return void reply.status(401).send({ error: 'missing bearer token' }); }
    try {
      req.auth = await verifier.verify(token);
      // Legacy tenant-scoped routes still read x-tenant-id. When auth is enabled the verified
      // claim is authoritative: overwrite any caller-supplied value so it cannot be spoofed.
      req.headers['x-tenant-id'] = req.auth.tenantId;
    } catch (err) {
      req.auth = { ...ANONYMOUS_IDENTITY };
      // JOSE errors can contain issuer/JWKS/configuration details. Keep the wire response stable
      // and record only the error class; never reflect verifier internals to an unauthenticated
      // caller (or echo a malformed token through a third-party error message).
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'bearer token rejected');
      reply.status(401).send({ error: 'invalid token' });
    }
  });

  return verifier;
}

/** preHandler guard: require an authenticated interactive caller (isolated tests inject identity).
 * Service credentials are intentionally excluded from tenant/user endpoints. */
export function requireAuth() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isAuthEnforced() && !req.auth?.authenticated) {
      return void reply.status(401).send({ error: 'authentication required' });
    }
    if (req.auth?.authenticated && !hasAnyRole(req.auth, SENTINEL_INTERACTIVE_ROLES)) {
      return void reply.status(403).send({ error: 'interactive user role required' });
    }
  };
}

/** preHandler guard: require the caller to hold one of the given roles (RBAC). */
export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Isolated tests may inject an unauthenticated identity; deployed runtimes enforce RBAC.
    if (!req.auth?.authenticated && roles.length > 0 && isAuthEnforced()) {
      return void reply.status(401).send({ error: 'authentication required' });
    }
    // Route policy is exact. `platform_admin` is an operational role, not an implicit customer
    // tenant super-user; customer data access requires an explicit, audited support workflow.
    if (req.auth?.authenticated && !roles.some((role) => req.auth.roles.includes(role))) {
      return void reply.status(403).send({ error: `requires role: ${roles.join(' | ')}` });
    }
  };
}

function isAuthEnforced(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.ENABLE_KEYCLOAK_AUTH ?? '');
}
