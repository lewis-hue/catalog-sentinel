import type { Page } from 'playwright';
import { isInspectableUrl, MAX_CAPTURE_BODY_BYTES, redactError } from './redaction';
import { collectKeys, scoreCatalogPayload, MIN_CATALOG_SCORE } from './candidate-scoring';
import { fingerprintFromUrl, schemaHash, extractGraphqlOperationName, extractGraphqlVariableKeys } from './endpoint-fingerprint';
import { correlateRequest, type CapturedResponse } from './network-discovery';

/**
 * CDP fallback.
 *
 * Playwright's `response.body()` covers almost everything, but some responses can't be read
 * through it (already-consumed streams, certain service-worker/redirect cases). Steel exposes
 * the browser over CDP, so we can attach a CDP session and pull the body from the Network
 * domain directly via `Network.getResponseBody`.
 *
 * Bodies are processed IN MEMORY and discarded, we persist only normalized catalog metadata
 * and sanitized fingerprints, never raw bodies.
 */

export interface CdpCaptureHandle {
  setCurrentRelease(releaseId: string | undefined): void;
  /** Highest-scoring catalog payload captured via CDP since reset. */
  best(): CapturedResponse | null;
  waitForCatalogResponse(timeoutMs: number, minScore?: number): Promise<CapturedResponse | null>;
  resetCaptures(): void;
  dispose(): Promise<void>;
}

interface PendingRequest {
  method: string;
  url: string;
  /** GraphQL operation name (never variable VALUES). */
  operationName?: string;
  /** GraphQL variable KEY names only. */
  variableKeys?: string[];
  resourceType?: string;
  /**
   * The raw POST body, held ONLY to correlate this request to the release we asked for (a release
   * id can live in a GraphQL variable rather than the URL). It is matched against known ids in
   * memory, never persisted, never logged, and dropped with the rest of the per-request state on
   * `loadingFinished`/`loadingFailed`.
   */
  postData?: string;
}

interface PendingResponse extends PendingRequest {
  mimeType: string;
  status: number;
}

/**
 * Attach a CDP Network listener as a secondary capture path. Safe to run alongside the
 * Playwright context listener: both feed the same "did we get catalog JSON?" question, and the
 * extractor takes whichever arrives with a usable payload.
 */
