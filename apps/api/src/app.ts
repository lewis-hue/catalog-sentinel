import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import {
  InsecureConfigurationError,
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
  createLyricsProducer,
  connectionFromUrl,
} from '@sentinel/queue-client';
import { PostgresCandidateStore, DistroKidOutcomeRepository } from '@sentinel/persistence';
import type { CandidateSink, StoredCandidate } from '@sentinel/contracts';
import { resolveCorsOrigin } from './cors';
import {
  DistributorConnect,
  RedisConnectSessionRegistry,
  sessionReuseEnabled,
  type ConnectSessionRegistry,
  type ConnectSessionRedis,
} from './distributor-connect';
import { ScanCandidateStore } from './endpoint-candidates';
import { registerAuth, requireAuth, requireRole } from './auth';
import {
  deleteKeycloakUser,
  fetchKeycloakUsername,
  purgeUserData,
  updateKeycloakUsername,
  UsernameConflictError,
  UsernameInvalidError,
  type SqlPool,
} from './account-deletion';
import {
  hasCustomerScanAccess,
  InvalidSearchHistoryPageError,
  parseSearchHistoryPageLimit,
  SEARCH_HISTORY_NEXT_CURSOR_HEADER,
  UserBoundSearchStore,
  UserScopedSearchStore,
} from './tenant-scoped-search-store';
import { HealthChecker } from './health';
import { GenericCsvDistributorAdapter, assertSearchProviderConfig } from '@sentinel/adapters';
import { consumeFixedWindow, productionRateLimitConfig, type RateLimitRedis } from './rate-limit';
import { activeSearchStage, isActiveSearch, validateScanName } from './scan-history';
import {
  DistroKidRecoveryAlreadyTerminalError,
  PostgresDistroKidRecoveryRepository,
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
  enqueueDeepScan?: (searchId: string, userId: string) => Promise<void>;
  enqueueLyricsCheck?: (searchId: string, userId: string) => Promise<void>;
  /** Test/composition seam for the Postgres outcome repo the catalogue + lyrics-check + marks use. */
  catalogueRepo?: Pick<DistroKidOutcomeRepository, 'readCatalogue' | 'setStoreLyricsProgress' | 'readStoreLyricsProgress' | 'updateTrackMarks'>;
  runFastCatalogScan?: typeof runCatalogScan;
  runReleasedCatalogScan?: typeof scanReleasedCatalog;
  /** Test/composition seam for a concrete OIDC verifier key and issuer. */
  authConfig?: Partial<KeycloakAuthConfig>;
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
    '/api/account',
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
    req: { auth?: { sub?: string }; headers?: Record<string, unknown> },
    reply: { header(name: string, value: string): unknown; status(code: number): { send(payload: unknown): unknown } },
    bucket: 'consent' | 'connect',
  ): Promise<boolean> => {
    if (!isProductionEnvironment(process.env)) return true;
    if (!rateLimitRedis) {
      reply.status(503).send({ error: 'request capacity control is unavailable' });
      return false;
    }
    try {
      // Per-user isolation: the rate-limit key is the verified subject alone.
      const subject = req.auth?.sub?.trim() ?? '';
      if (!subject) {
        reply.status(401).send({ error: 'authentication required' });
        return false;
      }
      const decision = await consumeFixedWindow(
        rateLimitRedis,
        rateLimits.prefix,
        bucket,
        subject,
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
    // preflight rejects every authenticated request without it, so auth would appear "broken"
    // for reasons invisible in the API's own logs, since the request never arrives.
    //
    // The origin is not `*` in production: a wildcard invites any site to call this API with the
    // user's credentials. If APP_BASE_URL isn't set we send no ACAO header at all, same-origin
    // deployments (the Compose setup proxies /api through the web origin) don't need one, and a
    // missing header fails closed instead of open.
    const corsOrigin = resolveCorsOrigin(process.env);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (corsOrigin && (corsOrigin === '*' || requestOrigin === corsOrigin)) {
      reply.header('Access-Control-Allow-Origin', corsOrigin);
    }
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Headers', 'content-type, authorization, x-request-id, idempotency-key, traceparent');
    reply.header('Access-Control-Expose-Headers', 'x-sentinel-next-cursor');
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
  // Per-user isolation: there is no organization, workspace, or tenant selector. The verified
  // Keycloak subject (`req.auth.sub`) is the ONLY scope key. Every scoped route derives its owner
  // from it, never from a header or a request body, and refuses to proceed without a non-empty one.
  const requireSubject = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const sub = req.auth?.sub?.trim();
    if (!sub) {
      reply.status(401).send({ error: 'authentication required' });
      return null;
    }
    return sub;
  };
  app.post('/api/consent', { preHandler: requireRole('user') }, async (req, reply) => {
    if (!await enforceProductionRateLimit(req, reply, 'consent')) return;
    const userId = requireSubject(req, reply);
    if (!userId) return;
    const ctx = { tenantId: userId };
    const b = (req.body ?? {}) as { distributor?: string; scope?: string; provider?: string };
    const distributor = typeof b.distributor === 'string' ? b.distributor.trim().toLowerCase() : '';
    if (distributor !== 'distrokid') return reply.status(400).send({ error: 'only DistroKid is supported by the active connect flow' });
    if (b.scope !== 'distributor:read-catalog') return reply.status(400).send({ error: 'scope must be distributor:read-catalog' });
    const provider = b.provider === 'steel' ? 'steel' : null;
    if (!provider) return reply.status(400).send({ error: 'provider must be steel' });
    await audit.log({
      tenantId: userId,
      actorUserId: userId,
      action: 'consent.grant.requested',
      targetType: 'ConsentGrant',
      metadata: { distributor, scope: b.scope, provider },
    });
    const c = await distributorLink.grantConsent(ctx, {
      distributor, scope: b.scope, provider, actorUserId: userId,
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

  app.post('/api/consent/:id/revoke', { preHandler: requireRole('user') }, async (req, reply) => {
    const userId = requireSubject(req, reply);
    if (!userId) return;
    const ctx = { tenantId: userId };
    const consentId = (req.params as { id: string }).id;
    const revocationActor = {
      actorUserId: userId,
      // Per-user isolation: only the granting subject can revoke. There is no tenant-admin override.
      allowTenantAdmin: false,
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
  const lyricsProducer = redis && redisUrl ? createLyricsProducer(connectionFromUrl(redisUrl)) : null;
  // Sanitized endpoint candidates observed during scans (served by the admin route below).
  //
  // Durable in every deployment. The process-local implementation is reachable only from an
  // isolated test composition that deliberately omits PostgreSQL.
  const candidateStore: CandidateSink & { list(t: string, s: string): Promise<StoredCandidate[]> | StoredCandidate[] } =
    built.pgPool ? new PostgresCandidateStore(built.pgPool) : new ScanCandidateStore();
  if (!built.pgPool) app.log.warn('Test-only endpoint candidate store is process-local.');
  // Read-back of the pure scraped catalogue (releases + tracks + metadata + art), decoupled from
  // store-presence verification, the standalone foundation the Catalogue dashboard reads.
  const catalogueRepo = deps.catalogueRepo ?? (built.pgPool ? new DistroKidOutcomeRepository(built.pgPool) : null);
  // Catalogue-read DISPATCH.
  //
  // `pipeline` is the DEFAULT whenever Redis is present, because it is the only path with crash
  // recovery, failed-release-only retry and durable finalization. The others exist for a dev box
  // with no Redis and for emergency rollback, they are not equivalent, and defaulting to the
  // weaker one meant the durable pipeline was "available" but effectively unused.
  app.log.info('Catalogue read dispatch: durable network-first pipeline');
  // Enqueues onto `distrokid-catalog-index`, which the worker's six-stage pipeline consumes. Via
  // @sentinel/queue-client so the API never imports the worker application to queue work.
  const dkRecovery = built.pgPool
    ? new PostgresDistroKidRecoveryRepository(built.pgPool)
    : null;
  if (process.env.NODE_ENV !== 'test' && !dkRecovery) {
    throw new Error('PostgreSQL DistroKid recovery authority is required outside the test runtime.');
  }
  const dkProducer = redis && redisUrl
    ? createDistroKidProducer(connectionFromUrl(redisUrl), {
        env: process.env,
        ...(dkRecovery ? {
          prepareJob: async (job) => {
            try {
              return await dkRecovery.prepare(job);
            } catch (error) {
              if (error instanceof DistroKidRecoveryAlreadyTerminalError) return null;
              throw error;
            }
          },
        } : {}),
      })
    : null;
  if (dkProducer) app.log.info('DistroKid network-first pipeline producer attached (queue "distrokid-catalog-index").');

  app.addHook('onClose', async () => {
    if (connectRecoveryTimer) clearInterval(connectRecoveryTimer);
    if (consentRevocationTimer) clearInterval(consentRevocationTimer);
    // Do not close Prisma/Redis underneath an in-flight lease owner. The outer graceful-shutdown
    // deadline remains the hard bound if an external release call does not return.
    if (consentRevocationRecovery) await consentRevocationRecovery;
    await Promise.allSettled([
      presenceProducer?.close() ?? Promise.resolve(),
      lyricsProducer?.close() ?? Promise.resolve(),
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
  app.get('/health/dependencies', { preHandler: requireRole('platform_admin') }, async () => health.dependencies());
  app.get('/api/search-provider/status', { preHandler: requireRole('platform_admin') }, async () => health.searchProviderStatus());
  app.get('/api/platforms/credential-status', { preHandler: requireRole('platform_admin') }, async () => ({ platforms: health.credentialStatus() }));
  app.get('/api/queues/status', { preHandler: requireRole('platform_admin') }, async () => health.queue());
  /**
   * Which extraction ENGINE this deployment actually uses.
   *
   * Exposed because "the pipeline is wired" was true of the code and false of the deployment for
   * an entire review cycle: dispatch was opt-in, so the durable path existed but nothing selected
   * it. A reader should be able to see which engine will run without grepping env vars.
   */
  app.get('/api/catalogue/engine', { preHandler: requireRole('platform_admin') }, async () => ({
    dispatch: 'pipeline',
    reason: null,
    engine: 'NETWORK_FIRST',
    durable: true,
    resumable: true,
    retryFailedOnly: true,
    queue: 'distrokid-catalog-index',
  }));
  // Ranked, SANITIZED endpoint candidates observed during a scan, this is what removes the
  // manual "read the logs and hard-code a URL" step. Never returns cookies, headers, tokens,
  // query/POST values or response bodies: only endpoint shape + schema key names.
  app.get('/api/admin/distributor-scans/:scanId/endpoint-candidates', { preHandler: requireRole('platform_admin') }, async (req) => {
    const { scanId } = req.params as { scanId: string };
    // Per-user scoped: a caller can only ever read candidates recorded under its OWN subject.
    const userId = req.auth.sub;
    const candidates = await candidateStore.list(userId, scanId);
    await audit.log({ tenantId: userId, action: 'distributor.endpoint-candidates.read', targetType: 'DistributorScan', targetId: scanId, metadata: { candidates: candidates.length } });
    return { scanId, userId, candidates };
  });
  // Steel Browser connector status. Safe status only, the
  // API URL is host-only redacted and no secrets, session ids, viewer URLs, or deprecated
  // local-browser alternatives are returned.
  app.get('/api/integrations/steel/status', { preHandler: requireAuth() }, async () => health.distributorLogin());
  // Kick off the background multi-platform deep scan through the BullMQ worker. The API never
  // executes catalogue scans in its request process.
  const enqueueDeepScan = async (searchId: string, userId: string): Promise<boolean> => {
    const dispatch = deps.enqueueDeepScan
      ? () => deps.enqueueDeepScan!(searchId, userId)
      : presenceProducer
        ? () => presenceProducer.enqueue(searchId, userId)
        : null;
    if (dispatch) {
      const scopedQueueStore = new UserBoundSearchStore(searchStore, userId);
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
    // never progress past its fast pass, the user would just watch it never fill in.
    app.log.warn({ searchId }, 'deep scan unavailable: no presence queue configured and no inline runner injected');
    return false;
  };

  // Enqueue the fault-isolated store-lyrics check (LRCLIB) on its own queue. Marks the snapshot's
  // Postgres progress `queued` (NOT the search record) and rolls back to `error` if dispatch fails -
  // so the check shares no state with the store-presence scan and the two never contend.
  const enqueueLyricsCheck = async (searchId: string, tenantId: string): Promise<boolean> => {
    const dispatch = deps.enqueueLyricsCheck
      ? () => deps.enqueueLyricsCheck!(searchId, tenantId)
      : lyricsProducer
        ? () => lyricsProducer.enqueue(searchId, tenantId)
        : null;
    if (!dispatch) {
      app.log.warn({ searchId }, 'lyrics check unavailable: no lyrics queue configured and no inline runner injected');
      return false;
    }
    if (!catalogueRepo) {
      app.log.warn({ searchId }, 'lyrics check unavailable: no outcome store configured');
      return false;
    }
    await catalogueRepo.setStoreLyricsProgress(tenantId, searchId, { status: 'queued' });
    try {
      await dispatch();
      return true;
    } catch (error) {
      await catalogueRepo
        .setStoreLyricsProgress(tenantId, searchId, { status: 'error', error: 'Lyric check could not be queued.' })
        .catch(() => null);
      throw error;
    }
  };

  app.post('/api/searches', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; artist?: string; distributor?: string; platforms?: string[]; song?: { title?: string; isrc?: string } };
    const artist = (b.artist ?? '').trim();
    if (!artist) return reply.status(400).send({ error: 'artist is required' });
    const parsedName = b.name === undefined ? null : validateScanName(b.name);
    if (parsedName && !parsedName.ok) return reply.status(400).send({ error: parsedName.error });
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const userId = req.auth.sub;
    try {
      await audit.log({
        tenantId: userId,
        actorUserId: userId,
        action: 'catalog.search.requested',
        targetType: 'CatalogSearch',
        metadata: { distributor: (b.distributor ?? 'distrokid').trim(), platformCount: b.platforms?.length ?? 0 },
      });
      // Fast pass (Deezer + Apple, whole catalogue, ~1s) so the request never blocks on
      // rate-limited web queries, then enqueue the background deep scan for the rest.
      const result = await (deps.runFastCatalogScan ?? runCatalogScan)(artist, { fast: true });
      const released = result.tracks.map((t) => ({ title: t.title, primaryArtist: artist, isrc: t.isrc }));
      // `scoped.save` stamps the owning userId; no client value can override it.
      const rec = await scoped.save({
        ...(parsedName?.ok ? { name: parsedName.name } : {}),
        artist,
        distributor: (b.distributor ?? 'distrokid').trim(),
        platforms: b.platforms,
        song: b.song ?? null,
      }, result, released);
      await enqueueDeepScan(rec.id, userId).catch((err) => app.log.error({ err }, 'enqueue deep scan failed'));
      reply.status(201);
      return { id: rec.id, createdAt: rec.createdAt, result: rec.result };
    } catch (err) {
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'catalog search failed');
      return reply.status(502).send({ error: 'search failed' });
    }
  });
  /**
   * Every read below goes through `forPrincipal(...)`, which binds the verified OIDC subject once.
   * A record is visible/writable iff `record.userId === req.auth.sub`; there is no cross-user
   * visibility, no admin override, and no shared workspace.
   *
   * Before this, `list()` returned EVERY user's searches to every caller and `get(id)` fetched by
   * id alone, so an authenticated user could read another user's artists, unreleased catalogue and
   * ISRCs by knowing a search id.
   *
   * Returns null (after replying 401) when the request carries no non-empty subject, so a principal
   * with an empty `sub` can never be treated as an owner of ownerless records.
   */
  const forPrincipal = (req: FastifyRequest, reply: FastifyReply): UserScopedSearchStore | null => {
    const sub = req.auth?.sub?.trim();
    if (!sub) {
      reply.status(401).send({ error: 'authentication required' });
      return null;
    }
    return new UserScopedSearchStore(searchStore, {
      sub,
      roles: req.auth.roles,
      authenticated: req.auth.authenticated,
    });
  };

  app.get('/api/searches', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const query = req.query as { limit?: unknown; cursor?: unknown };
    try {
      const limit = parseSearchHistoryPageLimit(query.limit);
      if (query.cursor !== undefined && typeof query.cursor !== 'string') throw new InvalidSearchHistoryPageError();
      const scoped = forPrincipal(req, reply);
      if (!scoped) return;
      const page = await scoped.listPage(limit, query.cursor);
      if (page.nextCursor) reply.header(SEARCH_HISTORY_NEXT_CURSOR_HEADER, page.nextCursor);
      reply.header('cache-control', 'private, no-store, max-age=0');
      // Preserve the established response body so existing clients continue to receive an array.
      return { searches: page.items };
    } catch (error) {
      if (error instanceof InvalidSearchHistoryPageError) {
        return reply.status(400).send({ error: 'invalid search history pagination' });
      }
      throw error;
    }
  });
  app.get('/api/searches/:id', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const rec = await scoped.get((req.params as { id: string }).id);
    // 404 (not 403) for another tenant's id: a 403 would confirm the id exists, turning
    // id-guessing into an enumeration oracle over other tenants' scans.
    if (!rec) return reply.status(404).send({ error: 'search not found' });
    return rec;
  });

  // The PURE scraped DistroKid catalogue for a scan, releases + metadata + cover art + tracks +
  // ISRCs, read from the authoritative outcome tables, independent of store-presence verification.
  // This is the standalone foundation the Catalogue dashboard renders and exports.
  app.get('/api/searches/:id/catalogue', { preHandler: [requireAuth(), requireCustomerScanPrincipal] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    // Access + enumeration guard: 404 (never 403) if the caller cannot see this search.
    const rec = await scoped.get(id);
    if (!rec) return reply.status(404).send({ error: 'search not found' });
    if (!catalogueRepo) return reply.status(503).send({ error: 'catalogue store unavailable' });
    const catalogue = await catalogueRepo.readCatalogue(req.auth.sub, id);
    if (!catalogue) return reply.status(404).send({ error: 'no scraped catalogue for this search' });
    return catalogue;
  });

  // The caller's own account: identity claims from the verified token (never trusted from the client).
  // Powers the Profile page. The username is read fresh from Keycloak so an in-app edit shows
  // immediately (the caller's JWT keeps the old username until they sign in again); everything else
  // comes from the verified token. Falls back to the token claim if the admin API is unavailable.
  app.get('/api/account', { preHandler: [requireAuth()] }, async (req, reply) => {
    if (!req.auth?.authenticated) return reply.status(401).send({ error: 'authentication required' });
    const fresh = req.auth.sub ? await fetchKeycloakUsername(process.env, req.auth.sub) : null;
    return {
      subject: req.auth.sub,
      username: fresh ?? req.auth.username ?? null,
      email: req.auth.email ?? null,
      emailVerified: req.auth.emailVerified,
      identityProvider: req.auth.identityProvider ?? null,
      roles: req.auth.roles,
    };
  });

  // Edit the caller's own username (the only self-editable identity field; email is read-only because
  // it is the federated identity anchor). Validated here, then written to Keycloak; a taken username
  // is a 409, a rejected one a 400. Requires the realm's editUsernameAllowed (kept true by keycloak-init).
  app.patch('/api/account', { preHandler: [requireRole('user')] }, async (req, reply) => {
    const userId = req.auth?.sub;
    if (!userId) return reply.status(401).send({ error: 'authentication required' });
    const body = (req.body ?? {}) as { username?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    if (username.length < 3 || username.length > 255) {
      return reply.status(400).send({ error: 'Username must be between 3 and 255 characters.' });
    }
    try {
      await updateKeycloakUsername(process.env, userId, username);
      void audit.log({ tenantId: userId, actorUserId: userId, action: 'account.username_updated', targetType: 'Account', targetId: userId, metadata: {} });
      return { username };
    } catch (error) {
      if (error instanceof UsernameConflictError) return reply.status(409).send({ error: 'That username is already taken.' });
      if (error instanceof UsernameInvalidError) {
        return reply.status(400).send({ error: 'That username is not allowed. Please try a different one.' });
      }
      app.log.error({ errorType: error instanceof Error ? error.name : 'Error' }, 'account username update failed');
      return reply.status(502).send({ error: 'Could not update your username. Please try again.' });
    }
  });

  // Full account deletion: erase all of the caller's data, then remove their Keycloak login.
  // Irreversible. Runs the purge in one transaction; the append-only audit trail is retained.
  app.delete('/api/account', { preHandler: [requireRole('user')] }, async (req, reply) => {
    const userId = req.auth?.sub;
    if (!userId) return reply.status(401).send({ error: 'authentication required' });
    if (!built.pgPool) return reply.status(503).send({ error: 'account deletion is unavailable' });
    try {
      await purgeUserData(built.pgPool as unknown as SqlPool, userId);
      await deleteKeycloakUser(process.env, userId);
      void audit.log({ tenantId: userId, actorUserId: userId, action: 'account.deleted', targetType: 'Account', targetId: userId, metadata: {} });
      reply.status(204);
      return null;
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : 'Error' }, 'account deletion failed');
      return reply.status(502).send({ error: 'Account deletion could not be completed. Please try again or contact support.' });
    }
  });

  // ON-DEMAND store-presence verification for an already-scraped catalogue. Scraping is decoupled
  // from verification (SCAN_STORE_PRESENCE_AUTO defaults off), so this is how the "Missing Songs"
  // module starts a check, in place, on THIS record, so its per-store results join back to the
  // same catalogue the dashboard renders. Repeatable: the retained queue job is cleared and
  // progress reset so each trigger runs a full re-scan.
  app.post('/api/searches/:id/store-check', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const activeTenantId = req.auth.sub;
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const source = await scoped.get(id);
    if (!source) return reply.status(404).send({ error: 'search not found' });
    // The scrape must have finished before we verify what it produced.
    if (isActiveSearch(source)) {
      return reply.status(409).send({ error: 'the catalogue scan is still in progress', status: activeSearchStage(source) });
    }
    // Never stack a second run on top of one already in flight.
    const inFlight = source.deepScan?.status;
    if (inFlight === 'queued' || inFlight === 'running') {
      return reply.status(409).send({ error: 'a store-presence check is already in progress', status: inFlight });
    }
    // No verified tracks means there is nothing to look for across the stores.
    if (!source.released?.length && !source.result.tracks?.length) {
      return reply.status(422).send({ error: 'this catalogue has no verified tracks to check' });
    }
    // Clear any retained job for this id, then reset progress so the whole catalogue is re-checked
    // (drops platformsDone / platformTracksVerified). enqueueDeepScan then flips it to 'queued' and
    // dispatches, rolling the record back to 'error' if the dispatch itself fails.
    if (presenceProducer) await presenceProducer.remove(id);
    await scoped.update(id, (record) => ({
      ...record,
      deepScan: { status: 'idle', platformsPending: [], platformsDone: [], updatedAt: new Date().toISOString() },
    }));
    try {
      const queued = await enqueueDeepScan(id, activeTenantId);
      if (!queued) return reply.status(503).send({ error: 'store-presence check is unavailable' });
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : 'Error', searchId: id }, 'store-presence check queue failed');
      return reply.status(503).send({ error: 'store-presence check could not be queued' });
    }
    const queuedRecord = await scoped.get(id);
    await audit.log({
      tenantId: activeTenantId,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.store-check.triggered',
      targetType: 'CatalogSearch',
      targetId: id,
      metadata: { mode: 'on_demand_store_presence' },
    });
    reply.status(202);
    return { id, operation: 'STORE_PRESENCE_CHECK', deepScan: queuedRecord?.deepScan };
  });

  // ON-DEMAND lyric-availability verification (LRCLIB) for a scraped catalogue. A fault-isolated
  // microservice, independent of the store-presence check (they can run concurrently): only the
  // scrape reading state blocks it. Repeatable in place (results join back to the same catalogue).
  app.post('/api/searches/:id/lyrics-check', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const activeTenantId = req.auth.sub;
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const source = await scoped.get(id);
    if (!source) return reply.status(404).send({ error: 'search not found' });
    if (!catalogueRepo) return reply.status(503).send({ error: 'lyrics check is unavailable' });
    // Only the scrape itself blocks a lyrics check, NOT a running store-presence scan (independent).
    if (source.result.warnings.includes('__reading_in_progress__')) {
      return reply.status(409).send({ error: 'the catalogue scan is still in progress', status: 'reading_distributor_catalog' });
    }
    // "Already running" is read from the snapshot's Postgres progress, the check writes there, not
    // the search record, so it never collides with a concurrent store-presence scan.
    const progress = await catalogueRepo.readStoreLyricsProgress(activeTenantId, id);
    if (progress && (progress.status === 'queued' || progress.status === 'running')) {
      return reply.status(409).send({ error: 'a lyrics check is already in progress', status: progress.status });
    }
    if (!source.result.tracks?.length) {
      return reply.status(422).send({ error: 'this catalogue has no tracks to check' });
    }
    if (lyricsProducer) await lyricsProducer.remove(id);
    try {
      const queued = await enqueueLyricsCheck(id, activeTenantId);
      if (!queued) return reply.status(503).send({ error: 'lyrics check is unavailable' });
    } catch (error) {
      app.log.error({ errorType: error instanceof Error ? error.name : 'Error', searchId: id }, 'lyrics check queue failed');
      return reply.status(503).send({ error: 'lyrics check could not be queued' });
    }
    const queued = await catalogueRepo.readStoreLyricsProgress(activeTenantId, id);
    await audit.log({
      tenantId: activeTenantId,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.lyrics-check.triggered',
      targetType: 'CatalogSearch',
      targetId: id,
      metadata: { mode: 'on_demand_lyrics_verification', source: 'serper' },
    });
    reply.status(202);
    return { id, operation: 'LYRICS_CHECK', lyricsScan: queued };
  });

  // Lightweight progress poll for the store-lyrics check. Reads only the snapshot's progress row
  // (not the full catalogue), so the UI can poll cheaply while the check runs.
  app.get('/api/searches/:id/lyrics-check', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const activeTenantId = req.auth.sub;
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const source = await scoped.get(id);
    if (!source) return reply.status(404).send({ error: 'search not found' });
    if (!catalogueRepo) return { id, lyricsScan: null };
    const progress = await catalogueRepo.readStoreLyricsProgress(activeTenantId, id);
    return { id, lyricsScan: progress };
  });

  // Bulk manual track marks, the user curates the missing-songs list from the store-health grid
  // (mark selected songs 'missing' / 'resolved', or clear). A pure annotation on top of the
  // automated verdict; never mutates the distributor. Body: { marks: [{ releaseId, trackIndex, mark }] }.
  app.post('/api/searches/:id/track-marks', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const activeTenantId = req.auth.sub;
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const source = await scoped.get(id);
    if (!source) return reply.status(404).send({ error: 'search not found' });
    if (!catalogueRepo) return reply.status(503).send({ error: 'track marks are unavailable' });

    const body = (req.body ?? {}) as { marks?: unknown };
    if (!Array.isArray(body.marks) || body.marks.length === 0) {
      return reply.status(422).send({ error: 'provide a non-empty marks array' });
    }
    if (body.marks.length > 5000) {
      return reply.status(413).send({ error: 'too many marks in one request (max 5000)' });
    }
    const ALLOWED = new Set(['missing', 'resolved']);
    const marks: Array<{ releaseId: string; trackIndex: number; mark: string | null; note?: string | null }> = [];
    for (const raw of body.marks as Array<Record<string, unknown>>) {
      const releaseId = typeof raw.releaseId === 'string' ? raw.releaseId : null;
      const trackIndex = typeof raw.trackIndex === 'number' && Number.isInteger(raw.trackIndex) ? raw.trackIndex : null;
      // `mark` null/'' clears the mark; otherwise it must be one of the allowed states.
      const markRaw = raw.mark;
      const mark = markRaw === null || markRaw === '' || markRaw === undefined ? null : String(markRaw);
      if (!releaseId || trackIndex === null || (mark !== null && !ALLOWED.has(mark))) {
        return reply.status(422).send({ error: 'each mark needs releaseId, trackIndex and a valid mark (missing|resolved|null)' });
      }
      const note = typeof raw.note === 'string' ? raw.note.slice(0, 500) : null;
      marks.push({ releaseId, trackIndex, mark, note });
    }

    const updated = await catalogueRepo.updateTrackMarks(activeTenantId, id, marks);
    await audit.log({
      tenantId: activeTenantId,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.track-marks.updated',
      targetType: 'CatalogSearch',
      targetId: id,
      metadata: { count: marks.length, updated },
    });
    return { id, updated };
  });

  app.patch('/api/searches/:id', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const searchId = (req.params as { id: string }).id;
    const parsedName = validateScanName((req.body as { name?: unknown } | null)?.name);
    if (!parsedName.ok) return reply.status(400).send({ error: parsedName.error });
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const updated = await scoped.update(searchId, (record) => ({ ...record, name: parsedName.name }));
    if (!updated) return reply.status(404).send({ error: 'search not found' });
    await audit.log({
      tenantId: req.auth.sub,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.renamed',
      targetType: 'CatalogSearch',
      targetId: searchId,
      metadata: { revision: updated.revision ?? null },
    });
    return { id: updated.id, name: updated.name, revision: updated.revision };
  });

  app.delete('/api/searches/:id', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const searchId = (req.params as { id: string }).id;
    const scoped = forPrincipal(req, reply);
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
      tenantId: req.auth.sub,
      actorUserId: req.auth?.sub ?? null,
      action: 'catalog.search.deleted',
      targetType: 'CatalogSearch',
      targetId: searchId,
      metadata: { terminalStatus: existing.deepScan?.status ?? 'idle' },
    });
    return reply.status(204).send();
  });

  app.post('/api/searches/:id/rescan', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const sourceSearchId = (req.params as { id: string }).id;
    const activeTenantId = req.auth.sub;
    const scoped = forPrincipal(req, reply);
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
    // `saveDerived` preserves the source's immutable owner (userId) on the child history entry.
    const rescanned = await scoped.saveDerived(source, {
      ...(parsedName?.ok ? { name: parsedName.name } : {}),
      sourceSearchId,
      artist: source.artist,
      distributor: source.distributor,
      platforms: [...source.platforms],
      song: source.song ? { ...source.song } : null,
      result,
      released,
    });

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
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const rec = await scoped.get((req.params as { id: string }).id);
    if (!rec) return reply.status(404).send({ error: 'search not found' });
    const includeResolved = /^(1|true|yes)$/i.test(((req.query as { resolved?: string }).resolved) ?? '');
    const items = deriveManualReviewItems(rec, { includeResolved });
    return { scanId: rec.id, artist: rec.artist, open: items.filter((i) => !i.resolved).length, items };
  });

  app.patch('/api/searches/:id/manual-review/:itemId', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = (req.body ?? {}) as { decision?: string; notes?: string };
    const decision = body.decision as ManualReviewDecision;
    if (!MANUAL_REVIEW_DECISIONS.includes(decision)) {
      return reply.status(400).send({ error: `decision must be one of ${MANUAL_REVIEW_DECISIONS.join(', ')}` });
    }
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const existing = await scoped.get(id);
    if (!existing) return reply.status(404).send({ error: 'search not found' });
    await audit.log({
      tenantId: req.auth.sub,
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

  // Redact URIs, connection strings, and id-like tokens from a downstream error message before it is
  // logged as a diagnostic "reason", so a wrapped library error cannot leak session IDs, redis URIs,
  // or URL userinfo/query strings. Keeps the human-readable prefix, drops the sensitive parts.
  function redactErrorDetail(message: string): string {
    return message
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")]+/gi, '[uri]')
      .replace(/\b(?:connect|search|scan|sess|steel|job)[_-][A-Za-z0-9-]{6,}\b/gi, '[id]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
      .slice(0, 300);
  }

  // --- One-click "connect distributor & scan" (cloud browser) -------------
  const connectRegistry = built.redis
    ? new RedisConnectSessionRegistry(
        built.redis as unknown as ConnectSessionRedis,
        process.env.CONNECT_SESSION_PREFIX ?? `sentinel:${process.env.NODE_ENV ?? 'development'}:connect-session`,
        () => Date.now(),
        envelopeEncryptor,
        sessionReuseEnabled(process.env),
      )
    : deps.connectSessionRegistry;
  if (!connectRegistry) throw new Error('A durable Redis connect-session registry is required.');
  const connect = new DistributorConnect(
    searchStore, process.env, async (searchId, userId) => { await enqueueDeepScan(searchId, userId); }, undefined, candidateStore,
    dkProducer ? (job) => dkProducer.startSnapshot(job) : undefined,
    connectRegistry,
    undefined,
    async (binding) => {
      await distributorLink.assertReadConsent(
        { tenantId: binding.tenantId },
        binding.consentId,
        {
          distributor: binding.distributor,
          provider: 'steel',
          actorUserId: binding.ownerUserId,
          // Check against the lease Steel actually returned, not merely the requested timeout.
          minimumRemainingMs: Math.max(1, Date.parse(binding.sessionExpiresAt) - Date.now()),
        },
      );
    },
    envelopeEncryptor,
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
  app.post('/api/connect', { preHandler: requireRole('user') }, async (req, reply) => {
    if (!await enforceProductionRateLimit(req, reply, 'connect')) return;
    const b = (req.body ?? {}) as { distributor?: string; artist?: string; artists?: string[]; consentId?: string };
    // Accept a single `artist` (legacy) or `artists[]` (a label with many artists, DistroKid
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
      const userId = requireSubject(req, reply);
      if (!userId) return;
      const actorUserId = userId;
      const activeTenantId = userId;
      // Per-user isolation: the grant is validated against this exact subject. Ownership is the
      // whole authorization; there is no workspace boundary and artist names are never authority.
      await distributorLink.assertReadConsent(
        { tenantId: activeTenantId }, b.consentId,
        {
          distributor,
          provider: 'steel',
          actorUserId,
          minimumRemainingMs: requiredConsentRemainingMs(process.env),
        },
      );
      await audit.log({
        tenantId: activeTenantId,
        actorUserId: userId,
        action: 'distributor.connect.requested',
        targetType: 'SteelSession',
        targetId: b.consentId,
        metadata: { distributor, artistCount: artists.length, provider: 'steel' },
      });
      return await connect.start(distributor, artists, {
        tenantId: activeTenantId,
        ownerUserId: actorUserId,
        consentId: b.consentId,
      });
    } catch (err) {
      app.log.warn({ errorType: err instanceof Error ? err.name : 'Error' }, 'could not start distributor login');
      if (err instanceof InsecureConfigurationError) {
        return reply.status(503).send({
          error: 'DistroKid connection is disabled by deployment policy. Ask an administrator to verify the approved live-scan configuration.',
        });
      }
      return reply.status(502).send({ error: 'could not start distributor login' });
    }
  });
  /**
   * Consume an attended-login session and start the read.
   *
   * Authenticated AND ownership-checked. The connect id was previously the only thing needed to
   * consume a live, logged-in distributor session, a bearer capability in a URL path, which ends
   * up in browser history, referrers, proxy logs and client state. High entropy doesn't change
   * what it is: possession of the string was authorization to read someone's catalogue.
   */
  app.post('/api/connect/:id/scan', { preHandler: requireRole('user') }, async (req, reply) => {
    try {
      const connectId = (req.params as { id: string }).id;
      const activeTenantId = req.auth.sub;
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
        allowTenantAdmin: false,
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
      app.log.warn(
        { errorType: err instanceof Error ? err.name : 'Error', reason: err instanceof Error ? redactErrorDetail(err.message) : 'unknown' },
        'catalogue read/scan failed',
      );
      return reply.status(502).send({ error: 'catalogue read/scan failed' });
    }
  });

  // TESTING-ONLY rescan trigger (off unless ENABLE_DEV_RESCAN=true). Lets an operator re-run a scan
  // against an already-authorized, retained warm session WITHOUT re-login, during the iterate→rescan
  // loop. It bypasses the Keycloak preHandler, so it is defended three ways: (1) it REFUSES TO BOOT
  // in production, (2) it accepts only LOOPBACK callers (the real TCP peer, never a spoofable
  // header), and (3) it requires a shared secret compared in constant time. confirmAndScan still
  // re-authorizes ownership of the retained session on top of all that.
  if (/^(1|true|yes|on)$/i.test(process.env.ENABLE_DEV_RESCAN ?? '')) {
    if (isProductionEnvironment(process.env)) {
      throw new InsecureConfigurationError('ENABLE_DEV_RESCAN must never be set in a production environment');
    }
    const devSecret = (process.env.DEV_RESCAN_SECRET ?? '').trim();
    if (devSecret.length < 16) {
      throw new InsecureConfigurationError('ENABLE_DEV_RESCAN requires DEV_RESCAN_SECRET of at least 16 characters');
    }
    const devSecretBuf = Buffer.from(devSecret);
    app.log.warn('DEV rescan trigger ENABLED, testing only (loopback + shared secret). Never enable in production.');
    app.post('/api/dev/rescan', async (req, reply) => {
      // Loopback only: the actual TCP peer address, which a header cannot forge.
      const peer = req.socket.remoteAddress ?? '';
      if (!(peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1')) {
        return reply.status(403).send({ error: 'forbidden' });
      }
      // Shared secret, constant-time.
      const provided = Buffer.from(String(req.headers['x-dev-rescan-secret'] ?? ''));
      if (provided.length !== devSecretBuf.length || !timingSafeEqual(provided, devSecretBuf)) {
        return reply.status(403).send({ error: 'forbidden' });
      }
      const body = (req.body ?? {}) as { connectId?: string; tenantId?: string; actorUserId?: string };
      if (!body.connectId || !body.tenantId || !body.actorUserId) {
        return reply.status(400).send({ error: 'connectId, tenantId, actorUserId are required' });
      }
      try {
        return await connect.confirmAndScan(body.connectId, {
          tenantId: body.tenantId,
          actorUserId: body.actorUserId,
          allowTenantAdmin: false,
        });
      } catch (err) {
        return reply.status(502).send({ error: err instanceof Error ? err.message : 'dev rescan failed' });
      }
    });
  }

  app.post('/api/connect/:id/cancel', { preHandler: requireRole('user') }, async (req, reply) => {
    try {
      const connectId = (req.params as { id: string }).id;
      const activeTenantId = req.auth.sub;
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
        allowTenantAdmin: false,
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

  app.post('/api/distributor-imports/csv', { preHandler: [requireRole('user'), requireCustomerScanPrincipal] }, async (req, reply) => {
    // Safe fallback: import an uploaded distributor export (e.g. DistroKid's "Download
    // CSV") without any automation. This is the authoritative released set, its
    // release-level metadata (label, UPC, release/upload dates) carries through to the
    // catalogue. With `save`, we scan it against the stores and persist a search record.
    const b = (req.body ?? {}) as {
      distributor?: string;
      artistName?: string;
      csvText?: string;
      save?: boolean;
    };
    if (!b.csvText) return reply.status(400).send({ error: 'csvText required' });
    const distributor = (b.distributor ?? 'distrokid').trim();
    const scoped = forPrincipal(req, reply);
    if (!scoped) return;
    const userId = req.auth.sub;
    await audit.log({
      tenantId: userId,
      actorUserId: userId,
      action: 'distributor-import.csv.requested',
      targetType: 'DistributorImport',
      metadata: { distributor, save: Boolean(b.save), byteLength: Buffer.byteLength(b.csvText, 'utf8') },
    });
    const parser = new GenericCsvDistributorAdapter(distributor as never);
    const snap = parser.parseCatalog(b.csvText, b.artistName ?? null);
    const trackCount = snap.releases.reduce((n, r) => n + r.tracks.length, 0);
    await audit.log({
      tenantId: userId,
      actorUserId: userId,
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
    // `scoped.save` stamps the owning userId.
    const rec = await scoped.save(
      { artist, distributor, platforms: result.stores },
      result,
      released,
    );
    await enqueueDeepScan(rec.id, userId).catch((err) => app.log.error({ err }, 'enqueue deep scan failed'));
    return { searchId: rec.id, releases: snap.releases.length, tracks: trackCount, warnings: snap.warnings };
  });

  return app;
}
