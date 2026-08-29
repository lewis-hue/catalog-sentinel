import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { createSearchProvider, type SearchProvider } from '@sentinel/adapters';
import { probeSteelHealth, isSteelRequired, type SteelHealth } from '@sentinel/steel';
import {
  assertDistroKidLiveScannerAllowed,
  InsecureConfigurationError,
  isProductionEnvironment,
} from '@sentinel/security';
import { assertScanRecordsSchema } from '@sentinel/search-store';

export type DepStatus = 'ok' | 'down' | 'degraded' | 'disabled' | 'not-configured';

export interface DepResult {
  name: string;
  status: DepStatus;
  detail?: string;
  latencyMs?: number;
}

export interface HealthDeps {
  redis?: Redis | null;
  pgPool?: Pool | null;
  /** Observes queue DEPTH only. A health check should not be handed something it could enqueue
   *  or obliterate with. */
  presenceCounts?: (() => Promise<Record<string, number>>) | null;
  env?: NodeJS.ProcessEnv;
}

export interface DistributorLoginHealth extends SteelHealth {
  /**
   * Steel can be healthy while the operator's legal/live-scan gate is disabled. Keep that
   * distinction explicit so the Connect page never advertises a flow that /api/connect must
   * reject.
   */
  connectionPolicyReady: boolean;
}

/** Per-platform integration posture. Never carries secret values, only config presence. */
export interface PlatformCredential {
  platform: string;
  mode: 'official-api' | 'web-verify';
  status: 'ready' | 'credential-required';
  /** Config keys still missing (names only, never values). Empty when ready. */
  requires: string[];
  /** Public artist profile URL if configured (not a secret); null otherwise. */
  profileUrl: string | null;
}

const REDACT = (s: string): string => s.replace(/:\/\/[^@\s]+@/g, '://***@'); // strip creds from URLs

function timeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms))]);
}
const msg = (e: unknown): string => REDACT(e instanceof Error ? e.message : String(e));

/**
 * Dependency health for /health/* and the ops status endpoints. Every probe is bounded
 * by a timeout and never throws; a disabled dependency reports `disabled`, not `down`.
 * No secrets are emitted, URLs are credential-stripped and only names/status/latency are
 * returned.
 */
