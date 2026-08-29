/**
 * Feature flags for the Secure Distributor Link feature. Risky connector modes
 * are OFF by default and gated here. A hosted credential-collection form can
 * never run in any environment; Steel is the only browser/session path.
 */
import {
  decodeMasterKeyBase64,
  parseKmsEncryptionContext,
  parseProductionKmsEncryptionContext,
  validateProductionKmsKeyId,
} from './envelope';
import { verifyComplianceApproval } from './compliance-approval';

export interface DistributorLinkFlags {
  browserLinkProvider: 'steel';
  /** MUST remain false in every environment. Gated by assertNoHostedCredentialForm. */
  enableHostedCredentialForm: boolean;
  /** Live DistroKid scanning, double-gated with the legal-review flag below. */
  enableDistroKidLiveScanner: boolean;
  legalReviewDistroKidScannerApproved: boolean;
  /** Queued deep scans are always handed to a separate BullMQ worker. */
  deepScanDispatch: 'bullmq';
  deepScanMaxConcurrency: number;
  /**
   * When false (the default), store-presence verification does NOT auto-fire after a DistroKid
   * catalogue scrape finishes. Scraping is a standalone product surface; the store check runs
   * only when a user explicitly triggers it. Set SCAN_STORE_PRESENCE_AUTO=true to restore the
   * legacy "scrape then immediately verify" chain.
   */
  storePresenceAuto: boolean;
  distributorScanMinDelayMs: number;
  distributorScanMaxPagesPerRun: number;
  distributorScanMaxReleasesPerRun: number;
  browserSessionTtlMinutes: number;
  browserStateTtlHours: number;
}

function boolEnv(v: string | undefined, dflt = false): boolean {
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function productionHttpsUrl(name: string, value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ConfigValidationError(`${name} must be an absolute HTTPS URL without embedded credentials.`); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new ConfigValidationError(`${name} must be an absolute HTTPS URL without embedded credentials, query, or fragment.`);
  }
  return url;
}

function productionViewerOrigins(value: string | undefined): string[] {
  const entries = (value ?? '').split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) {
    throw new ConfigValidationError('STEEL_VIEWER_ORIGINS must list at least one exact approved HTTPS origin in production.');
  }
  return entries.map((entry) => {
    if (entry.includes('*')) throw new ConfigValidationError('STEEL_VIEWER_ORIGINS must contain exact origins, not wildcards.');
    const url = productionHttpsUrl('STEEL_VIEWER_ORIGINS', entry);
    if (url.pathname !== '/') {
      throw new ConfigValidationError('STEEL_VIEWER_ORIGINS entries must be origins without paths.');
    }
    return url.origin;
  });
}

/** Fail-safe deployment classification shared by API, workers, auth, and readiness. */
export function isProductionEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env.DEPLOYMENT_ENV, env.APP_ENV, env.NODE_ENV]
    .some((value) => value?.trim().toLowerCase() === 'production');
}

export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionEnvironment(env) && (
    Boolean(env.VITEST)
    || [env.DEPLOYMENT_ENV, env.APP_ENV, env.NODE_ENV].some((value) => value?.trim().toLowerCase() === 'test')
  );
}

export function readDistributorLinkFlags(env: NodeJS.ProcessEnv = process.env): DistributorLinkFlags {
  return {
    browserLinkProvider: 'steel',
    enableHostedCredentialForm: boolEnv(env.ENABLE_HOSTED_CREDENTIAL_FORM, false),
    enableDistroKidLiveScanner: boolEnv(env.ENABLE_DISTROKID_LIVE_SCANNER, false),
    legalReviewDistroKidScannerApproved: boolEnv(env.LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED, false),
    deepScanDispatch: 'bullmq',
    deepScanMaxConcurrency: intEnv(env.DEEP_SCAN_MAX_CONCURRENCY, 1),
    storePresenceAuto: boolEnv(env.SCAN_STORE_PRESENCE_AUTO, false),
    distributorScanMinDelayMs: intEnv(env.DISTRIBUTOR_SCAN_MIN_DELAY_MS, 1500),
    distributorScanMaxPagesPerRun: intEnv(env.DISTRIBUTOR_SCAN_MAX_PAGES_PER_RUN, 500),
    distributorScanMaxReleasesPerRun: intEnv(env.DISTRIBUTOR_SCAN_MAX_RELEASES_PER_RUN, 1000),
    browserSessionTtlMinutes: intEnv(env.BROWSER_SESSION_TTL_MINUTES, 20),
    browserStateTtlHours: intEnv(env.BROWSER_STATE_TTL_HOURS, 24),
  };
}

