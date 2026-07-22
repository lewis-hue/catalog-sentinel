import type { ConnectionOptions } from 'bullmq';
import type { Pool } from 'pg';
import { envelopeEncryptorFromEnv, isProductionEnvironment, isTestEnvironment, type EnvelopeCrypto } from '@sentinel/security';
import {
  BrowserLinkUnavailableError,
  createCloudLiveProvider,
  type AutomationConnection,
  type CloudLiveBrowserProvider,
} from '@sentinel/browser-link';
import {
  NetworkFirstExtractor, ParserRegistry, EndpointRegistry, InMemoryEndpointRegistryStore,
  readDirectReaderFlags, readDistroKidCatalogIndexFromPage, DISTRIBUTOR_HOSTS,
  type ReleaseExtractionOutcome, type CandidateSink,
} from '@sentinel/browser-assist';
import { DK_QUEUE_NAMES, DISTROKID_REQUEST_MIN_DELAY_MS, type EndpointRegistryStore } from '@sentinel/contracts';
import { PostgresEndpointRegistryStore } from '@sentinel/persistence';
import {
  TieredSnapshotCheckpointStore, RedisSnapshotStore, PostgresSnapshotCheckpointStore,
  InMemorySnapshotStore, type SnapshotCheckpointStore, type SnapshotRedis, type ReleaseRefRecord,
} from './snapshot-store';
import { ConnectionLock, InMemoryConnectionLock, type LockRedis } from './locks';
import { createDistroKidQueues, enqueuers, startDistroKidPipelineWorkers, type DistroKidQueues } from './pipeline-queue';
import { InMemoryExtractionMetrics, extractionLog } from './metrics';
import type { PipelineDeps, CatalogIndexJob, ReleaseChunkJob, FinalizeJob } from './pipeline';

/**
 * DistroKid pipeline COMPOSITION ROOT.
 *
 * This is what makes the network-first extractor a production path rather than a well-tested
 * library: it constructs the real Redis queues, the distributed per-connection lock, the DURABLE
 * snapshot checkpoint store, the endpoint registry, the browser session attachment and the
 * metrics, then starts the six-stage pipeline and returns a handle that closes all of it.
 *
 * PostgreSQL is the durable source of truth and Redis is its rehydratable hot projection. A
 * worker or Redis-region loss therefore resumes from PostgreSQL instead of replaying a catalogue.
 * Process-local adapters are available only to isolated tests.
 */

export interface DistroKidCompositionOptions {
  connection: ConnectionOptions;
  /** ioredis client — used for durable checkpoints AND the distributed lock. */
  redis: (SnapshotRedis & LockRedis) | null;
  /** Postgres pool — the SYSTEM OF RECORD (endpoint profiles, finalized outcomes). Redis is
   *  checkpoint storage and may be flushed; this is what survives. */
  pgPool: Pool | null;
  env: NodeJS.ProcessEnv;
  /** Persist the finished snapshot (normalized outcomes only — never raw payloads). */
  persistSnapshot(job: FinalizeJob, outcomes: ReleaseExtractionOutcome[]): Promise<void>;
  /** Revalidate the durable consent before every browser-bound unit of work. */
  consentActive?(job: { tenantId: string; snapshotId: string; consentId: string; artistWorkspaceId: string; distributor: string }): Promise<boolean>;
  candidateSink?: CandidateSink;
  /** Chunk concurrency ACROSS accounts (the per-connection lock caps one account to 1). */
  chunkConcurrency?: number;
  log?: (msg: string) => void;
}

export interface DistroKidComposition {
  queues: DistroKidQueues;
  metrics: InMemoryExtractionMetrics;
  store: SnapshotCheckpointStore;
  /** Shared, durable endpoint profiles. Postgres in production; in-memory only without a pool. */
  registryStore: EndpointRegistryStore;
  /** A registry scoped to one tenant. Endpoint promotion is per-tenant so one account's odd
   *  payload can't promote or degrade an endpoint for everyone else. */
  registryFor(tenantId: string): EndpointRegistry;
  /** The queues this composition CONSUMES — logged at boot so "workers started" is observable. */
  queueNames: string[];
  /**
   * Start a snapshot directly, bypassing the queue. For admin tools and tests only — the
   * PRODUCT path is the API enqueuing onto `distrokid-catalog-index` via `@sentinel/queue-client`.
   * Calling this in-process would tie the read to the caller's lifetime, which is the thing the
   * durable pipeline exists to avoid.
   */
  startSnapshot(job: CatalogIndexJob): Promise<void>;
  close(): Promise<void>;
}

/**
 * How a chunk gets an authenticated browser page for an account. Injected so the pipeline is
 * testable without Steel, and so browser lifetime is owned by the caller.
 */
