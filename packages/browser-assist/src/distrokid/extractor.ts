import type { Page } from 'playwright';
import { installDistributorNetworkDiscovery, type DiscoveryHandle, type CandidateSink, type CandidateScope, type ResponseMatchPolicy } from './network-discovery';
import { attachCdpNetworkCapture, type CdpCaptureHandle } from './cdp-network';
import { ParserRegistry } from './parser-registry';
import { EndpointRegistry, type EndpointRole } from './endpoint-registry';
import { inferRole, mergeCanonicalRelease } from './endpoint-bundle';
import { DirectJsonReader, isDirectReaderAllowed, type DirectReaderFlags } from './direct-reader';
import { MIN_CATALOG_SCORE } from './candidate-scoring';
import {
  isExtractionFailure, notCaptured,
  type CanonicalDistributorRelease, type MetadataSource,
  type ReleaseExtractionOutcome, type ReleaseFailureReason,
} from './metadata-model';
import { installReadOnlyGuard, type ReadOnlyGuard } from '../read-only-guard';

/**
 * NETWORK-FIRST release extractor.
 *
 * Extraction hierarchy (in order; DOM is never primary):
 *   1. Official/approved distributor API        — not available for DistroKid
 *   2. Observed authenticated JSON response     — DEFAULT (passive capture)
 *   3. Authenticated request replay             — gated behind feature + legal flags
 *   4. Embedded page/hydration state
 *   5. DOM extraction with event-based waits    — FALLBACK ONLY
 *   6. User-uploaded CSV/export                 — handled elsewhere
 *
 * The key inversion: listeners are installed BEFORE navigation and we wait for the metadata
 * RESPONSE, never for a component to render. No fixed sleeps are used for synchronization.
 */

export interface ReleaseRef {
  releaseId: string;
  dashboardUrl: string;
  /** List-level fallback info, so a failure still records what the index knew. */
  title?: string;
  artist?: string;
  /** Independently observed count from the catalogue index, when available. */
  expectedTrackCount?: number;
}

export interface ExtractorOptions {
  origin: string;
  distributor: string;
  gotoTimeoutMs?: number;
  /** How long to wait for the metadata RESPONSE (not the DOM). */
  responseTimeoutMs?: number;
  /** Enable the CDP body-read fallback for responses Playwright can't read. */
  enableCdpFallback?: boolean;
  /** When the first response has gaps, how long to wait for a sibling endpoint in the bundle. */
  bundleGraceMs?: number;
  directReaderFlags?: DirectReaderFlags;
  /**
   * Per-run policy for the gated direct reader. Flags alone are NOT enough: legal approval is
   * necessary but is not the same as user consent or an operator's decision for this run.
   *  - 'never' (default): passive capture only, even when both flags are true.
   *  - 'after-passive-timeout': try direct replay ONLY when passive capture yielded nothing.
   */
  directReplayPolicy?: 'never' | 'after-passive-timeout';
  /** Observed release-details endpoint URL template for the gated direct reader. */
  directEndpointFor?: (releaseId: string) => string | undefined;
  candidateSink?: CandidateSink;
  /** Tenant + scan each candidate is attributed to. REQUIRED with candidateSink — without it the
   *  sink is skipped (a scope is never inferred from shared mutable state). */
  candidateScope?: CandidateScope;
  /** Embedded hydration-state reader (tier 4). Runs in the page; returns a payload or null. */
  readPageState?: (page: Page) => Promise<unknown | null>;
  /** DOM fallback (tier 5). Only used when no JSON was captured. */
  readDom?: (page: Page) => Promise<CanonicalDistributorRelease | null>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface ExtractorDeps {
  parsers: ParserRegistry;
  registry?: EndpointRegistry;
}

/** Discovery run over a small sample → an automatically ranked candidate report. */
export interface DiscoveryRunResult {
  candidates: ReturnType<DiscoveryHandle['report']>;
  sampled: number;
}

export class NetworkFirstExtractor {
  private discovery: DiscoveryHandle | null = null;
  private cdp: CdpCaptureHandle | null = null;
  private direct: DirectJsonReader | null = null;
  private readOnlyGuard: ReadOnlyGuard | null = null;

  constructor(
    private readonly page: Page,
    private readonly opts: ExtractorOptions,
    private readonly deps: ExtractorDeps,
  ) {}

