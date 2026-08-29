import type { BrowserContext, Response } from 'playwright';
import { isInspectableUrl, MAX_CAPTURE_BODY_BYTES, redactError } from './redaction';
import { collectKeys, scoreCatalogPayload, hasStrongCatalogSignal, rankCandidate, MIN_CATALOG_SCORE, type VariabilityObservation } from './candidate-scoring';
import { fingerprintFromUrl, schemaHash, payloadVarianceHash, extractGraphqlOperationName, extractGraphqlVariableKeys, type EndpointIdentity } from './endpoint-fingerprint';

/**
 * Endpoint DISCOVERY (sample mode) + live capture (production mode).
 *
 * Listeners are attached at the BROWSER CONTEXT level, not the page: a SPA opens secondary
 * pages/frames and may serve requests via a service worker, and context-level events cover all
 * of them. Listeners must be installed BEFORE the first navigation or the response is missed.
 *
 * Nothing sensitive is retained: only sanitized endpoint identity, schema KEY names, sizes,
 * scores and one-way hashes. Never cookies, headers, tokens, query values, or bodies.
 */

/**
 * `NetworkCandidate`, `CandidateScope` and `CandidateSink` are defined in `@sentinel/contracts`:
 * the durable sink is Postgres-backed and must be able to name these shapes without importing
 * this package (and therefore Playwright). Re-exported so existing imports keep working.
 */
import type { NetworkCandidate, CandidateScope, CandidateSink, CorrelationKind } from '@sentinel/contracts';

/** Reused so the common "no known ids" path allocates nothing per response. */
const EMPTY_IDS: ReadonlySet<string> = new Set();
export type { NetworkCandidate, CandidateScope, CandidateSink, CorrelationKind } from '@sentinel/contracts';

/**
 * Which release (if any) a REQUEST actually names.
 *
 * Correlation is derived from the request, its path, query values, POST body, GraphQL variables -
 * and compared against the ids we already know, IN MEMORY. Only the resulting category is ever
 * recorded; the matched value is never persisted or logged, because a query value is exactly the
 * kind of thing the redaction policy forbids storing.
 *
 * Matching against KNOWN ids (rather than guessing which URL segment looks like an id) means we
 * never have to invent a parser for someone else's URL scheme, and we cannot mistake an unrelated
 * uuid for a release.
 */
export function correlateRequest(
  url: string, postData: string | null | undefined,
  expectedReleaseId: string | undefined, knownReleaseIds: ReadonlySet<string>,
): { kind: CorrelationKind; namesOtherRelease: boolean } {
  let haystack = url;
  try { haystack = decodeURIComponent(url); } catch { /* keep the raw url */ }
  if (postData) haystack += ` ${postData}`;

  if (expectedReleaseId && haystack.includes(expectedReleaseId)) {
    return { kind: 'REQUEST_ID_MATCH', namesOtherRelease: false };
  }
  // Does the request name a DIFFERENT release we know about? Then this response is that
  // release's data, whatever else is true of it, and must never be attributed here.
  for (const id of knownReleaseIds) {
    if (id !== expectedReleaseId && haystack.includes(id)) {
      return { kind: 'NO_CORRELATION', namesOtherRelease: true };
    }
  }
  // The request names no release at all, a page-level or index payload. Legitimate, but not
  // evidence of belonging to this release.
  return { kind: expectedReleaseId ? 'TEMPORAL_ASSOCIATION' : 'NO_CORRELATION', namesOtherRelease: false };
}

/** A captured payload, held in memory only for the duration of one release extraction. */
export interface CapturedResponse {
  fingerprint: string;
  descriptor: string;
  payload: unknown;
  score: number;
  schemaKeys: string[];
  schemaHash: string;
  bodyBytes: number;
  /** The release being navigated when this arrived. TEMPORAL only, see `correlation`. */
  releaseId?: string;
  /** Request-derived correlation. This, not `releaseId`, is what the match policy trusts. */
  correlation: CorrelationKind;
  /** True when the REQUEST names a different known release, a hard reject. */
  namesOtherRelease?: boolean;
}

/**
 * How production picks WHICH captured response is this release's metadata.
 *
 * Score-only selection is a DISCOVERY heuristic: it answers "which endpoint here looks like
 * catalog data?". In production we already know the answer, the registry has an ACTIVE profile
 *, and asking the heuristic again lets an unrelated catalog-shaped response (a catalog index,
 * a sidebar's recommendations) outrank the release-details response and be parsed as this
 * release. Constraining to the known profile, and correlating the response to the release that
 * was actually requested, removes that whole class of mis-association.
 */