export async function attachCdpNetworkCapture(page: Page, opts: { origin: string; minScore?: number; knownReleaseIds?: ReadonlySet<string> }): Promise<CdpCaptureHandle> {
  const minScore = opts.minScore ?? MIN_CATALOG_SCORE;
  const cdp = await page.context().newCDPSession(page);

  await cdp.send('Network.enable', {
    maxTotalBufferSize: 100 * 1024 * 1024,
    maxResourceBufferSize: 10 * 1024 * 1024,
  });

  // requestId → sanitized REQUEST metadata. Captured on requestWillBeSent because the response
  // event alone doesn't carry the method or the GraphQL operation, without these, a POST/GraphQL
  // endpoint would be misfingerprinted as GET and lose its identity.
  const requests = new Map<string, PendingRequest>();
  const pending = new Map<string, PendingResponse>();
  let captures: CapturedResponse[] = [];
  const waiters: Array<{ minScore: number; resolve: (c: CapturedResponse | null) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let currentRelease: string | undefined;
  let disposed = false;

  const onRequestWillBeSent = (event: { requestId: string; type?: string; request: { url: string; method: string; postData?: string } }): void => {
    const { request, requestId } = event;
    if (!isInspectableUrl(request.url, opts.origin)) return;
    const op = extractGraphqlOperationName(request.postData);
    requests.set(requestId, {
      method: request.method,
      url: request.url,
      ...(request.postData ? { postData: request.postData } : {}),
      ...(op ? { operationName: op, variableKeys: extractGraphqlVariableKeys(request.postData) } : {}),
      ...(event.type ? { resourceType: event.type } : {}),
    });
    // Bound memory: a long-lived page can issue thousands of requests.
    if (requests.size > 5000) requests.delete(requests.keys().next().value as string);
  };

  const onResponseReceived = (event: { requestId: string; response: { url: string; mimeType: string; status: number } }): void => {
    const { response, requestId } = event;
    if (!response.mimeType.includes('json')) return;
    if (response.status < 200 || response.status >= 300) return;
    if (!isInspectableUrl(response.url, opts.origin)) return;
    const req = requests.get(requestId);
    pending.set(requestId, {
      // Fall back to GET only when the request event was missed entirely.
      method: req?.method ?? 'GET',
      url: response.url,
      ...(req?.operationName ? { operationName: req.operationName } : {}),
      ...(req?.variableKeys ? { variableKeys: req.variableKeys } : {}),
      ...(req?.postData ? { postData: req.postData } : {}),
      ...(req?.resourceType ? { resourceType: req.resourceType } : {}),
      mimeType: response.mimeType,
      status: response.status,
    });
  };

  const onLoadingFinished = (event: { requestId: string }): void => {
    const candidate = pending.get(event.requestId);
    if (!candidate || disposed) return;
    void (async () => {
      try {
        const result = await cdp.send('Network.getResponseBody', { requestId: event.requestId });
        const body = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body, 'utf8');
        if (body.length === 0 || body.length > MAX_CAPTURE_BODY_BYTES) return;

        let payload: unknown;
        try { payload = JSON.parse(body.toString('utf8')); } catch { return; }

        const schemaKeys = collectKeys(payload, 5);
        const score = scoreCatalogPayload(schemaKeys);
        if (score < minScore) return;

        // Use the REAL method + GraphQL operation so POST/GraphQL endpoints keep their identity.
        const { fingerprint, descriptor } = fingerprintFromUrl(candidate.method, candidate.url, candidate.operationName);
        // Correlate from the REQUEST here too. The CDP path is a real capture route, so leaving it
        // on temporal attribution would just move the mis-association bug rather than fix it.
        const { kind: correlation, namesOtherRelease } = correlateRequest(
          candidate.url, candidate.postData, currentRelease, opts.knownReleaseIds ?? new Set<string>(),
        );
        const captured: CapturedResponse = {
          fingerprint, descriptor, payload, score, schemaKeys,
          schemaHash: schemaHash(schemaKeys), bodyBytes: body.length,
          correlation,
          ...(currentRelease ? { releaseId: currentRelease } : {}),
          ...(namesOtherRelease ? { namesOtherRelease } : {}),
        };
        captures.push(captured);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (score >= w.minScore) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(captured); }
        }
        // Body is discarded here: only the parsed payload lives on, in memory, until parsed.
      } catch (error) {
        console.warn('[distrokid] CDP body read failed', { error: redactError(error) });
      } finally {
        // Always drop per-request state on success AND failure, so nothing accumulates.
        pending.delete(event.requestId);
        requests.delete(event.requestId);
      }
    })();
  };

  const onLoadingFailed = (event: { requestId: string }): void => { pending.delete(event.requestId); requests.delete(event.requestId); };

  cdp.on('Network.requestWillBeSent', onRequestWillBeSent);
  cdp.on('Network.responseReceived', onResponseReceived);
  cdp.on('Network.loadingFinished', onLoadingFinished);
  cdp.on('Network.loadingFailed', onLoadingFailed);

  return {
    setCurrentRelease(releaseId) { currentRelease = releaseId; },
    resetCaptures() { captures = []; },
    best: () => captures.reduce<CapturedResponse | null>((b, c) => (!b || c.score > b.score ? c : b), null),
    async waitForCatalogResponse(timeoutMs, ms) {
      const want = ms ?? minScore;
      const existing = captures.filter((c) => c.score >= want).sort((a, b) => b.score - a.score)[0];
      if (existing) return existing;
      return new Promise<CapturedResponse | null>((resolve) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        waiters.push({ minScore: want, resolve, timer });
      });
    },
    async dispose() {
      disposed = true;
      waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(null); });
      captures = [];
      pending.clear();
      requests.clear();
      try { await cdp.detach(); } catch { /* session may already be gone */ }
    },
  };
}