  /**
   * Install capture. MUST be called before the first navigation — that's the whole point:
   * a response that arrives before we listen is lost, which is how metadata went missing.
   */
  async install(allowedReleaseIds: ReadonlySet<string> = new Set()): Promise<void> {
    await this.readOnlyGuard?.dispose().catch(() => undefined);
    this.readOnlyGuard = await installReadOnlyGuard(this.page.context());
    this.readOnlyGuard.enterExtractionMode();
    // The chunk's release ids double as the correlation vocabulary: a response is tied to a
    // release by finding one of THESE ids in the request, rather than by guessing which URL
    // segment is an identifier or by trusting what we happened to be navigating at the time.
    this.discovery = installDistributorNetworkDiscovery(this.page.context(), {
      origin: this.opts.origin,
      knownReleaseIds: allowedReleaseIds,
      ...(this.opts.candidateSink && this.opts.candidateScope ? { sink: this.opts.candidateSink, scope: this.opts.candidateScope } : {}),
      minScore: MIN_CATALOG_SCORE,
    });
    if (this.opts.enableCdpFallback) {
      this.cdp = await attachCdpNetworkCapture(this.page, { origin: this.opts.origin, knownReleaseIds: allowedReleaseIds }).catch(() => null);
    }
    if (this.opts.directReaderFlags && isDirectReaderAllowed(this.opts.directReaderFlags)) {
      this.direct = new DirectJsonReader(this.opts.directReaderFlags, this.opts.origin, allowedReleaseIds);
      this.opts.log?.('direct JSON reader ENABLED (feature + legal review approved)');
    }
  }

  /** DISCOVERY MODE: sample a few releases and rank what served catalog JSON. */
  async discover(sample: ReleaseRef[]): Promise<DiscoveryRunResult> {
    if (!this.discovery) await this.install();
    for (const ref of sample) {
      this.discovery!.setCurrentRelease(ref.releaseId);
      this.discovery!.resetCaptures();
      await this.page.goto(ref.dashboardUrl, { waitUntil: 'commit', timeout: this.opts.gotoTimeoutMs ?? 30_000 }).catch(() => undefined);
      // Give the SPA's own requests a chance to land — bounded by a RESPONSE wait, not a sleep.
      await this.discovery!.waitForCatalogResponse(this.opts.responseTimeoutMs ?? 20_000, 1).catch(() => null);
    }
    const candidates = this.discovery!.report();
    // Feed the registry so promotion/demotion is automatic, not a manual log read.
    if (this.deps.registry) {
      for (const c of candidates) {
        await this.deps.registry.observe(c, inferRole(c), this.deps.parsers.versions[0] ?? 'unknown');
      }
    }
    return { candidates, sampled: sample.length };
  }