export class InsecureConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureConfigurationError';
  }
}

/**
 * HARD BLOCK (spec §"Important hard block"). Call at API/worker startup. There
 * is no development override and no runtime path that permits collecting a
 * distributor password; authentication happens only in an attended Steel session.
 */
export function assertNoHostedCredentialForm(env: NodeJS.ProcessEnv = process.env): void {
  if (!boolEnv(env.ENABLE_HOSTED_CREDENTIAL_FORM, false)) return;
  throw new InsecureConfigurationError(
    'ENABLE_HOSTED_CREDENTIAL_FORM=true is not permitted in any environment. Use an attended Steel session.',
  );
}

/** Steel sessions are the only supported browser-link path. */
export function assertProviderEnabled(env: NodeJS.ProcessEnv = process.env): void {
  const selected = (env.BROWSER_LINK_PROVIDER ?? 'steel').trim().toLowerCase();
  if (selected !== 'steel') {
    throw new InsecureConfigurationError(
      `BROWSER_LINK_PROVIDER=${selected || '<empty>'} is unsupported. Steel sessions are the only browser-link path.`,
    );
  }
}

/**
 * Live DistroKid scanning is double-gated: it requires ENABLE_DISTROKID_LIVE_SCANNER
 * AND a recorded legal-review approval. Call at the point a live scan would run.
 */
export function assertDistroKidLiveScannerAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const f = readDistributorLinkFlags(env);
  if (!f.enableDistroKidLiveScanner) {
    throw new InsecureConfigurationError('Live DistroKid scanning is disabled. Set ENABLE_DISTROKID_LIVE_SCANNER=true only after legal review.');
  }
  if (!f.legalReviewDistroKidScannerApproved) {
    throw new InsecureConfigurationError('Live DistroKid scanning requires LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED=true (recorded legal-review approval).');
  }
  if (isProductionEnvironment(env)) {
    try {
      verifyComplianceApproval(env);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'signed approval verification failed';
      throw new InsecureConfigurationError(`Live DistroKid scanning requires a valid signed compliance approval: ${reason}`);
    }
  }
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Centralized startup validation (spec Phase 2 "Hard startup rules"). Call once
 * at API/worker boot. Fails fast on any unsafe or incomplete production config.
 * `isTest` relaxes the encryption-key/DB/Redis requirements for unit tests.
 */