export interface ResponseMatchPolicy {
  /** Fingerprints of ACTIVE profiles for the wanted role. Empty ⇒ nothing known yet. */
  activeFingerprints: string[];
  /** The release being extracted. A response correlated to a DIFFERENT release is rejected. */
  releaseId?: string;
  /**
   * Permit score-only selection when no ACTIVE profile matched. True during discovery and while
   * a profile is DEGRADED (schema drift), otherwise a drifted endpoint would strand extraction.
   * False once a profile is ACTIVE: prefer a clean TIMEOUT over a confident wrong answer.
   */
  allowHeuristic: boolean;
  minScore?: number;
}

/**
 * Rank a capture against the policy. Higher wins; `null` means REJECT.
 *
 * The ordering is by EVIDENCE, strongest first:
 *
 *   REQUEST_ID_MATCH + active profile  , the request named this release, from the known endpoint
 *   REQUEST_ID_MATCH                   , the request named this release
 *   PROFILE_MATCH_ONLY                 , known endpoint, request names no release
 *   TEMPORAL_ASSOCIATION               , it merely arrived during this release's window
 *
 * `TEMPORAL_ASSOCIATION` used to be scored as if it were correlation, because `releaseId` was
 * just a copy of whatever release the extractor was on when the response landed. That made a
 * catalog index or a late response from the PREVIOUS navigation indistinguishable from this
 * release's own data.
 */
export function scoreAgainstPolicy(c: CapturedResponse, p: ResponseMatchPolicy): number | null {
  // The request names a DIFFERENT release → this is someone else's data. Never usable, no matter
  // how catalog-shaped it looks or which profile served it.
  if (c.namesOtherRelease) return null;

  const onActiveProfile = p.activeFingerprints.includes(c.fingerprint);
  const requestMatch = c.correlation === 'REQUEST_ID_MATCH';

  if (onActiveProfile) {
    if (requestMatch) return 4000 + c.score;
    // Right endpoint, but the request doesn't name a release: an index or page-level payload.
    // Usable (bundles legitimately work this way) and ranked below proven correlation.
    return 2000 + c.score;
  }

  // No ACTIVE profile matched. Only a discovery/drift run may fall back to shape-guessing.
  if (!p.allowHeuristic) return null;
  if (c.score < (p.minScore ?? 0)) return null;
  // A request-named match outranks a shape guess even off-profile: naming the release is harder
  // to do by accident than looking catalog-shaped.
  return requestMatch ? 1000 + c.score : c.score;
}

export interface DiscoveryHandle {
  /** Set which release the browser is currently reading (for correlation + variance). */
  setCurrentRelease(releaseId: string | undefined): void;
  /** Resolve when a payload scoring >= minScore arrives; null on timeout. */
  waitForCatalogResponse(timeoutMs: number, minScore?: number): Promise<CapturedResponse | null>;
  /**
   * PRODUCTION selector: resolve with the best response satisfying `policy`, or null on timeout.
   * Prefers an ACTIVE endpoint profile correlated to this release over a shape-based guess.
   */
  waitForMatchingResponse(policy: ResponseMatchPolicy, timeoutMs: number): Promise<CapturedResponse | null>;
  /** Resolve when a payload from a DIFFERENT endpoint arrives. A release's data is often split
   *  across an endpoint BUNDLE (details here, ISRCs there) and the sibling may still be in
   *  flight when the first response lands. */
  waitForDifferentEndpoint(excludeFingerprint: string, timeoutMs: number): Promise<CapturedResponse | null>;
  /** Highest-scoring payload seen since the last reset. */
  best(): CapturedResponse | null;
  /** EVERY payload captured since the last reset, a release's data may be split across
   *  several endpoints (a bundle), so callers must be able to merge from all of them. */
  all(): CapturedResponse[];
  /** Drop buffered payloads (called between releases so they never cross-contaminate). */
  resetCaptures(): void;
  /** Automatic candidate report, ranked, no manual log reading. */
  report(): RankedCandidate[];
  dispose(): void;
}

export interface RankedCandidate {
  fingerprint: string;
  descriptor: string;
  identity: EndpointIdentity;
  /** Base schema score. */
  score: number;
  /** Score adjusted for per-release variability. */
  rank: number;
  schemaKeys: string[];
  schemaHash: string;
  observations: number;
  distinctPayloads: number;
  hasStrongSignal: boolean;
  releaseIds: string[];
}

