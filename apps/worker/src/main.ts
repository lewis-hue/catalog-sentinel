import { startNodeTelemetry } from '@sentinel/core';
import { unlink, writeFile } from 'node:fs/promises';
import {
  validateServerConfig,
  isProductionEnvironment,
  readDistributorLinkFlags,
  envelopeEncryptorFromEnv,
  verifyEnvelopeEncryptor,
  type EnvelopeCrypto,
} from '@sentinel/security';
import {
  createDistributorLinkRepository,
  createProductionGovernanceAdapters,
  createProductionGovernanceRuntime,
  ProductionGovernanceMaintenanceService,
  type GovernanceSqlPool,
} from '@sentinel/db';
import { connectionFromUrl } from './bullmq';
import { assertStandaloneRedisTopology, buildSearchStore } from '@sentinel/search-store';
import { startPresenceDeepScanWorker, createPresenceProducer } from './presence-deep-scan-queue';
import { buildDistroKidComposition, steelSessionSource } from './distrokid/composition';
import { DistroKidOutcomeRepository } from '@sentinel/persistence';
import type { SnapshotRedis } from './distrokid/snapshot-store';
import type { LockRedis } from './distrokid/locks';
import { projectFinalizedSnapshot } from './distrokid/finalize-result';
import { assertSnapshotPrincipalBinding, snapshotPrincipalBindingValid } from './distrokid/principal-binding';
import { runShutdownPhases, type ShutdownPhase } from './shutdown';

/**
 * Worker entrypoint.
 *
 * - `DEEP_SCAN_DISPATCH=bullmq` (+ REDIS_URL): attach a BullMQ worker to the Redis
 *   `deep-scan` queue and run scans against the SHARED database — the production
 *   "celery-style" handoff. The process stays alive consuming jobs.
 * No process-local execution or persistence fallback is available.
 */