export function validateServerConfig(env: NodeJS.ProcessEnv = process.env): void {
  const isProd = isProductionEnvironment(env);
  const isTest = isTestEnvironment(env);

  // 1. Hosted credential form: forbidden in every environment.
  assertNoHostedCredentialForm(env);

  // 2. Selected provider must be enabled.
  assertProviderEnabled(env);

  // 3. Live DistroKid scanner requires the legal-review flag when enabled.
  if (boolEnv(env.ENABLE_DISTROKID_LIVE_SCANNER, false) && !boolEnv(env.LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED, false)) {
    throw new ConfigValidationError('ENABLE_DISTROKID_LIVE_SCANNER=true requires LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED=true.');
  }
  if (isProd && boolEnv(env.ENABLE_DISTROKID_LIVE_SCANNER, false)) {
    try {
      verifyComplianceApproval(env);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'signed approval verification failed';
      throw new ConfigValidationError(`Production live scanning requires a valid signed compliance approval: ${reason}`);
    }
  }

  // 4. Production session/state encryption is KMS-only. The same KMS key, region, and
  // encryption context must be available to every API/worker replica. Static local KEKs are
  // intentionally limited to development/tests and cannot be selected in production.
  const kmsKeyId = env.KMS_KEY_ID?.trim();
  const localMasterKey = env.ENCRYPTION_MASTER_KEY?.trim();
  if (kmsKeyId && localMasterKey) {
    throw new ConfigValidationError('Configure exactly one envelope key provider: KMS_KEY_ID or ENCRYPTION_MASTER_KEY, not both.');
  }
  if (isProd && !kmsKeyId) {
    throw new ConfigValidationError('KMS_KEY_ID is required in production; ENCRYPTION_MASTER_KEY is development/test-only.');
  }
  if (isProd && [env.KMS_ENDPOINT, env.AWS_ENDPOINT_URL_KMS, env.AWS_ENDPOINT_URL].some((value) => value?.trim())) {
    throw new ConfigValidationError('Custom AWS/KMS endpoints are not permitted in production; use the AWS KMS regional endpoint.');
  }
  if (kmsKeyId) {
    if (kmsKeyId.length > 2_048) throw new ConfigValidationError('KMS_KEY_ID is invalid.');
    const region = (env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim();
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/.test(region)) {
      throw new ConfigValidationError('AWS_REGION (or AWS_DEFAULT_REGION) is required and must be a valid AWS region when KMS_KEY_ID is set.');
    }
    if (isProd) {
      try { validateProductionKmsKeyId(kmsKeyId, region); }
      catch (error) { throw new ConfigValidationError(error instanceof Error ? error.message : 'KMS_KEY_ID is invalid.'); }
    }
    try {
      if (isProd) parseProductionKmsEncryptionContext(env.KMS_ENCRYPTION_CONTEXT);
      else parseKmsEncryptionContext(env.KMS_ENCRYPTION_CONTEXT);
    }
    catch (error) { throw new ConfigValidationError(error instanceof Error ? error.message : 'KMS_ENCRYPTION_CONTEXT is invalid.'); }
  }
  if (!isTest && !isProd && !kmsKeyId && !localMasterKey) {
    throw new ConfigValidationError('ENCRYPTION_MASTER_KEY is required for local development when KMS_KEY_ID is not configured.');
  }
  if (!isProd && localMasterKey) {
    try {
      decodeMasterKeyBase64(localMasterKey);
    } catch {
      throw new ConfigValidationError('ENCRYPTION_MASTER_KEY must be canonical base64 for exactly 32 random bytes.');
    }
  }

  // History cursors are HMAC-signed locally and therefore use a distinct deploy secret rather
  // than reusing a KMS encryption key. Never fall back to the public development constant in
  // production.
  if (isProd) {
    try { decodeMasterKeyBase64(env.HISTORY_CURSOR_SIGNING_KEY ?? ''); }
    catch { throw new ConfigValidationError('HISTORY_CURSOR_SIGNING_KEY must be canonical base64 for exactly 32 random bytes in production.'); }
  }

  // 5. Production requires durable datastores.
  if (isProd) {
    if (!env.DATABASE_URL?.trim()) throw new ConfigValidationError('DATABASE_URL is required in production (no in-memory persistence).');
    // The committed Prisma migrations contain both the operational and scan tables, and the
    // release job applies them to DATABASE_URL. Historically SCAN_DATABASE_URL was advertised as
    // a separate database even though no second migration ran, so candidate/outcome writes failed
    // only after a live scan began. Keep the compatibility alias only when it is exactly the same
    // migrated database; fail at boot for an unsupported split deployment.
    if (env.SCAN_DATABASE_URL?.trim() && env.SCAN_DATABASE_URL.trim() !== env.DATABASE_URL.trim()) {
      throw new ConfigValidationError(
        'A distinct SCAN_DATABASE_URL is not supported in production because only DATABASE_URL is migrated; unset it or set it exactly equal to DATABASE_URL.',
      );
    }
    if (!env.REDIS_URL) throw new ConfigValidationError('REDIS_URL is required in production (no in-process job runner).');
    if (!boolEnv(env.ENABLE_KEYCLOAK_AUTH, false)) throw new ConfigValidationError('ENABLE_KEYCLOAK_AUTH=true is required in production.');
    if (!env.KEYCLOAK_BASE_URL?.trim()) throw new ConfigValidationError('KEYCLOAK_BASE_URL is required in production.');
    productionHttpsUrl('KEYCLOAK_BASE_URL', env.KEYCLOAK_BASE_URL.trim());
    if (!(env.KEYCLOAK_API_AUDIENCE || env.KEYCLOAK_API_CLIENT_ID)) {
      throw new ConfigValidationError('KEYCLOAK_API_AUDIENCE or KEYCLOAK_API_CLIENT_ID is required in production for JWT audience validation.');
    }
    if ((env.DEEP_SCAN_DISPATCH ?? '').toLowerCase() !== 'bullmq') throw new ConfigValidationError('DEEP_SCAN_DISPATCH=bullmq is required in production.');
    if (!boolEnv(env.STEEL_REQUIRED, false)) throw new ConfigValidationError('STEEL_REQUIRED=true is required in production.');
    const steelMode = (env.STEEL_CONNECTOR_MODE ?? '').toLowerCase();
    if (!['cloud', 'external', 'self_hosted'].includes(steelMode)) throw new ConfigValidationError('STEEL_CONNECTOR_MODE must be cloud, external, or self_hosted in production.');
    if (steelMode === 'cloud' && !env.STEEL_API_KEY) throw new ConfigValidationError('STEEL_API_KEY is required for Steel cloud mode.');
    if (steelMode === 'cloud' && env.STEEL_API_URL?.trim()) productionHttpsUrl('STEEL_API_URL cloud override', env.STEEL_API_URL.trim());
    if (steelMode === 'external' || steelMode === 'self_hosted') {
      if (!env.STEEL_API_URL?.trim()) throw new ConfigValidationError('STEEL_API_URL is required for external/self_hosted Steel mode.');
      productionHttpsUrl('STEEL_API_URL', env.STEEL_API_URL.trim());
    }
    productionViewerOrigins(env.STEEL_VIEWER_ORIGINS);
    const steelSessionTimeoutMs = Number(env.STEEL_SESSION_TIMEOUT_MS);
    if (!Number.isSafeInteger(steelSessionTimeoutMs) || steelSessionTimeoutMs <= 0) {
      throw new ConfigValidationError('STEEL_SESSION_TIMEOUT_MS must be explicitly set to a positive integer in production and approved against the selected Steel plan.');
    }
    const catalogReadMaxDurationMs = Number(env.CATALOG_READ_MAX_DURATION_MS);
    if (!Number.isSafeInteger(catalogReadMaxDurationMs) || catalogReadMaxDurationMs <= 0) {
      throw new ConfigValidationError('CATALOG_READ_MAX_DURATION_MS must be explicitly set to a positive integer in production.');
    }
    const cleanupReserveMs = 60_000;
    if (steelSessionTimeoutMs < catalogReadMaxDurationMs + cleanupReserveMs) {
      throw new ConfigValidationError(
        'STEEL_SESSION_TIMEOUT_MS must cover CATALOG_READ_MAX_DURATION_MS plus the 60000ms terminal cleanup reserve.',
      );
    }
    const catalogReleaseCap = Number(env.CATALOG_READ_MAX_RELEASES);
    if (!Number.isSafeInteger(catalogReleaseCap) || catalogReleaseCap <= 0) {
      throw new ConfigValidationError('CATALOG_READ_MAX_RELEASES must be explicitly set to a positive integer in production and load-tested within the Steel lease.');
    }
    const pacingAndCleanupFloorMs = catalogReleaseCap * 750 + cleanupReserveMs;
    if (!Number.isSafeInteger(pacingAndCleanupFloorMs) || catalogReadMaxDurationMs < pacingAndCleanupFloorMs) {
      throw new ConfigValidationError(
        'CATALOG_READ_MAX_DURATION_MS must cover CATALOG_READ_MAX_RELEASES at the enforced 750ms per-release pacing floor plus the 60000ms cleanup reserve.',
      );
    }
    for (const [name, fallback, minimum, maximum] of [
      ['DEEP_SCAN_MAX_TRACKS_PER_SCAN', 20_000, 1, 100_000],
      ['DEEP_SCAN_TRACK_CHUNK_SIZE', 25, 1, 1_000],
      ['DEEP_SCAN_MAX_DISTINCT_ARTISTS', 5_000, 1, 20_000],
      ['DSP_CATALOG_MAX_TRACKS_PER_ARTIST', 20_000, 1, 100_000],
      ['DSP_CATALOG_FETCH_CONCURRENCY', 2, 1, 16],
    ] as const) {
      const configured = Number(env[name] ?? fallback);
      if (!Number.isSafeInteger(configured) || configured < minimum || configured > maximum) {
        throw new ConfigValidationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
      }
    }
    const steelApiRequestTimeoutMs = env.STEEL_API_REQUEST_TIMEOUT_MS?.trim()
      ? Number(env.STEEL_API_REQUEST_TIMEOUT_MS)
      : 10_000;
    if (!Number.isSafeInteger(steelApiRequestTimeoutMs) || steelApiRequestTimeoutMs < 100 || steelApiRequestTimeoutMs > 60_000) {
      throw new ConfigValidationError('STEEL_API_REQUEST_TIMEOUT_MS must be an integer between 100 and 60000.');
    }
    const connectClaimVisibilityMs = env.CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS?.trim()
      ? Number(env.CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS)
      : 60_000;
    if (!Number.isSafeInteger(connectClaimVisibilityMs) || connectClaimVisibilityMs < 1_000 || connectClaimVisibilityMs > 300_000) {
      throw new ConfigValidationError('CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS must be an integer between 1000 and 300000.');
    }
    if (connectClaimVisibilityMs < steelApiRequestTimeoutMs + 5_000) {
      throw new ConfigValidationError(
        'CONNECT_CLAIM_VISIBILITY_TIMEOUT_MS must cover STEEL_API_REQUEST_TIMEOUT_MS plus a 5000ms cancellation-ack reserve.',
      );
    }
    const consentRevocationLeaseMs = env.CONSENT_REVOCATION_LEASE_MS?.trim()
      ? Number(env.CONSENT_REVOCATION_LEASE_MS)
      : 30_000;
    if (!Number.isSafeInteger(consentRevocationLeaseMs) || consentRevocationLeaseMs < 5_000 || consentRevocationLeaseMs > 300_000) {
      throw new ConfigValidationError('CONSENT_REVOCATION_LEASE_MS must be an integer between 5000 and 300000.');
    }
    if (consentRevocationLeaseMs < steelApiRequestTimeoutMs + 5_000) {
      throw new ConfigValidationError(
        'CONSENT_REVOCATION_LEASE_MS must cover STEEL_API_REQUEST_TIMEOUT_MS plus a 5000ms completion reserve.',
      );
    }
    if ((env.BROWSER_LINK_PROVIDER ?? '').trim().toLowerCase() !== 'steel') {
      throw new ConfigValidationError('BROWSER_LINK_PROVIDER=steel is required in production; Steel sessions are the only supported production browser path.');
    }
    for (const unsafe of ['ENABLE_LOCAL_HEADLESS_CONNECTOR', 'ENABLE_BROWSERLESS_PROVIDER', 'ENABLE_HYPERBEAM_PROVIDER', 'ENABLE_KASM_PROVIDER', 'ENABLE_LEGACY_DOM_SCANNER']) {
      if (boolEnv(env[unsafe], false)) throw new ConfigValidationError(`${unsafe}=true is not permitted in production.`);
    }
    if (!boolEnv(env.ENABLE_DISTROKID_LIVE_SCANNER, false) || !boolEnv(env.LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED, false)) {
      throw new ConfigValidationError('Production distributor scanning requires both ENABLE_DISTROKID_LIVE_SCANNER=true and LEGAL_REVIEW_DISTROKID_SCANNER_APPROVED=true.');
    }
    if (!env.APP_BASE_URL || !/^https:\/\//i.test(env.APP_BASE_URL)) throw new ConfigValidationError('APP_BASE_URL must be an HTTPS URL in production.');
  }

  // 6. BullMQ deep-scan dispatch requires Redis to enqueue to.
  if ((env.DEEP_SCAN_DISPATCH ?? '').toLowerCase() === 'bullmq' && !env.REDIS_URL) {
    throw new ConfigValidationError('DEEP_SCAN_DISPATCH=bullmq requires REDIS_URL (the deep-scan queue transport).');
  }
}