export interface DiscoveryOptions {
  /** Distributor origin allowlist, e.g. "distrokid.com". */
  origin: string;
  /**
   * Release ids this run may attribute responses to, the current chunk's ids.
   *
   * Used to CORRELATE a response to its request by looking for a known id in the request itself.
   * Matching against known ids beats guessing which URL segment is an identifier: we never have to
   * model the distributor's URL scheme, and an unrelated uuid can't be mistaken for a release.
   * The ids stay in memory; only the correlation CATEGORY is ever recorded.
   */
  knownReleaseIds?: ReadonlySet<string>;
  sink?: CandidateSink;
  /** Tenant + scan every candidate is attributed to (required when a sink is supplied). */
  scope?: CandidateScope;
  minScore?: number;
  /** Cap on bodies read, so a discovery run can't buffer unbounded data. */
  maxBodies?: number;
  /** Aggregate payload budget retained/parsed during one handle (default 32 MiB). */
  maxTotalBodyBytes?: number;
  /** Bound simultaneous body materializations (Playwright exposes body(), not a stream). */
  maxConcurrentBodyReads?: number;
}

interface CandidateStat {
  descriptor: string;
  identity: EndpointIdentity;
  score: number;
  schemaKeys: string[];
  schemaHash: string;
  observations: number;
  payloadHashes: Set<string>;
  releaseIds: Set<string>;
  hasStrongSignal: boolean;
}

/**
 * Install discovery on a browser context. Returns a handle used by both:
 *  - discovery mode (sample 5–10 releases → ranked candidate report)
 *  - production mode (wait for the metadata response instead of the DOM)
 */