export class HealthChecker {
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly deps: HealthDeps) {
    this.env = deps.env ?? process.env;
  }

  async redis(): Promise<DepResult> {
    if (!this.deps.redis) return { name: 'redis', status: 'disabled', detail: 'REDIS_URL not set (in-memory mode)' };
    const t0 = Date.now();
    try {
      const pong = await timeout(this.deps.redis.ping(), 2000, 'redis');
      return { name: 'redis', status: pong === 'PONG' ? 'ok' : 'degraded', latencyMs: Date.now() - t0 };
    } catch (e) {
      return { name: 'redis', status: 'down', detail: msg(e) };
    }
  }

  async scanPostgres(): Promise<DepResult> {
    if (!this.deps.pgPool) return { name: 'scan-postgres', status: 'disabled', detail: 'DATABASE_URL not set (no durable scan store)' };
    const t0 = Date.now();
    try {
      // Connectivity alone is insufficient: an unapplied migration used to look healthy until
      // the first customer write failed. Validate the migration-owned table contract read-only.
      await timeout(assertScanRecordsSchema(this.deps.pgPool), 2500, 'postgres schema');
      const auditSchema = await timeout(
        this.deps.pgPool.query<{ complete: boolean }>(`
          SELECT to_regclass('public.security_audit_events') IS NOT NULL
            AND (SELECT count(*) FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'security_audit_events'
                   AND column_name = ANY (ARRAY['id','occurred_at','tenant_id','workspace_id',
                     'actor_user_id','action','target_type','target_id','metadata'])) = 9 AS complete
        `),
        2500,
        'audit schema',
      );
      if (auditSchema.rows[0]?.complete !== true) {
        throw new Error('database schema is incomplete: security_audit_events migration is required');
      }
      if (isProductionEnvironment(this.env)) {
        const role = await timeout(
          this.deps.pgPool.query<{ allowed: boolean }>(
            `SELECT pg_has_role(current_user, 'sentinel_api_runtime', 'member') AS allowed`,
          ),
          2500,
          'database runtime role',
        );
        if (role.rows[0]?.allowed !== true) {
          throw new Error('database credential is not a member of sentinel_api_runtime');
        }
      }
      return { name: 'scan-postgres', status: 'ok', latencyMs: Date.now() - t0 };
    } catch (e) {
      return { name: 'scan-postgres', status: 'down', detail: msg(e) };
    }
  }


  async keycloak(): Promise<DepResult> {
    if (!/^(1|true|yes|on)$/i.test(this.env.ENABLE_KEYCLOAK_AUTH ?? '')) return { name: 'keycloak', status: 'disabled', detail: 'authentication disabled' };
    const base = (this.env.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, '');
    const realm = this.env.KEYCLOAK_REALM ?? 'sentinel';
    if (!base) return { name: 'keycloak', status: 'not-configured', detail: 'ENABLE_KEYCLOAK_AUTH set but KEYCLOAK_BASE_URL missing' };
    const t0 = Date.now();
    try {
      const resp = await timeout(fetch(`${base}/realms/${realm}/.well-known/openid-configuration`), 3000, 'keycloak');
      return { name: 'keycloak', status: resp.ok ? 'ok' : 'degraded', latencyMs: Date.now() - t0, detail: resp.ok ? undefined : `HTTP ${resp.status}` };
    } catch (e) {
      return { name: 'keycloak', status: 'down', detail: msg(e) };
    }
  }

  async queue(): Promise<DepResult & { counts?: Record<string, number> }> {
    if (!this.deps.presenceCounts) return { name: 'bullmq', status: 'disabled', detail: 'no queue configured' };
    try {
      const counts = await timeout(this.deps.presenceCounts(), 2500, 'bullmq');
      return { name: 'bullmq', status: 'ok', counts };
    } catch (e) {
      return { name: 'bullmq', status: 'down', detail: msg(e) };
    }
  }

  /** Worker liveness: the presence worker writes a heartbeat key; fresh (<45s) = ok. */
  async workerHeartbeat(): Promise<DepResult> {
    return this.heartbeat('worker', 'sentinel:hb:presence-worker');
  }

  /** The network-first DistroKid pipeline has its own consumer heartbeat. */
  async pipelineHeartbeat(): Promise<DepResult> {
    return this.heartbeat('distrokid-pipeline', 'sentinel:hb:distrokid-pipeline');
  }

  private async heartbeat(name: string, key: string): Promise<DepResult> {
    if (!this.deps.redis) return { name, status: 'disabled' };
    try {
      const raw = await timeout(this.deps.redis.get(key), 2000, `${name}-hb`);
      if (!raw) return { name, status: 'down', detail: 'no heartbeat (consumer not running?)' };
      const ageMs = Date.now() - Number(raw);
      return { name, status: ageMs < 45_000 ? 'ok' : 'degraded', detail: `heartbeat ${Math.round(ageMs / 1000)}s ago` };
    } catch (e) {
      return { name, status: 'down', detail: msg(e) };
    }
  }

  searchProviderStatus(): { provider: string | null; healthy: boolean; breaker: string; selfHosted: boolean; consecutiveFailures: number } {
    const p: SearchProvider | null = createSearchProvider(this.env);
    if (!p) return { provider: null, healthy: false, breaker: 'none', selfHosted: false, consecutiveFailures: 0 };
    const h = p.getHealth();
    return { provider: p.provider, healthy: h.healthy, breaker: h.breaker, selfHosted: p.getCapabilities().selfHosted, consecutiveFailures: h.consecutiveFailures };
  }

  /**
   * Per-platform credential status. NEVER returns secret values, only whether the
   * required config keys are present, which keys are still needed, and the public
   * profile URL (not a secret) when one is configured.
   */
  credentialStatus(): PlatformCredential[] {
    const has = (...keys: string[]): boolean => keys.every((k) => Boolean(this.env[k]));
    const need = (...keys: string[]): string[] => keys.filter((k) => !this.env[k]);
    const url = (k: string): string | null => {
      const v = this.env[k];
      return v && v.trim() ? v.trim() : null;
    };
    const official = (platform: string, keys: string[], profileKey?: string): PlatformCredential => ({
      platform,
      mode: 'official-api',
      status: has(...keys) ? 'ready' : 'credential-required',
      requires: need(...keys),
      profileUrl: profileKey ? url(profileKey) : null,
    });
    const web = (platform: string): PlatformCredential => ({ platform, mode: 'web-verify', status: 'ready', requires: [], profileUrl: null });
    return [
      { platform: 'Deezer', mode: 'official-api', status: 'ready', requires: [], profileUrl: null },
      { platform: 'Apple Music', mode: 'official-api', status: 'ready', requires: [], profileUrl: null },
      official('Spotify', ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']),
      official('YouTube', ['YOUTUBE_API_KEY']),
      official('Audiomack', ['AUDIOMACK_CONSUMER_KEY', 'AUDIOMACK_CONSUMER_SECRET'], 'AUDIOMACK_PROFILE_URL'),
      official('SoundCloud', ['SOUNDCLOUD_CLIENT_ID', 'SOUNDCLOUD_CLIENT_SECRET'], 'SOUNDCLOUD_PROFILE_URL'),
      official('TIDAL', ['TIDAL_CLIENT_ID', 'TIDAL_CLIENT_SECRET'], 'TIDAL_PROFILE_URL'),
      web('Amazon Music'),
      web('Boomplay'),
      web('Anghami'),
      web('Pandora'),
      web('Napster'),
    ];
  }

  /** Steel Browser connector status (cloud | external | self_hosted). Never throws; no secrets. */
  async steel(): Promise<SteelHealth> {
    return probeSteelHealth(this.env as Record<string, string | undefined>);
  }

  /**
   * User-facing attended-login readiness. This is deliberately stricter than dependency health:
   * a reachable Steel control plane is not authorization to run the DistroKid workflow.
   */
  async distributorLogin(): Promise<DistributorLoginHealth> {
    const steel = await this.steel();
    try {
      assertDistroKidLiveScannerAllowed(this.env);
      return { ...steel, connectionPolicyReady: true };
    } catch (error) {
      if (!(error instanceof InsecureConfigurationError)) throw error;
      return {
        ...steel,
        liveLoginAvailable: false,
        loginMode: 'disabled',
        connectionPolicyReady: false,
        message: steel.status === 'READY'
          ? 'Steel is ready, but DistroKid live login is disabled by deployment policy.'
          : steel.message,
      };
    }
  }

  /** Full dependency snapshot. `status` is the worst non-disabled dependency state. */
  async dependencies(): Promise<{ status: 'ok' | 'degraded' | 'down'; checkedAt: string; deps: DepResult[]; searchProvider: ReturnType<HealthChecker['searchProviderStatus']>; steel: SteelHealth }> {
    const [core, steel] = await Promise.all([
      Promise.all([this.redis(), this.scanPostgres(), this.keycloak(), this.queue(), this.workerHeartbeat(), this.pipelineHeartbeat()]),
      this.steel(),
    ]);
    const deps = [...core, steelToDep(steel)];
    const live = deps.filter((d) => d.status !== 'disabled' && d.status !== 'not-configured');
    const status = live.some((d) => d.status === 'down') ? 'down' : live.some((d) => d.status === 'degraded') ? 'degraded' : 'ok';
    return { status, checkedAt: new Date().toISOString(), deps, searchProvider: this.searchProviderStatus(), steel };
  }

  /**
   * Readiness: critical dependencies (redis + postgres when configured) must be ok.
   * When STEEL_REQUIRED=true, a non-READY Steel also fails readiness (production gate).
   */
  async ready(): Promise<{ ready: boolean; deps: DepResult[] }> {
    const isProd = isProductionEnvironment(this.env);
    const critical = isProd
      ? await Promise.all([this.redis(), this.scanPostgres(), this.keycloak(), this.queue(), this.workerHeartbeat(), this.pipelineHeartbeat()])
      : await Promise.all([this.redis(), this.scanPostgres()]);
    let ready = critical.every((d) => isProd ? d.status === 'ok' : d.status === 'ok' || d.status === 'disabled');
    const deps = [...critical];
    if (isProd || isSteelRequired(this.env as Record<string, string | undefined>)) {
      const steel = await this.steel();
      const dep = steelToDep(steel);
      deps.push(dep);
      if (steel.status !== 'READY') ready = false;
    }
    return { ready, deps };
  }
}

/** Map the Steel connector status onto the dependency-health vocabulary. */
function steelToDep(h: SteelHealth): DepResult {
  const status: DepStatus =
    h.status === 'READY' ? 'ok'
      : h.status === 'UNSUPPORTED_LOCAL_ENV' || h.status === 'DISABLED' ? 'disabled'
        : h.status === 'MISCONFIGURED' ? 'degraded'
          : /* UNREACHABLE */ h.required ? 'down' : 'degraded';
  return { name: 'steel', status, detail: `${h.mode} · ${h.status}` };
}