  /**
   * PRODUCTION MODE: extract one release. Waits for the metadata RESPONSE, parses it through the
   * versioned registry, and only falls back down the hierarchy if no JSON was captured.
   * Always returns a TERMINAL outcome — never a silent skip.
   */
  async extractRelease(ref: ReleaseRef): Promise<ReleaseExtractionOutcome> {
    const started = Date.now();
    if (!this.discovery) await this.install();
    const d = this.discovery!;
    d.setCurrentRelease(ref.releaseId);
    d.resetCaptures();
    this.cdp?.setCurrentRelease(ref.releaseId);
    this.cdp?.resetCaptures();

    const fail = (reason: ReleaseFailureReason, detail: string): ReleaseExtractionOutcome =>
      ({ kind: 'FAILED', distributorReleaseId: ref.releaseId, reason, detail, elapsedMs: Date.now() - started });

    try {
      if (!isAllowedDistributorUrl(ref.dashboardUrl, this.opts.origin)) {
        return fail('NOT_AUTHORIZED', 'release URL is outside the configured distributor HTTPS origin');
      }
      // Which endpoint profiles are ACTIVE for release data. Loaded BEFORE navigation so the
      // policy is in force for responses that land immediately after `goto` resolves.
      const policy = await this.releaseMatchPolicy(ref.releaseId);

      // Tier 2 (DEFAULT): passive capture. Navigate, then wait for the metadata RESPONSE the
      // dashboard itself fetched — not the DOM. This is ALWAYS attempted first: enabling the
      // direct-reader flags must not silently change the operational default to request replay.
      await this.page.goto(ref.dashboardUrl, { waitUntil: 'commit', timeout: this.opts.gotoTimeoutMs ?? 30_000 });
      if (!isAllowedDistributorUrl(this.page.url(), this.opts.origin)) {
        return fail('NOT_AUTHORIZED', 'distributor navigation redirected outside the configured HTTPS origin');
      }
      const hit =
        (await d.waitForMatchingResponse(policy, this.opts.responseTimeoutMs ?? 20_000)) ??
        (this.cdp ? await this.cdp.waitForCatalogResponse(2_000) : null);

      if (hit) {
        const parsed = this.deps.parsers.parse(hit.payload, 'NETWORK_JSON');
        if (parsed.ok) {
          // A single response may not carry every field (an endpoint BUNDLE). If the first
          // response has gaps, give a sibling endpoint a short, EVENT-DRIVEN window to land
          // (not a fixed sleep) — otherwise we'd merge before the ISRC response arrives.
          if (hasGaps(parsed.release)) {
            await d.waitForDifferentEndpoint(hit.fingerprint, this.opts.bundleGraceMs ?? 2_000);
          }
          // Fill gaps from EVERY other catalog payload captured during this navigation.
          const merged = this.mergeFromOtherCaptures(parsed.release, hit.fingerprint, ref.releaseId);
          await this.deps.registry?.recordSuccess(hit.fingerprint, hit.schemaHash);
          return this.complete(ref, merged, 'NETWORK_JSON', started, hit.fingerprint);
        }
        // Schema drift: do NOT guess. Degrade the endpoint, alert, then try lower tiers.
        await this.deps.registry?.recordSchemaDrift(hit.fingerprint, hit.schemaHash);
        await this.deps.registry?.recordFailure(hit.fingerprint, 'SCHEMA_CHANGED');
        const lower = await this.tryLowerTiers(ref, started);
        return lower ?? fail('SCHEMA_CHANGED', parsed.detail);
      }

      // Tier 3 (GATED, and only AFTER passive capture failed): authenticated request replay.
      // Requires both flags AND an explicit per-run selection — legal approval alone is not
      // consent to change the default. The selection is recorded for the audit trail.
      if (this.direct && !this.direct.isHalted && this.opts.directReplayPolicy === 'after-passive-timeout') {
        const url = this.opts.directEndpointFor?.(ref.releaseId);
        if (url) {
          this.opts.log?.('falling back to gated direct JSON replay', { releaseId: ref.releaseId, mode: 'DIRECT_JSON', policy: 'after-passive-timeout' });
          const res = await this.direct.fetchRelease(this.page, ref.releaseId, url);
          if (res.ok) {
            const parsed = this.deps.parsers.parse(res.payload, 'DIRECT_JSON');
            if (parsed.ok) return this.complete(ref, parsed.release, 'DIRECT_JSON', started);
          } else if (res.reason === 'REAUTH_REQUIRED') return fail('REAUTH_REQUIRED', res.detail);
        }
      }

      // Tiers 4–5: embedded page state, then DOM with event-based waits.
      const lower = await this.tryLowerTiers(ref, started);
      if (lower) return lower;
      return fail('TIMEOUT', `no catalog JSON observed within ${this.opts.responseTimeoutMs ?? 20_000}ms and no fallback data`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout/i.test(msg)) return fail('TIMEOUT', 'navigation timed out');
      return fail('REQUEST_FAILED', 'navigation or capture error');
    }
  }

  /**
   * Build the production response-match policy from the endpoint registry.
   *
   * Production previously selected the highest-scoring catalog-shaped response, which is a
   * DISCOVERY heuristic: it asks "does this look like catalog data?" rather than "is this the
   * response for the release I asked for?". A catalog index or a recommendations payload can
   * satisfy the first question and be parsed as the wrong release.
   *
   * So: constrain to ACTIVE profiles for the release-data roles and correlate the response to
   * this release id. The heuristic stays available only where it's still the right tool —
   * nothing is ACTIVE yet (bootstrap/discovery), or the profile is DEGRADED by schema drift and
   * refusing to fall back would strand every extraction.
   */
  private async releaseMatchPolicy(releaseId: string): Promise<ResponseMatchPolicy> {
    const registry = this.deps.registry;
    if (!registry) return { activeFingerprints: [], releaseId, allowHeuristic: true };

    const roles: EndpointRole[] = ['releaseDetails', 'trackIdentifiers', 'artwork'];
    const profiles = (await registry.list().catch(() => [])).filter((p) => roles.includes(p.role));

    // ONLY genuinely ACTIVE profiles may constrain. `registry.activeFor()` deliberately falls
    // back to VALIDATING/CANDIDATE for "what should we try?", but a candidate is an unproven
    // guess — treating it as authoritative here would let one lucky-looking payload lock out
    // the real endpoint before it was ever validated.
    const activeFingerprints = profiles.filter((p) => p.status === 'ACTIVE').map((p) => p.fingerprint);

    // A DEGRADED profile means the source schema moved under us. Refusing the heuristic there
    // would turn one schema change into a total outage, so allow it — the drift alert already
    // fired, and the versioned parser still guards correctness.
    const anyDegraded = profiles.some((p) => p.status === 'DEGRADED');

    const policy: ResponseMatchPolicy = {
      activeFingerprints,
      releaseId,
      allowHeuristic: activeFingerprints.length === 0 || anyDegraded,
    };
    if (activeFingerprints.length > 0) {
      this.opts.log?.('matching responses against ACTIVE endpoint profiles', {
        releaseId, profiles: activeFingerprints.length, heuristicAllowed: policy.allowHeuristic,
      });
    }
    return policy;
  }