export function installDistributorNetworkDiscovery(context: BrowserContext, opts: DiscoveryOptions): DiscoveryHandle {
  const minScore = opts.minScore ?? MIN_CATALOG_SCORE;
  const maxBodies = opts.maxBodies ?? 2000;
  const maxTotalBodyBytes = opts.maxTotalBodyBytes ?? 32 * 1024 * 1024;
  const maxConcurrentBodyReads = opts.maxConcurrentBodyReads ?? 4;
  const stats = new Map<string, CandidateStat>();
  let captures: CapturedResponse[] = [];
  const waiters: Array<{ epoch: number; match: (c: CapturedResponse) => boolean; resolve: (c: CapturedResponse | null) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let currentRelease: string | undefined;
  let bodiesRead = 0;
  let totalBodyBytes = 0;
  let inFlightBodyReads = 0;
  let epoch = 0;
  let disposed = false;

  const listener = (response: Response): void => {
    // Snapshot ownership synchronously, at response-event time. Looking at mutable
    // `currentRelease` after awaiting response.finished()/body() attributed late A responses to B.
    const responseEpoch = epoch;
    const responseRelease = currentRelease;
    void (async () => {
      try {
        if (disposed || bodiesRead >= maxBodies || totalBodyBytes >= maxTotalBodyBytes) return;
        const request = response.request();
        const resourceType = request.resourceType();
        if (resourceType !== 'xhr' && resourceType !== 'fetch') return;
        if (response.status() < 200 || response.status() >= 300) return;
        if (!isInspectableUrl(response.url(), opts.origin)) return;

        const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
        if (!contentType.includes('json')) return;
        const declaredLength = Number(response.headers()['content-length'] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_CAPTURE_BODY_BYTES) return;
        if (inFlightBodyReads >= maxConcurrentBodyReads) return;

        // Only read the body once the response has fully downloaded.
        inFlightBodyReads++;
        let body: Buffer;
        try {
          await response.finished();
          body = await response.body();
        } finally {
          inFlightBodyReads--;
        }
        if (body.length === 0 || body.length > MAX_CAPTURE_BODY_BYTES) return;
        if (totalBodyBytes + body.length > maxTotalBodyBytes) return;
        bodiesRead++;
        totalBodyBytes += body.length;

        let payload: unknown;
        try { payload = JSON.parse(body.toString('utf8')); } catch { return; }

        const schemaKeys = collectKeys(payload, 5);
        const score = scoreCatalogPayload(schemaKeys);
        if (score <= 0) return; // analytics/config → ignore entirely

        const op = extractGraphqlOperationName(request.postData());
        const { identity, fingerprint, descriptor } = fingerprintFromUrl(request.method(), response.url(), op);
        const sHash = schemaHash(schemaKeys);
        const strong = hasStrongCatalogSignal(schemaKeys);

        // Record the sanitized observation (discovery).
        const stat = stats.get(fingerprint) ?? {
          descriptor, identity, score, schemaKeys, schemaHash: sHash,
          observations: 0, payloadHashes: new Set<string>(), releaseIds: new Set<string>(), hasStrongSignal: strong,
        };
        stat.observations++;
        stat.score = Math.max(stat.score, score);
        stat.hasStrongSignal ||= strong;
        stat.payloadHashes.add(payloadVarianceHash(payload));
        if (responseRelease) stat.releaseIds.add(responseRelease);
        stats.set(fingerprint, stat);

        // Correlate from the REQUEST, not from whatever release we happen to be on. The values
        // compared here never leave this function, only the category is kept.
        const { kind: correlation, namesOtherRelease } = correlateRequest(
          response.url(), request.postData(), responseRelease, opts.knownReleaseIds ?? EMPTY_IDS,
        );

        const candidate: NetworkCandidate = {
          fingerprint, identity, descriptor,
          status: response.status(), contentType, score, schemaKeys, schemaHash: sHash,
          bodyBytes: body.length, observedAt: new Date().toISOString(),
          ...(responseRelease ? { releaseId: responseRelease } : {}),
          correlation,
          ...(op ? { graphqlVariableKeys: extractGraphqlVariableKeys(request.postData()) } : {}),
        };
        if (opts.sink && opts.scope) await opts.sink.write(candidate, opts.scope).catch(() => undefined);

        if (score < minScore) return;

        // A new navigation/reset started while this body was downloading. It may still be useful
        // for endpoint statistics, but it cannot enter the new release's capture window.
        if (responseEpoch !== epoch) return;

        const captured: CapturedResponse = {
          fingerprint, descriptor, payload, score, schemaKeys, schemaHash: sHash,
          bodyBytes: body.length, correlation,
          ...(responseRelease ? { releaseId: responseRelease } : {}),
          ...(namesOtherRelease ? { namesOtherRelease } : {}),
        };
        captures.push(captured);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.epoch === epoch && w.match(captured)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(captured); }
        }
      } catch (error) {
        // Category only, never a body, header, or token.
        console.warn('[distrokid] network candidate processing failed', { error: redactError(error) });
      }
    })();
  };

  context.on('response', listener);

  /** Event-driven wait (never a fixed sleep): resolve on the first capture matching `match`. */
  const waitFor = (match: (c: CapturedResponse) => boolean, timeoutMs: number): Promise<CapturedResponse | null> =>
    new Promise<CapturedResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      waiters.push({ epoch, match, resolve, timer });
    });

  return {
    setCurrentRelease(releaseId) { currentRelease = releaseId; },
    resetCaptures() {
      epoch++;
      captures = [];
      // A waiter belongs to one release window. Never let it consume the next release's response.
      waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(null); });
    },
    best: () => captures.reduce<CapturedResponse | null>((b, c) => (!b || c.score > b.score ? c : b), null),
    all: () => [...captures],
    async waitForCatalogResponse(timeoutMs, ms) {
      const want = ms ?? minScore;
      const existing = captures.filter((c) => c.score >= want).sort((a, b) => b.score - a.score)[0];
      if (existing) return existing;
      return waitFor((c) => c.score >= want, timeoutMs);
    },
    async waitForMatchingResponse(policy, timeoutMs) {
      const p: ResponseMatchPolicy = { minScore, ...policy };
      // Best ALREADY-captured match first: the response often lands before we start waiting.
      const ranked = captures
        .map((c) => ({ c, r: scoreAgainstPolicy(c, p) }))
        .filter((x): x is { c: CapturedResponse; r: number } => x.r !== null)
        .sort((a, b) => b.r - a.r);
      if (ranked[0]) return ranked[0].c;
      // Nothing yet, wait for the first ACCEPTABLE one. This deliberately resolves on the first
      // match rather than waiting out the window for a possibly-better one: an active-profile
      // response correlated to this release is already the best answer available.
      return waitFor((c) => scoreAgainstPolicy(c, p) !== null, timeoutMs);
    },
    async waitForDifferentEndpoint(excludeFingerprint, timeoutMs) {
      const existing = captures.find((c) => c.fingerprint !== excludeFingerprint);
      if (existing) return existing;
      return waitFor((c) => c.fingerprint !== excludeFingerprint, timeoutMs);
    },
    report() {
      return [...stats.entries()]
        .map(([fingerprint, s]) => {
          const v: VariabilityObservation = { fingerprint, distinctPayloads: s.payloadHashes.size, observations: s.observations };
          return {
            fingerprint, descriptor: s.descriptor, identity: s.identity,
            score: s.score, rank: rankCandidate(s.score, v),
            schemaKeys: s.schemaKeys.filter((k) => k !== '{redacted}'),
            schemaHash: s.schemaHash,
            observations: s.observations, distinctPayloads: s.payloadHashes.size,
            hasStrongSignal: s.hasStrongSignal, releaseIds: [...s.releaseIds].slice(0, 10),
          };
        })
        .sort((a, b) => b.rank - a.rank);
    },
    dispose() {
      disposed = true;
      context.off('response', listener);
      waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(null); });
      captures = [];
    },
  };
}

/** In-memory sink (tests, and the default for a discovery run). */
export class InMemoryCandidateSink implements CandidateSink {
  readonly candidates: Array<NetworkCandidate & { scope: CandidateScope }> = [];
  async write(candidate: NetworkCandidate, scope: CandidateScope): Promise<void> {
    this.candidates.push({ ...candidate, scope });
  }
}
