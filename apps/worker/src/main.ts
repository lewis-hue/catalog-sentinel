import { startNodeTelemetry } from '@sentinel/core';
import { unlink, writeFile } from 'node:fs/promises';
import {
  validateServerConfig,
  readDistributorLinkFlags,
  envelopeEncryptorFromEnv,
  verifyEnvelopeEncryptor,
  type EnvelopeCrypto,
} from '@sentinel/security';
import { createDistributorLinkRepository } from '@sentinel/db';
import { connectionFromUrl } from './bullmq';
import { assertStandaloneRedisTopology, buildSearchStore } from '@sentinel/search-store';
import { startPresenceDeepScanWorker, createPresenceProducer } from './presence-deep-scan-queue';
import { startLyricsVerificationWorker } from './lyrics-verification-queue';
import { startDistroKidLyricScanWorker, createDistroKidLyricScanProducer } from './distrokid-lyric-scan-queue';
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
 *   `deep-scan` queue and run scans against the SHARED database, the production
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

  // 1) PRIMARY: multi-platform store-presence deep scan. Reads/writes the shared Redis
  //    SearchStore so the API serves results as they fill in. Concurrency 1 by default
  //    (web search is rate-limited to keep the SERP API happy).
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

  const distributorRepo = await createDistributorLinkRepository(process.env);
  stores.push(() => distributorRepo.close());
  console.log(`Search store: ${built.kind}`);
  // Worker liveness heartbeat, the API's /health reads this to confirm a worker is up.
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
  //     Needs a cloud (Steel) provider, the same STEEL_API_KEY the API uses.
  const presenceProducer = createPresenceProducer(connection);
  producers.push(async () => { await presenceProducer.close(); });
  // 1c) NETWORK-FIRST DistroKid pipeline (the six-stage, resumable extractor). Without this
  //     composition root the pipeline is only a tested library, nothing would ever consume its
  //     queues. Storage is DURABLE (Redis checkpoints) so a crash resumes mid-catalogue.
  //
  //     This deliberately does NOT swallow failures. When the pipeline is the configured read
  //     path, a worker that boots "healthy" without it is a silent outage: scans queue up on
  //     `distrokid-catalog-index` and nothing ever consumes them. Best-effort is only correct
  //     for genuinely optional capabilities, this is the primary one.
  const dkOutcomes = new DistroKidOutcomeRepository(built.pgPool);
  console.log('DistroKid outcomes persist to Postgres (durable system of record).');

  // Fault-isolated STORE-SIDE lyric verification (LRCLIB). It writes the Postgres outcome tables
  // (storeLyric* columns), never the in-memory search record, so it runs fully independent of the
  // store-presence deep scan: a user can run a store check and a lyrics check at once and both finish.
  const lyricsWorker = startLyricsVerificationWorker(connection, { outcomeRepo: dkOutcomes, env: process.env, concurrency: 1 });
  lyricsWorker.on('completed', (job) => console.log(`[lyrics-verification] completed ${job.id}`));
  lyricsWorker.on('failed', (job, err) => console.error(`[lyrics-verification] failed ${job?.id}:`, err?.message));
  consumers.push(async () => { await lyricsWorker.close(); });
  console.log('Lyric-availability worker attached to Redis queue "lyrics-verification" (concurrency=1).');
  // Dedicated DistroKid lyric scan: a SEPARATE, fault-isolated queue + worker that re-attaches to
  // the warm Steel session AFTER the metadata scrape and reads each album's lazy-rendered lyric
  // state unhurriedly (the only reliable path, inline in the deadline-bound scrape is impossible).
  const dkLyricScanWorker = startDistroKidLyricScanWorker(connection, { outcomeRepo: dkOutcomes, env: process.env });
  dkLyricScanWorker.on('completed', (job) => console.log(`[distrokid-lyric-scan] completed ${job.id}`));
  dkLyricScanWorker.on('failed', (job, err) => console.error(`[distrokid-lyric-scan] failed ${job?.id}:`, err?.message));
  consumers.push(async () => { await dkLyricScanWorker.close(); });
  const dkLyricProducer = createDistroKidLyricScanProducer(connection);
  producers.push(async () => { await dkLyricProducer.close(); });
  console.log('DistroKid lyric-scan worker attached to Redis queue "distrokid-lyric-scan" (concurrency=1).');
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
      // Persist NORMALIZED outcomes, never raw payloads. Postgres is the system of record;
      // Redis holds operational checkpoints only and may be flushed at any time.
      async persistSnapshot(job, outcomes) {
        // Re-check immediately before both durable outcome persistence and customer-facing
        // projection. A forged/stale same-tenant job must fail without changing either store.
        await assertSnapshotPrincipalBinding(store, distributorRepo, job);
        await dkOutcomes.persist(job, outcomes);
        // Seed this snapshot's lyric state from prior reads of the same albums so the session-bounded
        // lyric pass only live-reads never-read albums (resumable across scans). Best-effort.
        await dkOutcomes
          .carryForwardLyrics(job.tenantId, job.snapshotId)
          .catch((e) => console.warn(JSON.stringify({ level: 'warn', msg: 'distrokid.lyric_carry_forward_failed', detail: e instanceof Error ? e.message : String(e) })));
        const updated = await store.update(job.snapshotId, (r) => projectFinalizedSnapshot(r, job, outcomes, undefined, flags.storePresenceAuto));
        if (!updated) throw new Error(`finalized snapshot has no search record: ${job.snapshotId}`);
        // The public catalogue and its authoritative released set are now visible. Store-presence
        // verification is a SEPARATE product surface: by default (SCAN_STORE_PRESENCE_AUTO unset)
        // scraping stands alone and the store check runs only when a user triggers it, so a slow or
        // failing verification can never fail an otherwise-successful scrape. The finalize projection
        // above leaves such records on `idle` (a CTA state), not `queued`. When the flag is on, the
        // legacy chain runs and an enqueue failure makes finalization retry rather than silently
        // leaving the UI terminal-but-unscanned.
        if (flags.storePresenceAuto && updated.released?.length) {
          await presenceProducer.enqueue(job.snapshotId, job.tenantId);
        }
        // Dedicated lyric scan (gated by DISTROKID_LYRIC_PASS): now that the outcome rows are
        // durable, re-visit each album on the STILL-WARM Steel session to read lyric state. Enqueue
        // is best-effort, a lyric-scan failure must never fail an otherwise-successful scrape.
        if (/^(1|true|yes|on)$/i.test(process.env.DISTROKID_LYRIC_PASS ?? '') && outcomes.some((o) => o.kind === 'COMPLETED')) {
          await dkLyricProducer.enqueue({
            snapshotId: job.snapshotId, tenantId: job.tenantId, connectionId: job.connectionId,
            ...(job.steelSessionId ? { steelSessionId: job.steelSessionId } : {}),
            ...(job.sessionExpiresAt ? { sessionExpiresAt: job.sessionExpiresAt } : {}),
          }).catch((e) => console.warn(JSON.stringify({ level: 'warn', msg: 'distrokid.lyric_scan.enqueue_failed', detail: e instanceof Error ? e.message : String(e) })));
        }
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
  // OpenTelemetry (no-op unless configured), must start before work begins.
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