  /** Tier 4 (hydration state) then tier 5 (DOM). Returns null when neither yields data. */
  private async tryLowerTiers(ref: ReleaseRef, started: number): Promise<ReleaseExtractionOutcome | null> {
    if (this.opts.readPageState) {
      const state = await this.opts.readPageState(this.page).catch(() => null);
      if (state) {
        const parsed = this.deps.parsers.parse(state, 'PAGE_STATE');
        if (parsed.ok) return this.complete(ref, parsed.release, 'PAGE_STATE', started);
      }
    }
    if (this.opts.readDom) {
      const dom = await this.opts.readDom(this.page).catch(() => null);
      if (dom) return this.complete(ref, dom, 'DOM', started);
    }
    return null;
  }

  /**
   * Merge gaps from EVERY other catalog payload captured during this navigation.
   *
   * A dashboard may split a release across endpoints (details here, ISRCs there, artwork
   * elsewhere), so we cannot rely on the single highest-scoring response — the identifiers
   * endpoint often scores LOWER than the details endpoint yet holds the ISRCs we need.
   */
  private mergeFromOtherCaptures(release: CanonicalDistributorRelease, usedFingerprint: string, expectedReleaseId: string): CanonicalDistributorRelease {
    const others = (this.discovery?.all() ?? []).filter((c) => c.fingerprint !== usedFingerprint && !c.namesOtherRelease);
    let merged = release;
    for (const other of others) {
      const extra = this.deps.parsers.parse(other.payload, 'NETWORK_JSON');
      if (!extra.ok) continue; // a non-matching sibling payload must not break the good one
      // Endpoint bundles may split identifiers/details, but shape alone is not correlation. Only
      // merge when the request named this release or the parsed payload independently names the
      // same release. This prevents a recommendations/index payload from donating a sibling UPC.
      const parsedId = extra.release.distributorReleaseId;
      const sameParsedRelease = !!parsedId && parsedId !== 'unknown' &&
        (parsedId === expectedReleaseId || parsedId === release.distributorReleaseId);
      if (other.correlation !== 'REQUEST_ID_MATCH' && !sameParsedRelease) continue;
      merged = this.fillGaps(merged, extra.release);
    }
    return merged;
  }

  /** Fill gaps from a partial release. Never overwrites a PRESENT value with a weaker one. */
  private fillGaps(base: CanonicalDistributorRelease, extra: CanonicalDistributorRelease): CanonicalDistributorRelease {
    return mergeCanonicalRelease(base, extra);
  }

