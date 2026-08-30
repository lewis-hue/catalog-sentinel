import { startNodeTelemetry } from '@sentinel/core';
import {
  envelopeEncryptorFromEnv,
  PostgresAuditLogger,
  validateServerConfig,
  verifyEnvelopeEncryptor,
  type AuditSqlClient,
} from '@sentinel/security';
import { createDistributorLinkRepository } from '@sentinel/db';
import { createPgPool } from '@sentinel/search-store';
import { buildApp } from './app';
import { DistributorLinkService } from './distributor-link';
import { createGracefulShutdown } from './graceful-shutdown';

// Centralized startup validation (Phase 2): hosted-credential-form hard block,
// provider-enable gates, live-scanner legal-review gate, and, in production -
// required encryption key + DATABASE_URL + REDIS_URL. Fails fast on unsafe config.
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? '0.0.0.0';

async function start(): Promise<void> {
  validateServerConfig(process.env);
  // Start OpenTelemetry first (no-op unless OTEL_EXPORTER_OTLP_ENDPOINT/OTEL_ENABLED
  // is set) so HTTP + deep-scan spans/metrics are captured from the outset.
  const telemetry = await startNodeTelemetry(process.env, 'artist-catalog-sentinel-api');
  const envelopeEncryptor = envelopeEncryptorFromEnv(process.env);
  await verifyEnvelopeEncryptor(envelopeEncryptor);

  // Resolve every durable adapter before building the synchronous HTTP application.
  const repo = await createDistributorLinkRepository(process.env);
  if (!process.env.DATABASE_URL?.trim()) {
    await telemetry.shutdown();
    throw new Error('DATABASE_URL is required for the durable audit log outside tests.');
  }
  const auditPool = createPgPool(process.env.DATABASE_URL);
  const audit = new PostgresAuditLogger(auditPool as unknown as AuditSqlClient);
  const distributorLink = new DistributorLinkService(audit, {
    repo,
  });

  const app = buildApp({
    distributorLink,
    auditLogger: audit,
    envelopeEncryptor,
    closeAudit: async () => {
      await auditPool.end();
    },
  });
  const shutdown = createGracefulShutdown({
    close: () => app.close(),
    flushTelemetry: () => telemetry.shutdown(),
    log(level, message, error) {
      if (level === 'error') app.log.error({ errorType: error instanceof Error ? error.name : undefined }, message);
      else app.log.info(message);
    },
  });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  try {
    const address = await app.listen({ port, host });
    app.log.info(`Artist Catalog Sentinel API listening at ${address}`);
    app.log.info(`Docs: ${address}/docs · OpenAPI: ${address}/openapi.json`);
    app.log.info('Persistence: PostgreSQL with Redis coordination');
  } catch (err) {
    app.log.error(err);
    await shutdown('startup failure');
    throw err;
  }
}

if (process.env.SENTINEL_INTERNAL_MODULE_LOAD_ONLY !== '1') {
  start().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