export interface BrowserSessionSource {
  /** Attach to the account's authenticated session (e.g. a live Steel session by remote id). */
  attach(job: { tenantId: string; connectionId: string; distributor: string; steelSessionId?: string }): Promise<AutomationConnection | null>;
  /** Read the catalog index (release refs) over that session. */
  readIndex(conn: AutomationConnection, job: CatalogIndexJob): Promise<ReleaseRefRecord[]>;
  /** Release the one remote session after terminal snapshot persistence. */
  release?(job: FinalizeJob): Promise<void>;
  /** Disconnect process-local browser transports without releasing non-terminal remote sessions. */
  close?(): Promise<void>;
}
/** Abort-aware pacing used immediately before each distributor navigation. */
export function waitForBrowserPacing(signal: AbortSignal, delayMs = DISTROKID_REQUEST_MIN_DELAY_MS): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('browser work aborted'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, delayMs));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('browser work aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Emit startup degradations without constructing queues. Kept separate so boot policy can be
 * tested without opening BullMQ sockets to a deliberately absent Redis server. */
export function reportDistroKidDurabilityDegradations(
  availability: { redis: boolean; postgres: boolean },
  log: (msg: string) => void,
): void {
  if (!availability.redis) {
    log('[distrokid] WARNING: no Redis - checkpoint hot-cache and distributed locking are unavailable.');
  }
  if (!availability.postgres) {
    log('[distrokid] WARNING: no Postgres - in-flight checkpoints are NOT DURABLE and endpoint profiles are IN-MEMORY. Redis loss can replay work and replicas can disagree.');
  }
}

export async function closeDistroKidCompositionResources(
  workers: { close(): Promise<void> },
  queues: { close(): Promise<void> },
  sessions: Pick<BrowserSessionSource, 'close'>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const resource of [workers, queues, sessions]) {
    try {
      await resource.close?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'DistroKid composition cleanup failed');
}

export function buildDistroKidComposition(opts: DistroKidCompositionOptions, sessions: BrowserSessionSource): DistroKidComposition {
  const log = opts.log ?? ((m: string) => console.log(m));
  const origin = DISTRIBUTOR_HOSTS['distrokid'] ?? 'distrokid.com';

  if (!isTestEnvironment(opts.env) && (!opts.redis || !opts.pgPool)) {
    throw new Error('DistroKid extraction requires both Redis coordination and PostgreSQL durable checkpoints outside isolated tests.');
  }

  // PostgreSQL-first writes make Redis disposable. Production has already failed closed above if
  // either tier is absent; the remaining branches are explicit non-production degradations.
  const store: SnapshotCheckpointStore = opts.redis && opts.pgPool
    ? new TieredSnapshotCheckpointStore(opts.redis, opts.pgPool, {
      onCacheError: (error) => log(`[distrokid] Redis checkpoint projection unavailable; using PostgreSQL: ${error.name}`),
    })
    : opts.pgPool
      ? new PostgresSnapshotCheckpointStore(opts.pgPool)
      : opts.redis
        ? new RedisSnapshotStore(opts.redis)
        : new InMemorySnapshotStore();
  reportDistroKidDurabilityDegradations({ redis: Boolean(opts.redis), postgres: Boolean(opts.pgPool) }, log);

  const lock = opts.redis ? new ConnectionLock(opts.redis) : new InMemoryConnectionLock();

  // The endpoint registry STORE is shared and durable; a REGISTRY is built per job, scoped to that
  // job's tenant. Scope cannot be a property of the composition: one worker serves every tenant,
  // so a single registry instance would have to carry an ambient "current tenant" — the same
  // shared-mutable-cursor bug the candidate sink already had.
  const registryStore: EndpointRegistryStore = opts.pgPool
    ? new PostgresEndpointRegistryStore(opts.pgPool)
    : new InMemoryEndpointRegistryStore();
  const onEndpointAlert = (a: { code: string; fingerprint: string; message: string }): void =>
    console.error(JSON.stringify({ level: 'error', msg: 'distrokid.endpoint.alert', code: a.code, fingerprint: a.fingerprint.slice(0, 16), message: a.message }));
  const registryFor = (tenantId: string): EndpointRegistry =>
    new EndpointRegistry(registryStore, { tenantId, distributor: 'DISTROKID' }, onEndpointAlert);
  const parsers = new ParserRegistry(undefined, (a) =>
    console.error(JSON.stringify({ level: 'error', msg: 'distrokid.parser.alert', code: a.code, message: a.message })),
  );
  const metrics = new InMemoryExtractionMetrics();
  const queues = createDistroKidQueues(opts.connection);
  const enq = enqueuers(queues);
  const directFlags = readDirectReaderFlags(opts.env);
  const shutdownController = new AbortController();
  const assertConsentActive = async (job: { tenantId: string; snapshotId: string; consentId?: string; artistWorkspaceId?: string; distributor: string }): Promise<void> => {
    if (!job.consentId || !job.artistWorkspaceId || !opts.consentActive) {
      if (isProductionEnvironment(opts.env)) throw new Error('production pipeline job is missing its durable consent binding');
      return;
    }
    if (!(await opts.consentActive({
      tenantId: job.tenantId,
      snapshotId: job.snapshotId,
      consentId: job.consentId,
      artistWorkspaceId: job.artistWorkspaceId,
      distributor: job.distributor,
    }))) {
      const err = new Error('catalogue-read consent was revoked or expired');
      err.name = 'ConsentInactiveError';
      throw err;
    }
  };

  const deps: PipelineDeps = {
    store,
    metrics,
    requireDeadline: isProductionEnvironment(opts.env),
    shutdownSignal: shutdownController.signal,
    enqueue: enq,
    async acquireLock(job) { return lock.acquire(job.tenantId, job.connectionId); },
    async persistSnapshot(job, outcomes) {
      await opts.persistSnapshot(job, outcomes);
    },
    async releaseSession(job) { await sessions.release?.(job); },
    async terminalFailure(job, stage, error) {
      log(`[distrokid] terminal stage failure: ${stage} (${error.name}); FAILED tombstone recorded.`);
    },

    async readCatalogIndex(job, control) {
      await control.assertCanContinue();
      await assertConsentActive(job);
      const conn = await sessions.attach(job);
      if (!conn) throw new Error('no authenticated distributor session available for this connection');
      const abort = (): void => { void conn.close().catch(() => undefined); };
      control.signal.addEventListener('abort', abort, { once: true });
      try {
        await control.assertCanContinue();
        await waitForBrowserPacing(control.signal);
        await control.assertCanContinue();
        const releases = await sessions.readIndex(conn, job);
        await control.assertCanContinue();
        return releases;
      } finally {
        control.signal.removeEventListener('abort', abort);
        await conn.close().catch(() => undefined);
      }
    },

    /**
     * Extract ONE chunk network-first over the account's authenticated session. Every release
     * gets a terminal outcome; checkpoints are emitted so a crash resumes mid-chunk.
     */
    async extractChunk(job: ReleaseChunkJob, refs, onCheckpoint, control) {
      const outcomes: ReleaseExtractionOutcome[] = [];
      if (refs.length === 0) return outcomes;
      await control.assertCanContinue();
      await assertConsentActive(job);
      const conn = await sessions.attach(job);
      if (!conn) {
        // No session → a terminal REAUTH outcome per release, never a silent skip.
        return refs.map((r) => ({ kind: 'FAILED' as const, distributorReleaseId: r.releaseId, reason: 'REAUTH_REQUIRED' as const, detail: 'no authenticated session', elapsedMs: 0 }));
      }
      const abort = (): void => { void conn.close().catch(() => undefined); };
      control.signal.addEventListener('abort', abort, { once: true });
      await control.assertCanContinue();
      const page = await conn.newPage();
      const extractor = new NetworkFirstExtractor(
        page,
        {
          origin,
          distributor: 'DISTROKID',
          gotoTimeoutMs: Number(opts.env.CATALOG_READ_GOTO_TIMEOUT_MS) || 30_000,
          responseTimeoutMs: Number(opts.env.CATALOG_READ_CONTENT_TIMEOUT_MS) || 30_000,
          enableCdpFallback: true,
          directReaderFlags: directFlags,
          // Passive capture stays the default even when the flags are on (see direct-reader.ts).
          directReplayPolicy: 'never',
          ...(opts.candidateSink ? { candidateSink: opts.candidateSink, candidateScope: { tenantId: job.tenantId, scanId: job.snapshotId } } : {}),
          log: (msg, extra) => console.log(extractionLog({
            tenantId: job.tenantId, connectionId: job.connectionId, scanId: job.snapshotId,
            releaseId: String(extra?.['releaseId'] ?? ''), outcome: msg,
            elapsedMs: Number(extra?.['elapsedMs'] ?? 0),
          })),
        },
        // Registry scoped to THIS job's tenant, over the shared durable store.
        { parsers, registry: registryFor(job.tenantId) },
      );
      try {
        // Listeners are installed BEFORE any release navigation — the whole point.
        await extractor.install(new Set(refs.map((r) => r.releaseId)));
        const batch: ReleaseExtractionOutcome[] = [];
        for (const ref of refs) {
          // This is immediately before the one navigation/work item for the release.
          await control.assertCanContinue();
          await assertConsentActive(job);
          await waitForBrowserPacing(control.signal);
          await control.assertCanContinue();
          const outcome = await extractor.extractRelease(ref);
          // Fence stale work: lock loss/deadline during navigation cannot be checkpointed.
          await control.assertCanContinue();
          outcomes.push(outcome);
          batch.push(outcome);
          if (outcome.kind === 'COMPLETED') {
            metrics.parserUsed(parsers.versions[0] ?? 'unknown');
            metrics.tracks(outcome.release.tracks.length, outcome.release.tracks.filter((t) => t.isrc.status === 'PRESENT').length);
            metrics.releaseCoverage(outcome.release.upc.status === 'PRESENT' ? 1 : 0, outcome.release.artworkUrl.status === 'PRESENT' ? 1 : 0);
          } else if (outcome.kind === 'FAILED' && outcome.reason === 'TIMEOUT') {
            metrics.responseTimeout();
          }
          // Checkpoint every 10 releases (also the write batch size).
          if (batch.length >= 10) { await onCheckpoint([...batch]); batch.length = 0; }
        }
        if (batch.length) await onCheckpoint([...batch]);
        return outcomes;
      } finally {
        control.signal.removeEventListener('abort', abort);
        await extractor.dispose().catch(() => undefined);
        await conn.close().catch(() => undefined);
      }
    },
  };

  const workers = startDistroKidPipelineWorkers({ connection: opts.connection, deps, ...(opts.chunkConcurrency ? { chunkConcurrency: opts.chunkConcurrency } : {}) });
  const checkpointMode = opts.redis && opts.pgPool ? 'postgres+redis-hot-cache' : opts.pgPool ? 'postgres-only' : opts.redis ? 'REDIS-ONLY-NONPRODUCTION' : 'MEMORY';
  log(`[distrokid] network-first pipeline started (queues: catalog-index, plan-chunks, release-chunk, retry-failed, reconcile, finalize; checkpoints: ${checkpointMode})`);

  return {
    queues,
    metrics,
    store,
    registryStore,
    registryFor,
    queueNames: [...DK_QUEUE_NAMES],
    async startSnapshot(job) { await enq.startSnapshot(job); },
    async close() {
      shutdownController.abort(new Error('DistroKid composition is shutting down'));
      await closeDistroKidCompositionResources(workers, queues, sessions);
    },
  };
}

/**
 * Steel-backed session source: re-attaches to the user's already-authenticated cloud browser by
 * REMOTE session id (the API hands it off after the attended login), so no re-login is needed.
 */
type SteelSessionProvider = Pick<CloudLiveBrowserProvider, 'attachRemoteSession' | 'releaseRemoteSession'>
  & Partial<Pick<CloudLiveBrowserProvider, 'disposeLocalConnections'>>;

export function steelSessionSource(
  env: NodeJS.ProcessEnv,
  providerOverride?: SteelSessionProvider | null,
  encryptor: EnvelopeCrypto = envelopeEncryptorFromEnv(env),
): BrowserSessionSource {
  const provider = providerOverride === undefined ? createCloudLiveProvider(env, encryptor) : providerOverride;
  if (!provider && isProductionEnvironment(env)) {
    throw new BrowserLinkUnavailableError('steel', 'Production DistroKid workers require a configured Steel session provider.');
  }
  const released = new Set<string>();
  const remoteId = async (stored: string): Promise<string> => {
    if (stored.startsWith('v1.') || stored.startsWith('v2.')) return encryptor.decrypt(stored);
    if (isProductionEnvironment(env)) {
      throw new BrowserLinkUnavailableError('steel', 'Refusing a plaintext Steel session handle in a production queue job.');
    }
    // Compatibility for existing development/test fixtures and rolling non-production jobs.
    return stored;
  };
  return {
    async attach(job) {
      // The remote id travels with the job (handed off by the API after the attended login), so
      // any worker can re-attach to the SAME logged-in browser — no re-login, no side channel.
      if (!provider || !job.steelSessionId) return null;
      return provider.attachRemoteSession(await remoteId(job.steelSessionId), { releaseOnClose: false });
    },
    async readIndex(conn, _job) {
      // The catalog index is itself read over the authenticated session; the release refs it
      // returns are the authoritative expectation for completeness reconciliation.
      const page = await conn.newPage();
      const musicUrl = env.DISTROKID_MUSIC_URL ?? 'https://distrokid.com/mymusic';
      return readDistroKidCatalogIndexFromPage(page, {
        musicUrl,
        maxReleases: Number(env.CATALOG_READ_MAX_RELEASES) || 5000,
      });
    },
    async release(job) {
      if (!provider || !job.steelSessionId) return;
      const id = await remoteId(job.steelSessionId);
      if (released.has(id)) return;
      await provider.releaseRemoteSession(id);
      released.add(id);
    },
    async close() {
      await provider?.disposeLocalConnections?.();
    },
  };
}