async function startDeepScanConsumer(
  flushTelemetry: () => Promise<void>,
  envelopeEncryptor: EnvelopeCrypto,
): Promise<void> {
  const flags = readDistributorLinkFlags(process.env);
  const redisUrl = process.env.REDIS_URL!;
  const connection = connectionFromUrl(redisUrl);
  const consumers: Array<() => Promise<void>> = [];
  const producers: Array<() => Promise<void>> = [];
  const stores: Array<() => Promise<void>> = [];
  const productionDeployment = isProductionEnvironment(process.env);
  let governanceHealthy = !productionDeployment;

  // 1) PRIMARY: multi-platform store-presence deep scan. Reads/writes the shared Redis
  //    SearchStore so the API serves results as they fill in. Concurrency 1 by default
  //    (Brave web search is a global 1/sec per key).
  const built = buildSearchStore(process.env, (m, e) => console.log(JSON.stringify({ level: 'warn', msg: `[search-store] ${m}`, ...e })));
  if (!built.pgPool) {
    await built.close();
    throw new Error('Worker search store is missing its required PostgreSQL durable tier.');
  }
  if (built.redis) {
    try {
      await assertStandaloneRedisTopology(built.redis);
    } catch (error) {
      await built.close();
      throw error;
    }
  }
  const store = built.store;

  if (productionDeployment) {
    // Governance is a required production worker capability, not an optional cron sidecar.
    // Startup verifies PostgreSQL, KMS/HSM-backed signing and pseudonymization, Object Lock,
    // every queue, Steel, Keycloak, observability erasure, Secrets Manager, and backup vaults.
    const governanceRuntime = createProductionGovernanceRuntime(process.env);
    let governanceAdapters: ReturnType<typeof createProductionGovernanceAdapters> | null = null;
    try {
      await governanceRuntime.verifyReady();
      governanceAdapters = createProductionGovernanceAdapters(
        governanceRuntime.pool as unknown as GovernanceSqlPool,
        governanceRuntime.pseudonymizer,
        process.env,
        { envelope: envelopeEncryptor, auditReceiptSigner: governanceRuntime.auditSigner },
      );
      await governanceAdapters.verifyReady();
    } catch (error) {
      await governanceAdapters?.close().catch(() => undefined);
      await governanceRuntime.close().catch(() => undefined);
      await built.close().catch(() => undefined);
      throw error;
    }
    const governance = new ProductionGovernanceMaintenanceService(
      governanceRuntime.retention,
      governanceRuntime.erasure,
      governanceRuntime.auditAnchorPublisher,
      governanceAdapters.retentionAdapters,
      governanceAdapters.erasureAdapters,
      governanceAdapters.auditLegalHold,
    );
    let governanceCycle: Promise<void> | null = null;
    const runGovernanceCycle = async (): Promise<void> => {
      const result = await governance.runCycle();
      governanceHealthy = true;
      console.log(JSON.stringify({ level: 'info', msg: 'governance.maintenance.completed', ...result }));
    };
    await runGovernanceCycle();
    const configuredGovernanceInterval = Number(process.env.GOVERNANCE_MAINTENANCE_INTERVAL_MS ?? 300_000);
    if (!Number.isSafeInteger(configuredGovernanceInterval) || configuredGovernanceInterval < 60_000 || configuredGovernanceInterval > 86_400_000) {
      await governanceAdapters.close().catch(() => undefined);
      await governanceRuntime.close().catch(() => undefined);
      await built.close().catch(() => undefined);
      throw new Error('GOVERNANCE_MAINTENANCE_INTERVAL_MS must be an integer between 60000 and 86400000.');
    }
    const governanceTimer = setInterval(() => {
      if (governanceCycle) return;
      governanceCycle = runGovernanceCycle()
        .catch(async (error) => {
          governanceHealthy = false;
          await unlink('/tmp/sentinel-worker-ready').catch(() => undefined);
          console.error('Governance maintenance failed:', error instanceof Error ? error.message : error);
        })
        .finally(() => { governanceCycle = null; });
    }, configuredGovernanceInterval);
    governanceTimer.unref?.();
    consumers.push(async () => {
      clearInterval(governanceTimer);
      await governanceCycle;
    });
    stores.push(() => governanceAdapters!.close());
    stores.push(() => governanceRuntime.close());
  } else {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'governance.maintenance.not_started',
      reason: 'production AWS governance services are not part of the local integration stack',
    }));
  }

  const distributorRepo = await createDistributorLinkRepository(process.env);
  stores.push(() => distributorRepo.close());
  console.log(`Search store: ${built.kind}`);
  // Worker liveness heartbeat — the API's /health reads this to confirm a worker is up.
  if (built.redis) {
    const beat = () => built.redis!.set('sentinel:hb:presence-worker', String(Date.now()), 'EX', 60).catch(() => {});
    void beat();
    const hb = setInterval(beat, 15_000);
    consumers.push(async () => clearInterval(hb));
  }
  const presenceWorker = startPresenceDeepScanWorker(connection, { store, env: process.env, concurrency: flags.deepScanMaxConcurrency });
  presenceWorker.on('completed', (job) => console.log(`[presence-deep-scan] completed ${job.id}`));
  presenceWorker.on('failed', (job, err) => console.error(`[presence-deep-scan] failed ${job?.id}:`, err?.message));
  consumers.push(async () => { await presenceWorker.close(); });
  stores.push(() => built.close());
  console.log(`Presence deep-scan worker attached to Redis queue "store-presence-deep-scan" (concurrency=${flags.deepScanMaxConcurrency}).`);

  // 1b) DURABLE CATALOGUE READ: attach to the user's logged-in Steel session and read the
  //     whole catalogue (parallel, bounded) off the request path, then chain the deep scan.
  //     Needs a cloud (Steel) provider — the same STEEL_API_KEY the API uses.
  const presenceProducer = createPresenceProducer(connection);
  producers.push(async () => { await presenceProducer.close(); });
  // 1c) NETWORK-FIRST DistroKid pipeline (the six-stage, resumable extractor). Without this
  //     composition root the pipeline is only a tested library — nothing would ever consume its
  //     queues. Storage is DURABLE (Redis checkpoints) so a crash resumes mid-catalogue.
  //
  //     This deliberately does NOT swallow failures. When the pipeline is the configured read
  //     path, a worker that boots "healthy" without it is a silent outage: scans queue up on
  //     `distrokid-catalog-index` and nothing ever consumes them. Best-effort is only correct
  //     for genuinely optional capabilities — this is the primary one.
  const dkOutcomes = new DistroKidOutcomeRepository(built.pgPool);
  console.log('DistroKid outcomes persist to Postgres (durable system of record).');
  const dk = buildDistroKidComposition(
    {
      connection,
      redis: built.redis as unknown as (SnapshotRedis & LockRedis) | null,
      pgPool: built.pgPool ?? null,
      env: process.env,
      chunkConcurrency: flags.deepScanMaxConcurrency,
      async consentActive(job) {
        return snapshotPrincipalBindingValid(store, distributorRepo, job);
      },
      // Persist NORMALIZED outcomes — never raw payloads. Postgres is the system of record;
      // Redis holds operational checkpoints only and may be flushed at any time.
      async persistSnapshot(job, outcomes) {
        // Re-check immediately before both durable outcome persistence and customer-facing
        // projection. A forged/stale same-tenant job must fail without changing either store.
        await assertSnapshotPrincipalBinding(store, distributorRepo, job);
        await dkOutcomes.persist(job, outcomes);
        const updated = await store.update(job.snapshotId, (r) => projectFinalizedSnapshot(r, job, outcomes));
        if (!updated) throw new Error(`finalized snapshot has no search record: ${job.snapshotId}`);
        // The public catalogue and its authoritative released set are now visible. Only then may
        // store-presence verification start; enqueue failure makes finalization retry instead of
        // silently leaving the UI in a terminal-but-unscanned state.
        if (updated.released?.length) await presenceProducer.enqueue(job.snapshotId, job.tenantId);
        console.log(JSON.stringify({
          level: 'info', msg: 'distrokid.snapshot.finalized', snapshotId: job.snapshotId,
          status: job.status, releases: outcomes.length,
          completed: outcomes.filter((o) => o.kind === 'COMPLETED').length,
          durable: dkOutcomes.durable,
        }));
      },
    },
    // Re-attach to the user's authenticated Steel session (its remote id travels with the
    // job). Returns null when absent → terminal REAUTH outcomes, never a silent skip.
    steelSessionSource(process.env, undefined, envelopeEncryptor),
  );
  consumers.push(() => dk.close());
  console.log(`DistroKid network-first pipeline attached to queues: ${dk.queueNames.join(', ')}.`);
  // Readiness beacon: the API's /health reports whether a consumer actually holds these queues,
  // so "workers started" is observable rather than assumed.
  if (built.redis) {
    const beat = () => built.redis!.set('sentinel:hb:distrokid-pipeline', String(Date.now()), 'EX', 60).catch(() => {});
    void beat();
    const hb = setInterval(beat, 15_000);
    consumers.push(async () => clearInterval(hb));
  }

  console.log('Workers waiting for jobs…');
  const readinessFile = '/tmp/sentinel-worker-ready';
  const markReady = async (): Promise<void> => {
    if (!built.redis) throw new Error('Worker readiness requires Redis.');
    if (!governanceHealthy) throw new Error('Worker readiness requires a successful governance maintenance cycle.');
    await built.redis.ping();
    await writeFile(readinessFile, String(Date.now()), { encoding: 'utf8', mode: 0o600 });
  };
  await markReady();
  const readinessHeartbeat = setInterval(() => { void markReady().catch(() => {}); }, 15_000);
  consumers.push(async () => {
    clearInterval(readinessHeartbeat);
    await unlink(readinessFile).catch(() => {});
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down workers…');
    const force = setTimeout(() => {
      console.error('Worker shutdown exceeded 25s; forcing nonzero exit.');
      process.exit(1);
    }, 25_000);
    force.unref?.();
    const phases: ShutdownPhase[] = [
      { name: 'consumers-and-heartbeats', close: consumers },
      { name: 'producers', close: producers },
      { name: 'repositories-and-stores', close: stores },
      { name: 'telemetry', close: [flushTelemetry] },
    ];
    const clean = await runShutdownPhases(phases, (phase, error) => {
      console.error(`Worker shutdown phase ${phase} failed:`, error instanceof Error ? error.message : error);
    });
    clearTimeout(force);
    if (!clean) process.exitCode = 1;
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

async function main(): Promise<void> {
  // OpenTelemetry (no-op unless configured) — must start before work begins.
  const telemetry = await startNodeTelemetry(process.env, 'artist-catalog-sentinel-worker');
  let flags: ReturnType<typeof readDistributorLinkFlags>;
  let envelopeEncryptor: EnvelopeCrypto;
  try {
    // Same startup safety gates as the API (Phase 2).
    validateServerConfig(process.env);
    flags = readDistributorLinkFlags(process.env);
    envelopeEncryptor = envelopeEncryptorFromEnv(process.env);
    await verifyEnvelopeEncryptor(envelopeEncryptor);
  } catch (error) {
    await telemetry.shutdown();
    throw error;
  }

  if (flags.deepScanDispatch !== 'bullmq' || !process.env.REDIS_URL) {
    await telemetry.shutdown();
    throw new Error('Worker requires DEEP_SCAN_DISPATCH=bullmq and REDIS_URL; no process-local fallback is available.');
  }
  if (!process.env.DATABASE_URL?.trim()) {
    await telemetry.shutdown();
    throw new Error('Worker requires DATABASE_URL for durable search history, endpoint profiles, and extraction outcomes.');
  }
  await startDeepScanConsumer(() => telemetry.shutdown(), envelopeEncryptor);
}

if (process.env.SENTINEL_INTERNAL_MODULE_LOAD_ONLY !== '1') {
  main().catch((err) => {
    console.error('Worker failed:', err);
    process.exitCode = 1;
  });
}
