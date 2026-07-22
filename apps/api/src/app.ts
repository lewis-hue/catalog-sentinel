import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  envelopeEncryptorFromEnv,
  isProductionEnvironment,
  securityHeaders,
  type AuditLogger,
  type EnvelopeCrypto,
  type KeycloakAuthConfig,
} from '@sentinel/security';
import { openApiDocument } from './openapi';
import { DistributorLinkService, requiredConsentRemainingMs } from './distributor-link';
import { runCatalogScan, scanReleasedCatalog } from './catalog-scan';
// Persistence + producers only. The API deliberately does NOT import `@sentinel/worker`: an HTTP
// server has no business pulling in Playwright, a browser runtime and a scan executor to save a
// record and push two JSON payloads onto Redis.
import {
  buildSearchStore,
  deriveManualReviewItems,
  applyManualReviewDecision,
  MANUAL_REVIEW_DECISIONS,
  type ManualReviewDecision,
  type SearchStore,
  assertStandaloneRedisTopology,
} from '@sentinel/search-store';
import {
  createDistroKidProducer,
  createPresenceProducer,
  connectionFromUrl,
} from '@sentinel/queue-client';
import { PostgresCandidateStore } from '@sentinel/persistence';
import type { CandidateSink, StoredCandidate } from '@sentinel/contracts';
import { resolveCorsOrigin } from './cors';
import {
  DistributorConnect,
  RedisConnectSessionRegistry,
  type ConnectSessionRegistry,
  type ConnectSessionRedis,
} from './distributor-connect';
import { ScanCandidateStore } from './endpoint-candidates';
import { registerAuth, requireAuth, requireRole } from './auth';
import {
  hasCustomerScanAccess,
  InvalidSearchHistoryPageError,
  parseSearchHistoryPageLimit,
  personalArtistWorkspaceId,
  PrincipalScopedSearchStore,
  SEARCH_HISTORY_NEXT_CURSOR_HEADER,
  TenantScopedSearchStore,
} from './tenant-scoped-search-store';
import { HealthChecker } from './health';
import { GenericCsvDistributorAdapter, assertSearchProviderConfig } from '@sentinel/adapters';
import { consumeFixedWindow, productionRateLimitConfig, type RateLimitRedis } from './rate-limit';
import { activeSearchStage, isActiveSearch, validateScanName } from './scan-history';
import {
  GovernanceAuthorizationError,
  GovernanceConflictError,
  GovernanceValidationError,
  type GovernanceActor,
  type InvitationAcceptor,
  type InvitationAdministrator,
  type MembershipAdministrator,
  type MembershipReader,
  type OrganizationRole,
  type PersonalOrganizationProvisioner,
  type TenantErasureRepository,
  type TenantErasureRequestRecord,
  type WorkspaceAccessAuthorizer,
  type WorkspaceRole,
} from '@sentinel/db';

function boundedEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function hasDisallowedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export interface AppDeps {
  /** Runtime composition roots must provide durable implementations. */
  distributorLink: DistributorLinkService;
  auditLogger: AuditLogger;
  /** Main injects one boot-verified AWS KMS envelope provider for all session consumers. */
  envelopeEncryptor?: EnvelopeCrypto;
  /** Isolated tests may inject a process-local registry; deployments construct Redis below. */
  connectSessionRegistry?: ConnectSessionRegistry;
  closeAudit?: () => Promise<void>;
  /** Inject persistence and dispatch seams for focused route/contract tests. */
  searchStore?: SearchStore;
  enqueueDeepScan?: (searchId: string, tenantId: string) => Promise<void>;
  runFastCatalogScan?: typeof runCatalogScan;
  runReleasedCatalogScan?: typeof scanReleasedCatalog;
  /** Test/composition seam for a concrete OIDC verifier key and issuer. */
  authConfig?: Partial<KeycloakAuthConfig>;
  /**
   * Tenant membership control plane. Runtime composition injects one durable Postgres repository;
   * the API receives only the narrow operations it is allowed to expose.
   */
  organization?: MembershipReader & MembershipAdministrator & InvitationAdministrator & InvitationAcceptor & WorkspaceAccessAuthorizer & PersonalOrganizationProvisioner;
  /** Owner-facing request/status operations; destructive execution remains worker-only. */
  tenantErasure?: Pick<TenantErasureRepository, 'request' | 'get'>;
}

function publicErasureRequest(record: TenantErasureRequestRecord) {
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    reason: record.reason,
    status: record.status,
    attempts: record.attempts,
    lastError: record.lastError,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    steps: record.steps.map((step) => ({
      resource: step.resourceKind,
      status: step.status,
      deletedCount: step.deletedCount.toString(),
      legalBasis: step.legalBasis,
      lastError: step.lastError,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
    })),
  };
}