  private complete(
    ref: ReleaseRef, release: CanonicalDistributorRelease, source: MetadataSource, started: number,
    endpointFingerprint?: string,
  ): ReleaseExtractionOutcome {
    if (release.tracks.length === 0) {
      return {
        kind: 'FAILED', distributorReleaseId: ref.releaseId, reason: 'PARSE_FAILED',
        detail: 'correlated release metadata contained no track rows', elapsedMs: Date.now() - started,
        ...(endpointFingerprint ? { endpointFingerprint } : {}),
      };
    }
    if (ref.expectedTrackCount !== undefined && release.tracks.length !== ref.expectedTrackCount) {
      return {
        kind: 'FAILED', distributorReleaseId: ref.releaseId, reason: 'PARSE_FAILED',
        detail: `track count mismatch (expected ${ref.expectedTrackCount}, extracted ${release.tracks.length})`,
        elapsedMs: Date.now() - started,
        ...(endpointFingerprint ? { endpointFingerprint } : {}),
      };
    }
    const releaseTitle = release.title.trim() || ref.title?.trim() || '';
    if (!releaseTitle) {
      return {
        kind: 'FAILED', distributorReleaseId: ref.releaseId, reason: 'PARSE_FAILED',
        detail: 'correlated release metadata and catalog index contained no release title',
        elapsedMs: Date.now() - started,
        ...(endpointFingerprint ? { endpointFingerprint } : {}),
      };
    }
    const withId: CanonicalDistributorRelease = {
      ...release,
      distributorReleaseId: release.distributorReleaseId && release.distributorReleaseId !== 'unknown' ? release.distributorReleaseId : ref.releaseId,
      title: releaseTitle,
      ...(release.primaryArtist || ref.artist ? { primaryArtist: release.primaryArtist ?? ref.artist } : {}),
      ...(release.featuredArtists ? { featuredArtists: [...release.featuredArtists] } : {}),
      // Identifier-only bundle members legitimately parse with blank titles. Once the extraction
      // is terminal, use the correlated catalog-index/release title rather than exposing an empty
      // customer row. A later details endpoint title wins earlier in mergeCanonicalRelease.
      tracks: release.tracks.map((track) => ({
        ...track,
        title: track.title.trim() || releaseTitle,
        isrc: { ...track.isrc },
      })),
    };
    this.opts.log?.('release extracted', { releaseId: ref.releaseId, source, elapsedMs: Date.now() - started });
    return {
      kind: 'COMPLETED', release: withId, source, elapsedMs: Date.now() - started,
      // Provenance: which sanitized endpoint profile actually served this release. Persisted so a
      // stored release can be traced back to its endpoint when that endpoint later degrades.
      ...(endpointFingerprint ? { endpointFingerprint } : {}),
    };
  }

  /** Ranked candidate report (also available after a production run). */
  report(): ReturnType<DiscoveryHandle['report']> { return this.discovery?.report() ?? []; }

  async dispose(): Promise<void> {
    this.discovery?.dispose();
    await this.cdp?.dispose();
    if (this.readOnlyGuard) {
      for (const attempt of this.readOnlyGuard.blocked) {
        this.opts.log?.('read-only guard blocked a mutation request', { ...attempt });
      }
      await this.readOnlyGuard.dispose().catch(() => undefined);
    }
    this.discovery = null;
    this.cdp = null;
    this.readOnlyGuard = null;
  }
}

/** Exact HTTPS distributor-origin allowlist for every browser navigation. */
export function isAllowedDistributorUrl(raw: string, origin: string): boolean {
  try {
    const url = new URL(raw);
    const expected = origin.toLowerCase().replace(/^www\./, '');
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.port || url.port === '443') && (host === expected || host.endsWith(`.${expected}`));
  } catch {
    return false;
  }
}

/**
 * Does this release still have gaps a sibling endpoint might fill? Used to decide whether to
 * wait for the rest of an endpoint bundle. A complete release short-circuits the wait.
 */
export function hasGaps(r: CanonicalDistributorRelease): boolean {
  if (!r.title.trim()) return true;
  if (isExtractionFailure(r.upc)) return true;
  if (isExtractionFailure(r.artworkUrl)) return true;
  if (isExtractionFailure(r.releaseDate)) return true;
  if (!r.uploadDate || isExtractionFailure(r.uploadDate)) return true;
  if (!r.label || isExtractionFailure(r.label)) return true;
  if (r.tracks.length === 0) return true;
  return r.tracks.some((track) => !track.title.trim() || isExtractionFailure(track.isrc));
}

/** A release that failed but must still carry a terminal outcome (never silently dropped). */
export function unresolvedOutcome(releaseId: string, reason: ReleaseFailureReason, detail: string): ReleaseExtractionOutcome {
  return { kind: 'FAILED', distributorReleaseId: releaseId, reason, detail, elapsedMs: 0 };
}

/** Build a release whose fields are all NOT_CAPTURED — used when a release must be represented
 *  in the catalog even though extraction failed (so "not captured" ≠ "missing"). */
export function notCapturedRelease(ref: ReleaseRef, reason: ReleaseFailureReason, parserVersion: string): CanonicalDistributorRelease {
  const status = reason === 'TIMEOUT' ? 'TIMEOUT' : reason === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : reason === 'NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : reason === 'PARSE_FAILED' || reason === 'SCHEMA_CHANGED' ? 'PARSE_FAILED' : 'NOT_CAPTURED';
  return {
    distributorReleaseId: ref.releaseId,
    title: ref.title ?? '',
    ...(ref.artist ? { primaryArtist: ref.artist } : {}),
    upc: notCaptured<string>(status, 'NETWORK_JSON', parserVersion),
    artworkUrl: notCaptured<string>(status, 'NETWORK_JSON', parserVersion),
    releaseDate: notCaptured<string>(status, 'NETWORK_JSON', parserVersion),
    tracks: [],
  };
}