/** Build the Fastify app. Exported so tests can inject/inspect without listening. */
export function buildApp(deps: AppDeps): FastifyInstance {
  // Fail fast if the search provider is explicitly pinned but misconfigured.
  assertSearchProviderConfig(process.env);
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  // Authentication (Keycloak/OIDC) populates req.auth (tenant + roles) on every request.
  // Anonymous identity exists only for isolated tests; deployed runtimes must enforce auth.
  const authVerifier = registerAuth(app, deps.authConfig);
  if (!authVerifier.enabled && process.env.NODE_ENV !== 'test') {
    throw new Error('Keycloak authentication must be enabled outside the test runtime.');
  }
  app.log.info(`Auth: ${authVerifier.enabled ? 'Keycloak (enforced)' : 'test identity'}`);
  if (process.env.NODE_ENV !== 'test' && !deps.organization) {
    throw new Error('A durable organization membership service is required outside the test runtime.');
  }
  if (process.env.NODE_ENV !== 'test' && !deps.tenantErasure) {
    throw new Error('A durable tenant-erasure request service is required outside the test runtime.');
  }
  const requireCustomerScanPrincipal = async (req: FastifyRequest, reply: { status(code: number): { send(payload: unknown): unknown } }): Promise<void> => {
    if (!hasCustomerScanAccess(req.auth)) {
      return void reply.status(403).send({ error: 'customer scan access requires a customer role' });
    }
  };
  // Every deployed and authenticated runtime uses an allowlist so a newly added route cannot
  // accidentally become an alternate browser path. Match Fastify's canonical
  // route pattern, not the raw request URL:
  // Fastify decodes percent-encoded path segments for routing while `req.url` remains encoded.
  // Comparing the raw URL allowed `/api/%62rowser-link/...` to bypass the old prefix denylist.
  const productionRoutePrefixes = [
    '/health', '/openapi.json', '/docs',
    '/api/consent', '/api/searches', '/api/connect', '/api/distributor-imports',
    '/api/integrations/steel', '/api/search-provider', '/api/platforms/credential-status',
    '/api/queues/status', '/api/catalogue/engine', '/api/admin/distributor-scans',
    '/api/organization',
  ];
  app.addHook('preHandler', async (req, reply) => {
    const production = isProductionEnvironment(process.env);
    if (production || authVerifier.enabled) {
      const routePattern = req.routeOptions.url;
      const allowedPrefixes = productionRoutePrefixes;
      const allowed = routePattern === '/*' || (typeof routePattern === 'string' && allowedPrefixes.some(
        (prefix) => routePattern === prefix || routePattern.startsWith(`${prefix}/`),
      ));
      if (!allowed) return void reply.status(404).send({ error: 'route unavailable' });
    }
  });
  const audit = deps.auditLogger;
  const distributorLink = deps.distributorLink;
  const envelopeEncryptor = deps.envelopeEncryptor ?? envelopeEncryptorFromEnv(process.env);
  // Populated during composition below, before Fastify can accept a request. The indirection lets
  // the earlier consent route terminate handoffs without relying on a mutable local binding.
  const connectRef: { current?: DistributorConnect } = {};
  const rateLimits = productionRateLimitConfig(process.env);
  let rateLimitRedis: RateLimitRedis | null = null;
  const enforceProductionRateLimit = async (
    req: { auth?: { tenantId?: string; sub?: string }; headers?: Record<string, unknown> },
    reply: { header(name: string, value: string): unknown; status(code: number): { send(payload: unknown): unknown } },
    bucket: 'consent' | 'connect',
  ): Promise<boolean> => {
    if (!isProductionEnvironment(process.env)) return true;
    if (!rateLimitRedis) {
      reply.status(503).send({ error: 'request capacity control is unavailable' });
      return false;
    }
    try {
      const selectedOrganization = req.headers?.['x-sentinel-organization-id'];
      const tenant = typeof selectedOrganization === 'string' && selectedOrganization.trim()
        ? selectedOrganization.trim()
        : req.auth?.tenantId ?? '';
      const subject = req.auth?.sub ?? '';
      if (!tenant || !subject) {
        reply.status(401).send({ error: 'authentication required' });
        return false;
      }
      const decision = await consumeFixedWindow(
        rateLimitRedis,
        rateLimits.prefix,
        bucket,
        `${tenant}:${subject}`,
        rateLimits[bucket],
      );
      reply.header('X-RateLimit-Limit', String(rateLimits[bucket].limit));
      reply.header('X-RateLimit-Remaining', String(decision.remaining));
      if (!decision.allowed) {
        reply.header('Retry-After', String(decision.retryAfterSeconds));
        reply.status(429).send({ error: 'request rate limit exceeded' });
        return false;
      }
      return true;
    } catch (err) {
      app.log.error({ errorType: err instanceof Error ? err.name : 'Error' }, 'production rate limiter unavailable');
      reply.status(503).send({ error: 'request capacity control is unavailable' });
      return false;
    }
  };

  // Security headers + configured CORS for the dashboard.
  app.addHook('onSend', async (req, reply, payload) => {
    const headers = securityHeaders();
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    // A Steel live-view URL is a short-lived bearer capability. Never let a browser, proxy,
    // service worker or CDN persist responses that contain it, and do not send this page's URL
    // as a referrer when the client opens the attended session.
    if (req.url.split('?')[0]?.startsWith('/api/connect')) {
      reply.header('Cache-Control', 'no-store, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Referrer-Policy', 'no-referrer');
    }
    // CORS.
    //
    // `authorization` MUST be allowed: with bearer auth and a cross-origin frontend, the browser's
    // preflight rejects every authenticated request without it — so auth would appear "broken"
    // for reasons invisible in the API's own logs, since the request never arrives.
    //
    // The origin is not `*` in production: a wildcard invites any site to call this API with the
    // user's credentials. If APP_BASE_URL isn't set we send no ACAO header at all — same-origin
    // deployments (the Compose setup proxies /api through the web origin) don't need one, and a
    // missing header fails closed instead of open.
    const corsOrigin = resolveCorsOrigin(process.env);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (corsOrigin && (corsOrigin === '*' || requestOrigin === corsOrigin)) {
      reply.header('Access-Control-Allow-Origin', corsOrigin);
    }
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'content-type, authorization, x-request-id, idempotency-key, traceparent');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    reply.header('Access-Control-Max-Age', '600');
    return payload;
  });
  app.options('/*', async (req, reply) => {
    const allowedOrigin = resolveCorsOrigin(process.env);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (!allowedOrigin || (allowedOrigin !== '*' && origin !== allowedOrigin)) {
      return reply.status(403).send({ error: 'CORS origin is not allowed' });
    }
    const requestedMethod = String(req.headers['access-control-request-method'] ?? '').toUpperCase();
    if (!new Set(['GET', 'POST', 'PATCH', 'DELETE']).has(requestedMethod)) {
      return reply.status(405).send({ error: 'CORS method is not allowed' });
    }
    const allowedHeaders = new Set([
      'content-type', 'authorization', 'x-request-id', 'idempotency-key', 'traceparent',
      'x-sentinel-organization-id',
    ]);
    const requestedHeaders = String(req.headers['access-control-request-headers'] ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
      return reply.status(400).send({ error: 'CORS header is not allowed' });
    }
    return reply.status(204).send();
  });

  // --- Meta ---------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', service: 'artist-catalog-sentinel-api', time: new Date().toISOString() }));

  app.get('/openapi.json', async (req) => {
    const base = `${req.protocol}://${req.host}`;
    return openApiDocument(base, { production: isProductionEnvironment(process.env) });
  });

  app.get('/docs', async (_req, reply) => {
    reply.type('text/html').send(
      `<!doctype html><title>Sentinel API</title><body style="font:15px system-ui;max-width:760px;margin:40px auto;padding:0 16px">
      <h1>Artist Catalog Sentinel API</h1>
      <p>This service exposes only the authenticated, tenant-scoped API described by its OpenAPI document.</p>
      <p>OpenAPI: <a href="/openapi.json">/openapi.json</a>.</p></body>`,
    );
  });

  // --- Secure Distributor Link + Deep Catalog Scan ------------------------
  // Tenant context comes only from the verified principal. Legacy header/body/query claims may
  // repeat that tenant for compatibility, but can never select or impersonate another tenant.
  const tenantOf = (req: { headers: Record<string, unknown>; auth?: { tenantId?: string } }, bodyTenantId?: string): { tenantId: string } | null => {
    const header = req.headers['x-tenant-id'];
    const claimed = (typeof header === 'string' && header) || bodyTenantId;
    const organizationHeader = req.headers['x-sentinel-organization-id'];
    const selectedOrganization = typeof organizationHeader === 'string' ? organizationHeader.trim() : '';
    if (selectedOrganization) {
      if (bodyTenantId && bodyTenantId !== selectedOrganization) return null;
      return { tenantId: selectedOrganization };
    }
    const tenantId = req.auth?.tenantId;
    // Isolated tests can exercise tenant scoping without a token. This branch is unreachable in
    // every deployed runtime because application construction requires Keycloak enforcement.
    if (!authVerifier.enabled) return { tenantId: claimed || tenantId || 'default' };
    if (!tenantId || (claimed && claimed !== tenantId)) return null;
    return { tenantId };
  };

  const governanceActor = (req: FastifyRequest): GovernanceActor => ({
    tenantId: typeof req.headers['x-sentinel-organization-id'] === 'string'
      ? req.headers['x-sentinel-organization-id'].trim()
      : req.auth.tenantId,
    subjectId: req.auth.sub,
  });
  const organizationContexts = new WeakMap<FastifyRequest, { tenantId: string; administrator: boolean }>();
  const governanceFailure = (
    reply: FastifyReply,
    error: unknown,
    operation: string,
  ): ReturnType<FastifyReply['send']> => {
    const errorType = error instanceof Error ? error.name : 'Error';
    if (error instanceof GovernanceValidationError) {
      app.log.info({ operation, errorType }, 'organization request rejected');
      return reply.status(400).send({ error: 'invalid organization request' });
    }
    if (error instanceof GovernanceAuthorizationError) {
      app.log.info({ operation, errorType }, 'organization access denied');
      return reply.status(403).send({ error: 'organization access denied' });
    }
    if (error instanceof GovernanceConflictError) {
      app.log.info({ operation, errorType }, 'organization request conflicted');
      return reply.status(409).send({ error: 'organization change conflicts with current state' });
    }
    app.log.error({ operation, errorType }, 'organization service unavailable');
    return reply.status(503).send({ error: 'organization service unavailable' });
  };
  const validIdentifier = (value: unknown, max = 255): value is string =>
    typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= max
    && !hasDisallowedControlCharacter(value);
  app.addHook('preHandler', async (req, reply) => {
    const selectedOrganization = req.headers['x-sentinel-organization-id'];
    const routePattern = req.routeOptions.url;
    const skipsPersonalProvisioning = routePattern === '/api/organization/invitations/accept'
      || routePattern === '/api/organization/erasure-requests/:requestId';
    if (req.auth.authenticated
      && req.auth.tenantId === req.auth.sub
      && routePattern?.startsWith('/api/')
      && (typeof selectedOrganization !== 'string' || !selectedOrganization.trim())
      && !skipsPersonalProvisioning) {
      if (!deps.organization) {
        if (process.env.NODE_ENV !== 'test') {
          return void reply.status(503).send({ error: 'organization provisioning unavailable' });
        }
      } else {
        try {
          await deps.organization.provisionPersonalOrganization(req.auth.tenantId, req.auth.sub);
        } catch (error) {
          return void governanceFailure(reply, error, 'organization.personal.provision');
        }
      }
    }
    if (selectedOrganization !== undefined && !validIdentifier(selectedOrganization)) {
      return void reply.status(400).send({ error: 'x-sentinel-organization-id is invalid' });
    }
    if (typeof selectedOrganization !== 'string' || !selectedOrganization.trim() || !req.auth.authenticated) return;
    // Invitation acceptance is authorized by its hashed bearer plus the token's verified email;
    // the subject cannot be a member of the invited organization until that transaction commits.
    if (req.routeOptions.url === '/api/organization/invitations/accept') return;
    if (!deps.organization) {
      if (process.env.NODE_ENV === 'test') return;
      return void reply.status(503).send({ error: 'organization service unavailable' });
    }
    const actor = governanceActor(req);
    try {
      // This method first requires an ACTIVE organization membership, including when the subject
      // has no workspace grants. Thus a client-supplied tenant id is only a selector, never proof.
      await deps.organization.listWorkspaceMemberships(actor);
      let administrator = false;
      try {
        const members = await deps.organization.listOrganizationMembers(actor);
        const ownMembership = members.find((member) => member.subjectId === actor.subjectId && member.status === 'ACTIVE');
        administrator = ownMembership?.role === 'OWNER' || ownMembership?.role === 'ADMIN';
      } catch (error) {
        if (!(error instanceof GovernanceAuthorizationError)) throw error;
      }
      organizationContexts.set(req, { tenantId: actor.tenantId, administrator });
    } catch (error) {
      return void governanceFailure(reply, error, 'organization.select');
    }
  });
  const organizationAdministrator = async (req: FastifyRequest): Promise<boolean> => {
    if (!deps.organization) return req.auth.roles.includes('tenant_admin');
    const cached = organizationContexts.get(req);
    if (cached) return cached.administrator;
    const actor = governanceActor(req);
    try {
      const members = await deps.organization.listOrganizationMembers(actor);
      const ownMembership = members.find((member) => member.subjectId === actor.subjectId && member.status === 'ACTIVE');
      return ownMembership?.role === 'OWNER' || ownMembership?.role === 'ADMIN';
    } catch (error) {
      if (error instanceof GovernanceAuthorizationError) return false;
      app.log.error(
        { operation: 'organization.admin.resolve', errorType: error instanceof Error ? error.name : 'Error' },
        'organization administrator authority unavailable',
      );
      return false;
    }
  };
  const authorizeWorkspace = async (
    req: FastifyRequest,
    reply: FastifyReply,
    workspaceValue: unknown,
    capability: 'READ' | 'EDIT' | 'MANAGE_MEMBERS' | 'DELETE',
  ): Promise<{ workspaceId: string; tenantId: string } | null> => {
    if (!validIdentifier(workspaceValue)) {
      reply.status(400).send({ error: 'artistWorkspaceId must identify an existing workspace' });
      return null;
    }
    const workspaceId = workspaceValue.trim();
    // Existing focused tests may omit the production repository. No deployed composition may do
    // so because construction above fails closed outside NODE_ENV=test.
    if (!deps.organization && process.env.NODE_ENV === 'test') {
      return { workspaceId, tenantId: governanceActor(req).tenantId };
    }
    if (!deps.organization) {
      reply.status(503).send({ error: 'organization service unavailable' });
      return null;
    }
    try {
      if (!await deps.organization.hasWorkspaceCapability(governanceActor(req), workspaceId, capability)) {
        reply.status(403).send({ error: 'workspace access denied' });
        return null;
      }
      return { workspaceId, tenantId: governanceActor(req).tenantId };
    } catch (error) {
      app.log.error(
        { operation: 'workspace.authorize', errorType: error instanceof Error ? error.name : 'Error' },
        'workspace authorization unavailable',
      );
      reply.status(503).send({ error: 'workspace authorization unavailable' });
      return null;
    }
  };

  // --- Organization membership -------------------------------------------
  // There is deliberately no tenant/workspace bootstrap endpoint here. Initial owner and
  // workspace provisioning remain trusted control-plane operations.
  app.get('/api/organization/members', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    try {
      reply.header('cache-control', 'private, no-store, max-age=0');
      const members = await deps.organization.listOrganizationMembers(governanceActor(req));
      const currentMembership = members.find((member) => member.subjectId === req.auth.sub && member.status === 'ACTIVE');
      const role = currentMembership?.role ?? null;
      return {
        members,
        capabilities: {
          role,
          manageOrganizationMembers: role === 'OWNER' || role === 'ADMIN',
          manageOwners: role === 'OWNER',
          issueInvitations: role === 'OWNER' || role === 'ADMIN',
          requestTenantErasure: role === 'OWNER',
        },
      };
    } catch (error) {
      return governanceFailure(reply, error, 'organization.members.list');
    }
  });

  app.post('/api/organization/erasure-requests', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.tenantErasure) return reply.status(503).send({ error: 'tenant erasure service unavailable' });
    const idempotencyKey = req.headers['idempotency-key'];
    const reason = (req.body as { reason?: unknown } | null)?.reason;
    if (typeof idempotencyKey !== 'string'
      || idempotencyKey.trim().length < 8
      || idempotencyKey.length > 200
      || typeof reason !== 'string'
      || !reason.trim()
      || reason.length > 1_000
      || hasDisallowedControlCharacter(reason)) {
      return reply.status(400).send({ error: 'reason and an Idempotency-Key of 8-200 characters are required' });
    }
    try {
      const actor = governanceActor(req);
      const request = await deps.tenantErasure.request(actor, {
        idempotencyKey: idempotencyKey.trim(),
        reason: reason.trim(),
      });
      await audit.log({
        tenantId: actor.tenantId,
        actorUserId: actor.subjectId,
        action: 'tenant.erasure.requested',
        targetType: 'TenantErasureRequest',
        targetId: request.id,
        metadata: { status: request.status },
      });
      reply.header('cache-control', 'private, no-store, max-age=0');
      return reply.status(202).send(publicErasureRequest(request));
    } catch (error) {
      return governanceFailure(reply, error, 'tenant.erasure.request');
    }
  });

  app.get('/api/organization/erasure-requests/:requestId', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.tenantErasure) return reply.status(503).send({ error: 'tenant erasure service unavailable' });
    const requestId = (req.params as { requestId: string }).requestId;
    if (!validIdentifier(requestId)) return reply.status(400).send({ error: 'erasure request id is invalid' });
    try {
      const request = await deps.tenantErasure.get(governanceActor(req), requestId);
      if (!request) return reply.status(404).send({ error: 'erasure request not found' });
      reply.header('cache-control', 'private, no-store, max-age=0');
      return publicErasureRequest(request);
    } catch (error) {
      return governanceFailure(reply, error, 'tenant.erasure.get');
    }
  });

  app.get('/api/organization/workspace-memberships', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    const rawWorkspaceId = (req.query as { workspaceId?: unknown }).workspaceId;
    if (rawWorkspaceId !== undefined && !validIdentifier(rawWorkspaceId)) {
      return reply.status(400).send({ error: 'workspaceId is invalid' });
    }
    try {
      reply.header('cache-control', 'private, no-store, max-age=0');
      const memberships = await deps.organization.listWorkspaceMemberships(
        governanceActor(req),
        typeof rawWorkspaceId === 'string' ? rawWorkspaceId.trim() : undefined,
      );
      const workspaceIds = [...new Set(memberships.map((membership) => membership.workspaceId))];
      const actor = governanceActor(req);
      const workspaces = await Promise.all(workspaceIds.map(async (workspaceId) => ({
        id: workspaceId,
        canRead: await deps.organization!.hasWorkspaceCapability(actor, workspaceId, 'READ'),
        canEdit: await deps.organization!.hasWorkspaceCapability(actor, workspaceId, 'EDIT'),
        canManageMembers: await deps.organization!.hasWorkspaceCapability(actor, workspaceId, 'MANAGE_MEMBERS'),
      })));
      return {
        memberships,
        workspaces: workspaces.filter((workspace) => workspace.canRead),
      };
    } catch (error) {
      return governanceFailure(reply, error, 'organization.workspace-memberships.list');
    }
  });

  app.post('/api/organization/invitations', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    const body = (req.body ?? {}) as {
      email?: unknown;
      organizationRole?: unknown;
      workspaceGrants?: unknown;
      expiresAt?: unknown;
    };
    const idempotencyKey = req.headers['idempotency-key'];
    const organizationRoles = new Set<OrganizationRole>(['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING']);
    const workspaceRoles = new Set<WorkspaceRole>(['OWNER', 'MANAGER', 'EDITOR', 'VIEWER']);
    if (typeof body.email !== 'string'
      || typeof body.organizationRole !== 'string'
      || !organizationRoles.has(body.organizationRole as OrganizationRole)
      || typeof body.expiresAt !== 'string'
      || !Array.isArray(body.workspaceGrants)
      || typeof idempotencyKey !== 'string'
      || idempotencyKey.trim().length < 8
      || idempotencyKey.length > 200) {
      return reply.status(400).send({ error: 'email, organizationRole, workspaceGrants, expiresAt, and Idempotency-Key are required' });
    }
    const workspaceGrants: Array<{ workspaceId: string; role: WorkspaceRole }> = [];
    for (const value of body.workspaceGrants) {
      const grant = value as { workspaceId?: unknown; role?: unknown };
      if (!validIdentifier(grant.workspaceId)
        || typeof grant.role !== 'string'
        || !workspaceRoles.has(grant.role as WorkspaceRole)) {
        return reply.status(400).send({ error: 'every workspace grant requires a valid workspaceId and role' });
      }
      workspaceGrants.push({ workspaceId: grant.workspaceId.trim(), role: grant.role as WorkspaceRole });
    }
    try {
      const issued = await deps.organization.issueInvitation(governanceActor(req), {
        email: body.email,
        organizationRole: body.organizationRole as OrganizationRole,
        workspaceGrants,
        expiresAt: body.expiresAt,
        idempotencyKey: idempotencyKey.trim(),
      });
      // The raw bearer exists only on the creation response. An idempotent replay returns null;
      // neither request nor response bodies are included in application logs.
      reply.header('cache-control', 'no-store, max-age=0');
      reply.status(issued.bearerToken ? 201 : 200);
      return issued;
    } catch (error) {
      return governanceFailure(reply, error, 'organization.invitation.issue');
    }
  });

  app.post('/api/organization/invitations/accept', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    const bearerToken = (req.body as { bearerToken?: unknown } | null)?.bearerToken;
    if (!validIdentifier(bearerToken, 512)) return reply.status(400).send({ error: 'invitation token is required' });
    if (req.auth.emailVerified !== true || !req.auth.email) {
      return reply.status(403).send({ error: 'a verified OIDC email is required to accept an invitation' });
    }
    try {
      const accepted = await deps.organization.acceptInvitation({
        bearerToken: bearerToken.trim(),
        subjectId: req.auth.sub,
        verifiedEmail: req.auth.email,
      });
      reply.header('cache-control', 'no-store, max-age=0');
      return accepted;
    } catch (error) {
      return governanceFailure(reply, error, 'organization.invitation.accept');
    }
  });

  app.post('/api/organization/invitations/:invitationId/revoke', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    const invitationId = (req.params as { invitationId: string }).invitationId;
    try {
      if (!await deps.organization.revokeInvitation(governanceActor(req), invitationId)) {
        return reply.status(404).send({ error: 'invitation not found' });
      }
      return reply.status(204).send();
    } catch (error) {
      return governanceFailure(reply, error, 'organization.invitation.revoke');
    }
  });

  app.patch('/api/organization/members/:subjectId', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    const subjectId = (req.params as { subjectId: string }).subjectId;
    const body = (req.body ?? {}) as { role?: unknown; status?: unknown };
    const organizationRoles = new Set<OrganizationRole>(['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING']);
    if (typeof body.role !== 'string' || !organizationRoles.has(body.role as OrganizationRole)
      || (body.status !== 'ACTIVE' && body.status !== 'SUSPENDED')) {
      return reply.status(400).send({ error: 'a valid organization role and status are required' });
    }
    try {
      return await deps.organization.setOrganizationMembership(governanceActor(req), subjectId, {
        role: body.role as OrganizationRole,
        status: body.status,
      });
    } catch (error) {
      return governanceFailure(reply, error, 'organization.member.set');
    }
  });

  app.delete('/api/organization/members/:subjectId', { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
    try {
      if (!await deps.organization.removeOrganizationMember(
        governanceActor(req),
        (req.params as { subjectId: string }).subjectId,
      )) return reply.status(404).send({ error: 'organization member not found' });
      return reply.status(204).send();
    } catch (error) {
      return governanceFailure(reply, error, 'organization.member.remove');
    }
  });

  app.put(
    '/api/organization/workspaces/:workspaceId/members/:subjectId',
    { preHandler: requireAuth() },
    async (req, reply) => {
      if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
      const params = req.params as { workspaceId: string; subjectId: string };
      const role = (req.body as { role?: unknown } | null)?.role;
      const workspaceRoles = new Set<WorkspaceRole>(['OWNER', 'MANAGER', 'EDITOR', 'VIEWER']);
      if (typeof role !== 'string' || !workspaceRoles.has(role as WorkspaceRole)) {
        return reply.status(400).send({ error: 'a valid workspace role is required' });
      }
      try {
        return await deps.organization.grantWorkspaceMembership(governanceActor(req), {
          workspaceId: params.workspaceId,
          subjectId: params.subjectId,
          role: role as WorkspaceRole,
        });
      } catch (error) {
        return governanceFailure(reply, error, 'organization.workspace-member.set');
      }
    },
  );

  app.delete(
    '/api/organization/workspaces/:workspaceId/members/:subjectId',
    { preHandler: requireAuth() },
    async (req, reply) => {
      if (!deps.organization) return reply.status(503).send({ error: 'organization service unavailable' });
      const params = req.params as { workspaceId: string; subjectId: string };
      try {
        if (!await deps.organization.removeWorkspaceMembership(
          governanceActor(req), params.workspaceId, params.subjectId,
        )) return reply.status(404).send({ error: 'workspace membership not found' });
        return reply.status(204).send();
      } catch (error) {
        return governanceFailure(reply, error, 'organization.workspace-member.remove');
      }
    },
  );

  app.post('/api/consent', { preHandler: requireRole('artist_manager', 'tenant_admin') }, async (req, reply) => {
    if (!await enforceProductionRateLimit(req, reply, 'consent')) return;
    const b = (req.body ?? {}) as { tenantId?: string; artistWorkspaceId?: string; distributor?: string; scope?: string; provider?: string };
    const ctx = tenantOf(req, b.tenantId);
    const artistWorkspaceId = typeof b.artistWorkspaceId === 'string' ? b.artistWorkspaceId.trim() : '';
    const distributor = typeof b.distributor === 'string' ? b.distributor.trim().toLowerCase() : '';
    if (!ctx) return reply.status(400).send({ error: 'tenant claim does not match the authenticated principal' });
    if (!artistWorkspaceId || artistWorkspaceId.length > 256 || hasDisallowedControlCharacter(artistWorkspaceId)) {
      return reply.status(400).send({ error: 'artistWorkspaceId must be a valid value of at most 256 characters' });
    }
    if (distributor !== 'distrokid') return reply.status(400).send({ error: 'only DistroKid is supported by the active connect flow' });
    if (b.scope !== 'distributor:read-catalog') return reply.status(400).send({ error: 'scope must be distributor:read-catalog' });
    const provider = b.provider === 'steel' ? 'steel' : null;
    if (!provider) return reply.status(400).send({ error: 'provider must be steel' });
    const authorizedWorkspace = await authorizeWorkspace(req, reply, artistWorkspaceId, 'EDIT');
    if (!authorizedWorkspace) return;
    await audit.log({
      tenantId: ctx.tenantId,
      workspaceId: authorizedWorkspace.workspaceId,
      actorUserId: req.auth?.sub ?? null,
      action: 'consent.grant.requested',
      targetType: 'ConsentGrant',
      metadata: { distributor, scope: b.scope, provider },
    });
    const c = await distributorLink.grantConsent(ctx, {
      artistWorkspaceId: authorizedWorkspace.workspaceId, distributor, scope: b.scope, provider, actorUserId: req.auth?.sub,
    });
    reply.status(201);
    return {
      consentId: c.id,
      scope: c.scope,
      expiresAt: c.expiresAt,
      purpose: c.purpose,
      disclosureVersion: c.disclosureVersion,
      retentionDays: c.retentionDays,
    };
  });

  app.post('/api/consent/:id/revoke', { preHandler: requireRole('artist_manager', 'tenant_admin') }, async (req, reply) => {
    const ctx = tenantOf(req);
    if (!ctx) return reply.status(400).send({ error: 'tenant claim does not match the authenticated principal' });
    const consentId = (req.params as { id: string }).id;
    const revocationActor = {
      actorUserId: req.auth?.sub ?? 'anonymous',
      // Deliberately exact: platform operators do not implicitly become customer-data admins.
      allowTenantAdmin: await organizationAdministrator(req),
    };
    void audit.log({
      tenantId: ctx.tenantId,
      actorUserId: req.auth?.sub ?? null,
      action: 'consent.revoke.requested',
      targetType: 'ConsentGrant',
      targetId: consentId,
    }).catch((err) => app.log.error(
      { errorType: err instanceof Error ? err.name : 'Error' },
      'consent revocation request audit failed',
    ));
    let revocationWrite: Awaited<ReturnType<DistributorLinkService['requestConsentRevocation']>> = null;
    let revocationError: unknown = null;
    try {
      revocationWrite = await distributorLink.requestConsentRevocation(ctx, consentId, revocationActor);
    } catch (err) {
      revocationError = err;
    }
    // If Postgres failed before the atomic revoke+outbox statement committed, ownership cannot be
    // proven. Do not let a guessed same-tenant consent id become a Steel-session cancellation DoS.
    if (revocationError) {
      app.log.error(
        { errorType: revocationError instanceof Error ? revocationError.name : 'Error' },
        'consent persistence revocation is unconfirmed',
      );
      return reply.status(503).send({
        error: 'consent revocation is not yet confirmed',
        revoked: false,
        sessionsTerminated: 0,
      });
    }
    if (!revocationWrite) {
      // Missing and same-tenant-but-not-owned are intentionally indistinguishable. Orphan cleanup
      // belongs to the internal reconciler, never to an unconfirmed user-supplied identifier.
      return reply.status(404).send({ error: 'consent not found' });
    }

    try {
      if (!connectRef.current) throw new Error('connect service is not initialized');
      const reconciliation = await distributorLink.reconcileConsentRevocation(
        ctx,
        consentId,
        revocationWrite.intent,
        (owner, id) => connectRef.current!.cancelByConsent(id, owner.tenantId),
      );
      if (!reconciliation.cleanupPending) {
        return { revoked: true, sessionsTerminated: reconciliation.sessionsTerminated, cleanupPending: false };
      }
      app.log.warn(
        { intentId: revocationWrite.intent.id, attempts: revocationWrite.intent.attempts },
        'consent revoked; durable Steel cleanup remains pending',
      );
      return reply.status(202).send({
        revoked: true,
        cleanupPending: true,
        sessionsTerminated: reconciliation.sessionsTerminated,
      });
    } catch (cleanupError) {
      // The outbox is already durable. Make one extra emergency release attempt if the database
      // became unavailable during leasing/status read; the reconciler will safely repeat it.
      let sessionsTerminated = 0;
      try {
        if (connectRef.current) sessionsTerminated = await connectRef.current.cancelByConsent(consentId, ctx.tenantId);
      } catch {
        // Preserve the pending response; recovery owns the retry.
      }
      app.log.error(
        { errorType: cleanupError instanceof Error ? cleanupError.name : 'Error' },
        'consent revoked; durable Steel cleanup reconciliation is pending',
      );
      return reply.status(202).send({
        revoked: true,
        cleanupPending: true,
        sessionsTerminated,
      });
    }
  });

  // --- Searches + history -------------------------------------------------
  // Deployed runtimes require both Redis coordination and PostgreSQL durability. Focused tests
  // may inject an isolated store, but the application never silently selects process-local state.
  const redisUrl = process.env.REDIS_URL;
  const useBullMq = process.env.DEEP_SCAN_DISPATCH === 'bullmq' && Boolean(redisUrl);
  if (process.env.NODE_ENV !== 'test') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required outside the test runtime.');
    if (!redisUrl || !useBullMq) throw new Error('REDIS_URL and DEEP_SCAN_DISPATCH=bullmq are required outside the test runtime.');
  }
  const built = buildSearchStore(process.env, (m, e) => app.log.warn({ ...e }, `[search-store] ${m}`));
  const searchStore: SearchStore = deps.searchStore ?? built.store;
  let connectRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let consentRevocationTimer: ReturnType<typeof setInterval> | null = null;
  let consentRevocationRecovery: Promise<void> | null = null;
  app.log.info(`Search store: ${built.kind}`);
  // Reuse the search store's Redis connection for coordination state. Creating a second
  // untracked ioredis client here leaked a socket every time a Fastify instance was closed.
  const redis = useBullMq ? built.redis : null;
  if (built.redis) {
    app.addHook('onReady', async () => {
      await assertStandaloneRedisTopology(built.redis!);
    });
  }
  rateLimitRedis = built.redis as unknown as RateLimitRedis | null;
  const presenceProducer = redis && redisUrl ? createPresenceProducer(connectionFromUrl(redisUrl)) : null;
  // Sanitized endpoint candidates observed during scans (served by the admin route below).
  //
  // Durable in every deployment. The process-local implementation is reachable only from an
  // isolated test composition that deliberately omits PostgreSQL.
  const candidateStore: CandidateSink & { list(t: string, s: string): Promise<StoredCandidate[]> | StoredCandidate[] } =
    built.pgPool ? new PostgresCandidateStore(built.pgPool) : new ScanCandidateStore();
  if (!built.pgPool) app.log.warn('Test-only endpoint candidate store is process-local.');
  // Catalogue-read DISPATCH.
  //
  // `pipeline` is the DEFAULT whenever Redis is present, because it is the only path with crash
  // recovery, failed-release-only retry and durable finalization. The others exist for a dev box
  // with no Redis and for emergency rollback — they are not equivalent, and defaulting to the
  // weaker one meant the durable pipeline was "available" but effectively unused.
  app.log.info('Catalogue read dispatch: durable network-first pipeline');
  // Enqueues onto `distrokid-catalog-index`, which the worker's six-stage pipeline consumes. Via
  // @sentinel/queue-client so the API never imports the worker application to queue work.
  const dkProducer = redis && redisUrl ? createDistroKidProducer(connectionFromUrl(redisUrl)) : null;
  if (dkProducer) app.log.info('DistroKid network-first pipeline producer attached (queue "distrokid-catalog-index").');

  app.addHook('onClose', async () => {
    if (connectRecoveryTimer) clearInterval(connectRecoveryTimer);
    if (consentRevocationTimer) clearInterval(consentRevocationTimer);
    // Do not close Prisma/Redis underneath an in-flight lease owner. The outer graceful-shutdown
    // deadline remains the hard bound if an external release call does not return.
    if (consentRevocationRecovery) await consentRevocationRecovery;
    await Promise.allSettled([
      presenceProducer?.close() ?? Promise.resolve(),
      dkProducer?.close() ?? Promise.resolve(),
      distributorLink.close(),
      deps.closeAudit?.() ?? Promise.resolve(),
    ]);
    await built.close();
  });

  // --- Health + ops status (public liveness; readiness gates on critical deps) --------
  const health = new HealthChecker({ redis: built.redis, pgPool: built.pgPool, presenceCounts: presenceProducer ? () => presenceProducer.counts() : null, env: process.env });
  app.get('/health/live', async () => ({ status: 'live', ts: new Date().toISOString() }));
  app.get('/health/ready', async (_req, reply) => {
    const r = await health.ready();
    if (!r.ready) reply.status(503);
    return { ready: r.ready, deps: r.deps };
  });
  app.get('/health/dependencies', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async () => health.dependencies());
  app.get('/api/search-provider/status', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async () => health.searchProviderStatus());
  app.get('/api/platforms/credential-status', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async () => ({ platforms: health.credentialStatus() }));
  app.get('/api/queues/status', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async () => health.queue());
  /**
   * Which extraction ENGINE this deployment actually uses.
   *
   * Exposed because "the pipeline is wired" was true of the code and false of the deployment for
   * an entire review cycle: dispatch was opt-in, so the durable path existed but nothing selected
   * it. A reader should be able to see which engine will run without grepping env vars.
   */
  app.get('/api/catalogue/engine', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async () => ({
    dispatch: 'pipeline',
    reason: null,
    engine: 'NETWORK_FIRST',
    durable: true,
    resumable: true,
    retryFailedOnly: true,
    queue: 'distrokid-catalog-index',
  }));
  // Ranked, SANITIZED endpoint candidates observed during a scan — this is what removes the
  // manual "read the logs and hard-code a URL" step. Never returns cookies, headers, tokens,
  // query/POST values or response bodies: only endpoint shape + schema key names.
  app.get('/api/admin/distributor-scans/:scanId/endpoint-candidates', { preHandler: requireRole('tenant_admin', 'platform_admin') }, async (req) => {
    const { scanId } = req.params as { scanId: string };
    // Tenant-scoped: a tenant can only ever read candidates recorded for its OWN scan.
    const tenantId = governanceActor(req).tenantId;
    const candidates = await candidateStore.list(tenantId, scanId);
    await audit.log({ tenantId, action: 'distributor.endpoint-candidates.read', targetType: 'DistributorScan', targetId: scanId, metadata: { candidates: candidates.length } });
    return { scanId, tenantId, candidates };
  });
  // Steel Browser connector status. Safe status only — the
  // API URL is host-only redacted and no secrets, session ids, viewer URLs, or deprecated
  // local-browser alternatives are returned.
  app.get('/api/integrations/steel/status', { preHandler: requireAuth() }, async () => health.steel());
  // Kick off the background multi-platform deep scan through the BullMQ worker. The API never
  // executes catalogue scans in its request process.
  const enqueueDeepScan = async (searchId: string, tenantId: string): Promise<boolean> => {
    const dispatch = deps.enqueueDeepScan
      ? () => deps.enqueueDeepScan!(searchId, tenantId)
      : presenceProducer
        ? () => presenceProducer.enqueue(searchId, tenantId)
        : null;
    if (dispatch) {
      const scopedQueueStore = new TenantScopedSearchStore(searchStore, tenantId);
      const queued = await scopedQueueStore.update(searchId, (record) => ({
        ...record,
        deepScan: {
          status: 'queued',
          platformsPending: record.deepScan?.platformsPending ?? [],
          platformsDone: record.deepScan?.platformsDone ?? [],
          updatedAt: new Date().toISOString(),
        },
      }));
      if (!queued) throw new Error('deep scan target is unavailable');
      try {
        await dispatch();
        return true;
      } catch (error) {
        await scopedQueueStore.update(searchId, (record) => ({
          ...record,
          deepScan: {
            status: 'error',
            platformsPending: record.deepScan?.platformsPending ?? [],
            platformsDone: record.deepScan?.platformsDone ?? [],
            updatedAt: new Date().toISOString(),
            error: 'Deep scan could not be queued.',
          },
        })).catch(() => null);
        throw error;
      }
    }
    // No queue and no injected runner. Say so rather than silently returning a scan that will
    // never progress past its fast pass — the user would just watch it never fill in.
    app.log.warn({ searchId }, 'deep scan unavailable: no presence queue configured and no inline runner injected');
    return false;
  };

  app.post('/api/searches', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; artistWorkspaceId?: unknown; artist?: string; distributor?: string; platforms?: string[]; song?: { title?: string; isrc?: string } };
    const artist = (b.artist ?? '').trim();
    if (!artist) return reply.status(400).send({ error: 'artist is required' });
    const parsedName = b.name === undefined ? null : validateScanName(b.name);
    if (parsedName && !parsedName.ok) return reply.status(400).send({ error: parsedName.error });
    const personalWorkspace = personalArtistWorkspaceId(req.auth?.tenantId ?? 'default', req.auth?.sub ?? 'anonymous');
    const workspaceAccess = deps.organization
      ? await authorizeWorkspace(req, reply, b.artistWorkspaceId, 'EDIT')
      : { workspaceId: personalWorkspace, tenantId: req.auth?.tenantId ?? 'default' };
    if (!workspaceAccess) return;
    try {
      await audit.log({
        tenantId: workspaceAccess.tenantId,
        workspaceId: workspaceAccess.workspaceId,
        actorUserId: req.auth?.sub ?? null,
        action: 'catalog.search.requested',
        targetType: 'CatalogSearch',
        metadata: { distributor: (b.distributor ?? 'distrokid').trim(), platformCount: b.platforms?.length ?? 0 },
      });
      // Fast pass (Deezer + Apple, whole catalogue, ~1s) so the request never blocks on
      // rate-limited web queries, then enqueue the background deep scan for the rest.
      const result = await (deps.runFastCatalogScan ?? runCatalogScan)(artist, { fast: true });
      const released = result.tracks.map((t) => ({ title: t.title, primaryArtist: artist, isrc: t.isrc }));
      const scoped = await forPrincipal(req, reply, workspaceAccess.tenantId);
      if (!scoped) return;
      const rec = await scoped.saveInAuthorizedWorkspace(workspaceAccess.workspaceId, {
        ...(parsedName?.ok ? { name: parsedName.name } : {}),
        artist,
        distributor: (b.distributor ?? 'distrokid').trim(),
        platforms: b.platforms,
        song: b.song ?? null,
      }, result, released);
      await enqueueDeepScan(rec.id, workspaceAccess.tenantId).catch((err) => app.log.error({ err }, 'enqueue deep scan failed'));
      reply.status(201);
      return { id: rec.id, createdAt: rec.createdAt, result: rec.result };
    } catch (err) {
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'catalog search failed');
      return reply.status(502).send({ error: 'search failed' });
    }
  });
  /**
   * Every read below goes through `forPrincipal(...)`, which binds both the verified tenant and
   * OIDC subject once. Tenant administrators retain same-tenant operational access; a
   * platform-admin-only identity does not implicitly receive customer catalogue access.
   *
   * Before this, `list()` returned EVERY tenant's searches to every caller and `get(id)` fetched
   * by id alone — so an authenticated user could read another tenant's artists, unreleased
   * catalogue and ISRCs by knowing a search id. The record type carried no tenant at all, so
   * there was nothing to filter on even if a route had wanted to.
   */
  const forPrincipal = async (
    req: FastifyRequest,
    reply: FastifyReply,
    tenantId = governanceActor(req).tenantId,
  ): Promise<PrincipalScopedSearchStore | null> => {
    const principal = { ...req.auth, tenantId };
    if (!deps.organization && process.env.NODE_ENV === 'test') {
      return new PrincipalScopedSearchStore(searchStore, principal);
    }
    if (!deps.organization) {
      reply.status(503).send({ error: 'organization service unavailable' });
      return null;
    }
    try {
      const actor = { tenantId, subjectId: req.auth.sub };
      const memberships = await deps.organization.listWorkspaceMemberships(actor);
      const workspaceIds = [...new Set(memberships.map((membership) => membership.workspaceId))];
      const capabilities = await Promise.all(workspaceIds.map(async (workspaceId) => ({
        workspaceId,
        read: await deps.organization!.hasWorkspaceCapability(actor, workspaceId, 'READ'),
        edit: await deps.organization!.hasWorkspaceCapability(actor, workspaceId, 'EDIT'),
      })));
      return new PrincipalScopedSearchStore(searchStore, principal, {
        read: capabilities.filter((capability) => capability.read).map((capability) => capability.workspaceId),
        edit: capabilities.filter((capability) => capability.edit).map((capability) => capability.workspaceId),
      });
    } catch (error) {
      governanceFailure(reply, error, 'catalog.workspace-scope.resolve');
      return null;
    }
  };

  app.get('/api/searches', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const query = req.query as { limit?: unknown; cursor?: unknown };
    try {
      const limit = parseSearchHistoryPageLimit(query.limit);
      if (query.cursor !== undefined && typeof query.cursor !== 'string') throw new InvalidSearchHistoryPageError();
      const scoped = await forPrincipal(req, reply);
      if (!scoped) return;
      const page = await scoped.listPage(limit, query.cursor);
      if (page.nextCursor) reply.header(SEARCH_HISTORY_NEXT_CURSOR_HEADER, page.nextCursor);
      reply.header('cache-control', 'private, no-store, max-age=0');
      // Preserve the established response body so existing clients continue to receive an array.
      return { searches: page.searches };
    } catch (error) {
      if (error instanceof InvalidSearchHistoryPageError) {
        return reply.status(400).send({ error: 'invalid search history pagination' });
      }
      throw error;
    }
  });
  app.get('/api/searches/:id', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const scoped = await forPrincipal(req, reply);
    if (!scoped) return;
    const rec = await scoped.get((req.params as { id: string }).id);
    // 404 (not 403) for another tenant's id: a 403 would confirm the id exists, turning
    // id-guessing into an enumeration oracle over other tenants' scans.
    if (!rec) return reply.status(404).send({ error: 'search not found' });
    return rec;
  });

  app.patch('/api/searches/:id', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const searchId = (req.params as { id: string }).id;
    const parsedName = validateScanName((req.body as { name?: unknown } | null)?.name);
    if (!parsedName.ok) return reply.status(400).send({ error: parsedName.error });
    const scoped = await forPrincipal(req, reply);
    if (!scoped) return;
    const updated = await scoped.update(searchId, (record) => ({ ...record, name: parsedName.name }));
    if (!updated) return reply.status(404).send({ error: 'search not found' });
    await audit.log({
      tenantId: governanceActor(req).tenantId,
      workspaceId: updated.artistWorkspaceId ?? null,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.renamed',
      targetType: 'CatalogSearch',
      targetId: searchId,
      metadata: { revision: updated.revision ?? null },
    });
    return { id: updated.id, name: updated.name, revision: updated.revision };
  });

  app.delete('/api/searches/:id', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const searchId = (req.params as { id: string }).id;
    const scoped = await forPrincipal(req, reply);
    if (!scoped) return;
    const existing = await scoped.get(searchId);
    if (!existing) return reply.status(404).send({ error: 'search not found' });
    if (isActiveSearch(existing)) {
      return reply.status(409).send({
        error: 'active searches must finish or be cancelled before deletion',
        status: activeSearchStage(existing),
      });
    }
    if (!await scoped.delete(searchId)) return reply.status(404).send({ error: 'search not found' });
    await audit.log({
      tenantId: governanceActor(req).tenantId,
      workspaceId: existing.artistWorkspaceId ?? null,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.deleted',
      targetType: 'CatalogSearch',
      targetId: searchId,
      metadata: { terminalStatus: existing.deepScan?.status ?? 'idle' },
    });
    return reply.status(204).send();
  });

  app.post('/api/searches/:id/rescan', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const sourceSearchId = (req.params as { id: string }).id;
    const activeTenantId = governanceActor(req).tenantId;
    const scoped = await forPrincipal(req, reply, activeTenantId);
    if (!scoped) return;
    const source = await scoped.get(sourceSearchId);
    if (!source) return reply.status(404).send({ error: 'search not found' });
    if (isActiveSearch(source)) {
      return reply.status(409).send({
        error: 'an active search cannot be used for a platform recheck',
        status: activeSearchStage(source),
      });
    }

    const requestedName = (req.body as { name?: unknown } | null)?.name;
    const parsedName = requestedName === undefined
      ? (source.name ? validateScanName(source.name) : null)
      : validateScanName(requestedName);
    if (parsedName && !parsedName.ok) return reply.status(400).send({ error: parsedName.error });

    let result: Awaited<ReturnType<typeof runCatalogScan>>;
    try {
      result = source.released !== undefined
        ? await (deps.runReleasedCatalogScan ?? scanReleasedCatalog)(source.artist, structuredClone(source.released))
        : await (deps.runFastCatalogScan ?? runCatalogScan)(source.artist, { fast: true });
      result = {
        ...result,
        ...(source.result.distributorExtraction
          ? { distributorExtraction: structuredClone(source.result.distributorExtraction) }
          : {}),
        note: 'Platform presence was rechecked from the saved distributor snapshot. Distributor metadata was not re-extracted; use Refresh from DistroKid to capture current catalog metadata.',
      };
    } catch (error) {
      app.log.warn({ errorType: error instanceof Error ? error.name : 'Error' }, 'catalog rescan fast pass failed');
      return reply.status(502).send({ error: 'rescan failed' });
    }

    const released = source.released !== undefined
      ? structuredClone(source.released)
      : result.tracks.map((track) => ({
          title: track.title,
          primaryArtist: track.primaryArtist ?? source.artist,
          isrc: track.isrc,
          releaseTitle: track.album,
          artworkUrl: track.artworkUrl,
          label: track.label,
          upc: track.upc,
          releaseDate: track.releaseDate,
          uploadDate: track.uploadDate,
          ...(track.metadata ? { metadata: structuredClone(track.metadata) } : {}),
        }));
    const rescanned = await scoped.saveDerived(source, {
      ...(parsedName?.ok ? { name: parsedName.name } : {}),
      sourceSearchId,
      artist: source.artist,
      distributor: source.distributor,
      platforms: [...source.platforms],
      song: source.song ? { ...source.song } : null,
    }, result, released);

    try {
      const queued = await enqueueDeepScan(rescanned.id, activeTenantId);
      if (!queued) {
        // No dispatcher means no job could have escaped. Remove the incomplete history entry so a
        // 503 response cannot leave a record that looks like a real rescan.
        await scoped.delete(rescanned.id);
        return reply.status(503).send({ error: 'deep scan is unavailable' });
      }
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : 'Error', searchId: rescanned.id }, 'catalog rescan queue failed');
      return reply.status(503).send({ error: 'deep scan could not be queued', searchId: rescanned.id });
    }

    const queuedRecord = await scoped.get(rescanned.id);
    await audit.log({
      tenantId: activeTenantId,
      workspaceId: rescanned.artistWorkspaceId ?? null,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.platform-recheck.created',
      targetType: 'CatalogSearch',
      targetId: rescanned.id,
      metadata: { sourceSearchId, mode: 'saved_snapshot_platform_recheck' },
    });
    reply.status(201);
    return {
      id: rescanned.id,
      createdAt: rescanned.createdAt,
      sourceSearchId,
      operation: 'SAVED_SNAPSHOT_PLATFORM_RECHECK',
      ...(rescanned.name ? { name: rescanned.name } : {}),
      deepScan: queuedRecord?.deepScan,
      result: rescanned.result,
      actions: {
        refreshDistributor: {
          href: '/connect',
          label: 'Refresh from DistroKid',
          description: 'Start a new attended Steel session to re-extract current distributor metadata.',
        },
      },
    };
  });

  // --- Manual review queue ------------------------------------------------
  // Low-confidence / unverifiable cells become review tasks; resolving one writes an
  // authoritative decision back to the presence matrix (the scan record).
  app.get('/api/searches/:id/manual-review', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const scoped = await forPrincipal(req, reply);
    if (!scoped) return;
    const rec = await scoped.get((req.params as { id: string }).id);
    if (!rec) return reply.status(404).send({ error: 'search not found' });
    const includeResolved = /^(1|true|yes)$/i.test(((req.query as { resolved?: string }).resolved) ?? '');
    const items = deriveManualReviewItems(rec, { includeResolved });
    return { scanId: rec.id, artist: rec.artist, open: items.filter((i) => !i.resolved).length, items };
  });

  app.patch('/api/searches/:id/manual-review/:itemId', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = (req.body ?? {}) as { decision?: string; notes?: string };
    const decision = body.decision as ManualReviewDecision;
    if (!MANUAL_REVIEW_DECISIONS.includes(decision)) {
      return reply.status(400).send({ error: `decision must be one of ${MANUAL_REVIEW_DECISIONS.join(', ')}` });
    }
    const scoped = await forPrincipal(req, reply);
    if (!scoped) return;
    const existing = await scoped.get(id);
    if (!existing) return reply.status(404).send({ error: 'search not found' });
    await audit.log({
      tenantId: governanceActor(req).tenantId,
      workspaceId: existing.artistWorkspaceId ?? null,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.manual-review.requested',
      targetType: 'ManualReviewItem',
      targetId: itemId,
      metadata: { searchId: id, decision },
    });
    let applied = true;
    // Scoped update: a manual-review decision must never be writable onto another tenant's scan.
    const updated = await scoped.update(id, (r) => {
      // Reviewer identity is security metadata. It comes only from the verified request
      // principal (or the isolated test identity), never from a client-controlled JSON field.
      const next = applyManualReviewDecision(r, itemId, decision, {
        reviewedBy: req.auth?.sub ?? 'anonymous',
        notes: body.notes,
        at: new Date().toISOString(),
      });
      if (!next) { applied = false; return r; }
      return next;
    });
    if (!applied) return reply.status(404).send({ error: 'manual-review item not found' });
    return { ok: true, summary: updated?.result.summary };
  });

  // --- One-click "connect distributor & scan" (cloud browser) -------------
  const connectRegistry = built.redis
    ? new RedisConnectSessionRegistry(
        built.redis as unknown as ConnectSessionRedis,
        process.env.CONNECT_SESSION_PREFIX ?? `sentinel:${process.env.NODE_ENV ?? 'development'}:connect-session`,
        () => Date.now(),
        envelopeEncryptor,
      )
    : deps.connectSessionRegistry;
  if (!connectRegistry) throw new Error('A durable Redis connect-session registry is required.');
  const connect = new DistributorConnect(
    searchStore, process.env, async (searchId, tenantId) => { await enqueueDeepScan(searchId, tenantId); }, undefined, candidateStore,
    dkProducer ? (job) => dkProducer.startSnapshot(job) : undefined,
    connectRegistry,
    undefined,
    async (binding) => {
      await distributorLink.assertReadConsent(
        { tenantId: binding.tenantId },
        binding.consentId,
        {
          artistWorkspaceId: binding.artistWorkspaceId,
          distributor: binding.distributor,
          provider: 'steel',
          actorUserId: binding.ownerUserId,
          // Check against the lease Steel actually returned, not merely the requested timeout.
          minimumRemainingMs: Math.max(1, Date.parse(binding.sessionExpiresAt) - Date.now()),
        },
      );
    },
    envelopeEncryptor,
    async (binding) => {
      if (!deps.organization && process.env.NODE_ENV === 'test') return true;
      if (!deps.organization) {
        const error = new Error('workspace authorization service is unavailable');
        error.name = 'ConnectWorkspaceAuthorizationUnavailableError';
        throw error;
      }
      try {
        return await deps.organization.hasWorkspaceCapability({
          tenantId: binding.tenantId,
          subjectId: binding.subjectId,
        }, binding.workspaceId, 'EDIT');
      } catch {
        const error = new Error('workspace authorization service is unavailable');
        error.name = 'ConnectWorkspaceAuthorizationUnavailableError';
        throw error;
      }
    },
  );
  connectRef.current = connect;
  // A committed revocation intent must survive the HTTP process dying before Steel release. In
  // durable deployments every API replica polls the same SKIP LOCKED outbox; only one owns each
  // lease, and token CAS makes late acknowledgements harmless. The immediate run drains work left
  // by a previous deployment without waiting a full interval.
  if (isProductionEnvironment(process.env) || Boolean(process.env.DATABASE_URL)) {
    const intervalMs = boundedEnvInteger('CONSENT_REVOCATION_RECOVERY_INTERVAL_MS', 10_000, 1_000, 300_000);
    const batchSize = boundedEnvInteger('CONSENT_REVOCATION_RECOVERY_BATCH_SIZE', 50, 1, 500);
    const leaseMs = boundedEnvInteger('CONSENT_REVOCATION_LEASE_MS', 30_000, 5_000, 300_000);
    const recoverRevocations = (): Promise<void> => {
      if (consentRevocationRecovery) return consentRevocationRecovery;
      const run = (async () => {
        try {
          const result = await distributorLink.reconcileConsentRevocations(
            (ctx, consentId) => connect.cancelByConsent(consentId, ctx.tenantId),
            { limit: batchSize, leaseMs },
          );
          if (result.claimed > 0) app.log.info(result, 'reconciled durable consent revocation intents');
        } catch (err) {
          app.log.error(
            { errorType: err instanceof Error ? err.name : 'Error' },
            'consent revocation reconciliation failed',
          );
        }
      })();
      consentRevocationRecovery = run;
      void run.finally(() => {
        if (consentRevocationRecovery === run) consentRevocationRecovery = null;
      });
      return run;
    };
    consentRevocationTimer = setInterval(() => { void recoverRevocations(); }, intervalMs);
    consentRevocationTimer.unref?.();
    void recoverRevocations();
  }
  if (built.redis) {
    const recoveryIntervalMs = boundedEnvInteger('CONNECT_SESSION_RECOVERY_INTERVAL_MS', 15_000, 5_000, 300_000);
    const recoveryBatchSize = boundedEnvInteger('CONNECT_SESSION_RECOVERY_BATCH_SIZE', 50, 1, 500);
    let recoveryRunning = false;
    const recover = async (): Promise<void> => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        const result = await connect.recoverAbandoned(recoveryBatchSize);
        if (result.claimed > 0) app.log.info(result, 'reconciled abandoned distributor-connect claims');
      } catch (err) {
        app.log.error(
          { errorType: err instanceof Error ? err.name : 'Error' },
          'distributor-connect claim reconciliation failed',
        );
      } finally {
        recoveryRunning = false;
      }
    };
    connectRecoveryTimer = setInterval(() => { void recover(); }, recoveryIntervalMs);
    connectRecoveryTimer.unref?.();
    // Recover work left by a previous deployment without waiting one full interval.
    void recover();
  }
  app.post('/api/connect', { preHandler: requireRole('artist_manager', 'tenant_admin') }, async (req, reply) => {
    if (!await enforceProductionRateLimit(req, reply, 'connect')) return;
    const b = (req.body ?? {}) as { distributor?: string; artist?: string; artists?: string[]; consentId?: string };
    // Accept a single `artist` (legacy) or `artists[]` (a label with many artists — DistroKid
    // Ultimate allows 5–100). Dedupe + trim; cap to a sane roster size.
    if (b.artists !== undefined && (!Array.isArray(b.artists) || b.artists.some((a) => typeof a !== 'string'))) {
      return reply.status(400).send({ error: 'artists must be an array of names' });
    }
    if (b.artist !== undefined && typeof b.artist !== 'string') return reply.status(400).send({ error: 'artist must be a name' });
    const rawArtists = [...(b.artists ?? []), ...(b.artist ? [b.artist] : [])];
    if (rawArtists.length > 100) return reply.status(400).send({ error: 'at most 100 artist names are supported' });
    const artists = [...new Set(rawArtists.map((a) => a.trim()).filter(Boolean))];
    if (artists.length === 0) return reply.status(400).send({ error: 'at least one artist name is required' });
    if (artists.some((a) => a.length > 200 || hasDisallowedControlCharacter(a))) {
      return reply.status(400).send({ error: 'artist names must be at most 200 characters and contain no control characters' });
    }
    if (typeof b.consentId !== 'string' || !b.consentId.trim() || b.consentId.length > 256) {
      return reply.status(400).send({ error: 'active read-only consent is required' });
    }
    const requestedDistributor = typeof b.distributor === 'string' ? b.distributor.trim().toLowerCase() : 'distrokid';
    if (requestedDistributor !== 'distrokid') return reply.status(400).send({ error: 'only DistroKid is supported' });
    try {
      const distributor = requestedDistributor;
      const actorUserId = req.auth?.sub ?? 'anonymous';
      const activeTenantId = governanceActor(req).tenantId;
      const consent = await distributorLink.assertReadConsent(
        { tenantId: activeTenantId }, b.consentId,
        {
          distributor,
          provider: 'steel',
          actorUserId,
          minimumRemainingMs: requiredConsentRemainingMs(process.env),
        },
      );
      // Workspace authority comes only from the validated grant. Artist display names are
      // untrusted labels and must never be transformed into an authorization boundary.
      const authorizedWorkspace = await authorizeWorkspace(req, reply, consent.artistWorkspaceId, 'EDIT');
      if (!authorizedWorkspace) return;
      const artistWorkspaceId = authorizedWorkspace.workspaceId;
      await audit.log({
        tenantId: activeTenantId,
        workspaceId: artistWorkspaceId,
        actorUserId: req.auth?.sub ?? null,
        action: 'distributor.connect.requested',
        targetType: 'SteelSession',
        targetId: b.consentId,
        metadata: { distributor, artistCount: artists.length, provider: 'steel' },
      });
      return await connect.start(distributor, artists, {
        tenantId: activeTenantId,
        ownerUserId: actorUserId,
        consentId: b.consentId,
        artistWorkspaceId,
      });
    } catch (err) {
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'could not start distributor login');
      return reply.status(502).send({ error: 'could not start distributor login' });
    }
  });
  /**
   * Consume an attended-login session and start the read.
   *
   * Authenticated AND ownership-checked. The connect id was previously the only thing needed to
   * consume a live, logged-in distributor session — a bearer capability in a URL path, which ends
   * up in browser history, referrers, proxy logs and client state. High entropy doesn't change
   * what it is: possession of the string was authorization to read someone's catalogue.
   */
  app.post('/api/connect/:id/scan', { preHandler: requireRole('artist_manager', 'tenant_admin') }, async (req, reply) => {
    try {
      const connectId = (req.params as { id: string }).id;
      const activeTenantId = governanceActor(req).tenantId;
      await audit.log({
        tenantId: activeTenantId,
        actorUserId: req.auth?.sub ?? null,
        action: 'distributor.scan.requested',
        targetType: 'SteelSession',
        targetId: connectId,
      });
      return await connect.confirmAndScan(connectId, {
        tenantId: activeTenantId,
        actorUserId: req.auth?.sub ?? 'anonymous',
        // Confirmation is always owner-only; this flag is ignored for confirm inside the registry.
        allowTenantAdmin: await organizationAdministrator(req),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'ConnectSessionOwnershipError') {
        // Same shape as an unknown id: confirming that someone else's session exists would make
        // this an oracle for other tenants' in-flight logins.
        return reply.status(404).send({ error: 'unknown or expired connect session' });
      }
      if (err instanceof Error && err.name === 'ConnectWorkspaceAuthorizationError') {
        return reply.status(403).send({ error: 'workspace access denied' });
      }
      if (err instanceof Error && err.name === 'ConnectWorkspaceAuthorizationUnavailableError') {
        return reply.status(503).send({ error: 'workspace authorization unavailable' });
      }
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'catalogue read/scan failed');
      return reply.status(502).send({ error: 'catalogue read/scan failed' });
    }
  });

  app.post('/api/connect/:id/cancel', { preHandler: requireRole('artist_manager', 'tenant_admin') }, async (req, reply) => {
    try {
      const connectId = (req.params as { id: string }).id;
      const activeTenantId = governanceActor(req).tenantId;
      // Start the audit write, but never place it in front of the emergency release call. A
      // degraded audit sink must not keep an authenticated Steel browser alive.
      void audit.log({
        tenantId: activeTenantId,
        actorUserId: req.auth?.sub ?? null,
        action: 'distributor.connect.cancel.requested',
        targetType: 'SteelSession',
        targetId: connectId,
      }).catch((err) => app.log.error(
        { errorType: err instanceof Error ? err.name : 'Error' },
        'distributor cancellation request audit failed',
      ));
      await connect.cancel(connectId, {
        tenantId: activeTenantId,
        actorUserId: req.auth?.sub ?? 'anonymous',
        allowTenantAdmin: await organizationAdministrator(req),
      });
      return reply.status(204).send();
    } catch (err) {
      if (err instanceof Error && (
        err.name === 'ConnectSessionOwnershipError'
        || err.message === 'unknown or expired connect session'
      )) {
        return reply.status(404).send({ error: 'unknown or expired connect session' });
      }
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'could not cancel distributor login');
      return reply.status(502).send({ error: 'could not cancel distributor login' });
    }
  });

  app.post('/api/distributor-imports/csv', { preHandler: [requireRole('artist_manager', 'tenant_admin'), requireCustomerScanPrincipal] }, async (req, reply) => {
    // Safe fallback: import an uploaded distributor export (e.g. DistroKid's "Download
    // CSV") without any automation. This is the authoritative released set — its
    // release-level metadata (label, UPC, release/upload dates) carries through to the
    // catalogue. With `save`, we scan it against the stores and persist a search record.
    const b = (req.body ?? {}) as {
      distributor?: string;
      artistWorkspaceId?: unknown;
      artistName?: string;
      csvText?: string;
      save?: boolean;
    };
    if (!b.csvText) return reply.status(400).send({ error: 'csvText required' });
    const distributor = (b.distributor ?? 'distrokid').trim();
    const tenantId = req.auth?.tenantId ?? 'default';
    const personalWorkspace = personalArtistWorkspaceId(tenantId, req.auth?.sub ?? 'anonymous');
    const workspaceAccess = deps.organization
      ? await authorizeWorkspace(req, reply, b.artistWorkspaceId, 'EDIT')
      : { workspaceId: personalWorkspace, tenantId };
    if (!workspaceAccess) return;
    await audit.log({
      tenantId: workspaceAccess.tenantId,
      workspaceId: workspaceAccess.workspaceId,
      actorUserId: req.auth?.sub ?? null,
      action: 'distributor-import.csv.requested',
      targetType: 'DistributorImport',
      metadata: { distributor, save: Boolean(b.save), byteLength: Buffer.byteLength(b.csvText, 'utf8') },
    });
    const parser = new GenericCsvDistributorAdapter(distributor as never);
    const snap = parser.parseCatalog(b.csvText, b.artistName ?? null);
    const trackCount = snap.releases.reduce((n, r) => n + r.tracks.length, 0);
    await audit.log({
      tenantId: workspaceAccess.tenantId,
      workspaceId: workspaceAccess.workspaceId,
      actorUserId: req.auth?.sub ?? null,
      action: 'distributor-import.csv',
      targetType: 'DistributorImport',
      targetId: null,
      metadata: { releases: snap.releases.length, save: Boolean(b.save) },
    });
    if (!b.save) {
      return { releases: snap.releases.length, tracks: trackCount, warnings: snap.warnings };
    }
    const artist = (b.artistName ?? snap.artistName ?? '').trim();
    if (!artist) return reply.status(400).send({ error: 'artistName is required to save an imported catalogue' });
    // Flatten releases → released tracks, carrying the release-level metadata onto each track.
    const released = snap.releases.flatMap((r) =>
      r.tracks.map((t) => ({
        title: t.title,
        primaryArtist: t.primaryArtist || artist,
        isrc: t.isrc ?? null,
        releaseTitle: r.title,
        label: r.label,
        upc: r.upc,
        releaseDate: r.releaseDate,
        uploadDate: r.uploadDate,
      })),
    );
    const result = await (deps.runReleasedCatalogScan ?? scanReleasedCatalog)(artist, released);
    const scoped = await forPrincipal(req, reply, workspaceAccess.tenantId);
    if (!scoped) return;
    const rec = await scoped.saveInAuthorizedWorkspace(
      workspaceAccess.workspaceId,
      { artist, distributor, platforms: result.stores },
      result,
      released,
    );
    await enqueueDeepScan(rec.id, workspaceAccess.tenantId).catch((err) => app.log.error({ err }, 'enqueue deep scan failed'));
    return { searchId: rec.id, releases: snap.releases.length, tracks: trackCount, warnings: snap.warnings };
  });

  return app;
}
