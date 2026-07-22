import { describe, it, expect } from 'vitest';
import { scoreAgainstPolicy, correlateRequest, type CapturedResponse, type ResponseMatchPolicy } from './network-discovery';

/**
 * Endpoint-profile–constrained matching AND request-derived correlation.
 *
 * Two defects these cover:
 *
 * 1. Production selected the highest-scoring catalog-shaped response — a DISCOVERY question
 *    ("does this look like catalog data?") rather than the production one ("is this the response
 *    for the release I asked for?"). A catalog index could outrank the release-details response.
 *
 * 2. "Correlation" was `releaseId = whatever release we happened to be navigating`. That is
 *    TEMPORAL ATTRIBUTION, not correlation: a catalog index, a recommendations payload, a late
 *    response from the PREVIOUS navigation, another page in the same context, or a service-worker
 *    fetch all land inside that window and would be labelled as this release's data — then scored
 *    as "correlated" because the label matched the release we set it from. It was circular.
 */

const capture = (over: Partial<CapturedResponse>): CapturedResponse => ({
  fingerprint: 'fp-details', descriptor: 'GET distrokid.com/api/album/{uuid}',
  payload: {}, score: 20, schemaKeys: [], schemaHash: 'h', bodyBytes: 100,
  correlation: 'TEMPORAL_ASSOCIATION', ...over,
});

describe('correlateRequest — evidence from the request, not from the clock', () => {
  const known = new Set(['R1', 'R2']);

  it('REQUEST_ID_MATCH when the URL path names the expected release', () => {
    const r = correlateRequest('https://distrokid.com/api/album/R1/details', null, 'R1', known);
    expect(r.kind).toBe('REQUEST_ID_MATCH');
    expect(r.namesOtherRelease).toBe(false);
  });

  it('REQUEST_ID_MATCH when a query value names it', () => {
    expect(correlateRequest('https://distrokid.com/api/album?albumuuid=R1', null, 'R1', known).kind).toBe('REQUEST_ID_MATCH');
  });

  it('REQUEST_ID_MATCH when a GraphQL variable in the POST body names it', () => {
    const body = JSON.stringify({ operationName: 'Album', variables: { albumId: 'R1' } });
    expect(correlateRequest('https://distrokid.com/graphql', body, 'R1', known).kind).toBe('REQUEST_ID_MATCH');
  });

  it('matches through URL encoding', () => {
    const r = correlateRequest('https://distrokid.com/api?ids=%5B%22R1%22%5D', null, 'R1', known);
    expect(r.kind).toBe('REQUEST_ID_MATCH');
  });

  it('flags a request that names a DIFFERENT known release — this is the late-response case', () => {
    // The extractor has moved on to R2, but R1's request is only now finishing. Temporal
    // attribution would label this response R2 and file R1's ISRCs under R2.
    const r = correlateRequest('https://distrokid.com/api/album/R1/details', null, 'R2', known);
    expect(r.kind).toBe('NO_CORRELATION');
    expect(r.namesOtherRelease).toBe(true);
  });

  it('TEMPORAL_ASSOCIATION when the request names no release at all', () => {
    // A catalog index or page bootstrap. Legitimate data, but it is not evidence about R1.
    const r = correlateRequest('https://distrokid.com/api/catalog/index', null, 'R1', known);
    expect(r.kind).toBe('TEMPORAL_ASSOCIATION');
    expect(r.namesOtherRelease).toBe(false);
  });

  it('NO_CORRELATION when we are not reading any particular release', () => {
    expect(correlateRequest('https://distrokid.com/api/whatever', null, undefined, known).kind).toBe('NO_CORRELATION');
  });
});

describe('scoreAgainstPolicy — production response selection', () => {
  it('REJECTS a response whose request names a different release, however catalog-shaped', () => {
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: true };
    // Same endpoint, perfect score — but the REQUEST was for R2. Using it would file R2's ISRCs
    // under R1: silent, plausible, and wrong.
    expect(scoreAgainstPolicy(capture({ score: 100, correlation: 'NO_CORRELATION', namesOtherRelease: true }), policy)).toBeNull();
  });

  it('prefers the ACTIVE profile whose REQUEST named this release over a higher-scoring stranger', () => {
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: true, minScore: 10 };
    const active = capture({ fingerprint: 'fp-details', correlation: 'REQUEST_ID_MATCH', score: 12 });
    const strangerButShinier = capture({ fingerprint: 'fp-catalog-index', correlation: 'TEMPORAL_ASSOCIATION', score: 95 });
    // The whole point: the 95-scoring catalog index must NOT win.
    expect(scoreAgainstPolicy(active, policy)!).toBeGreaterThan(scoreAgainstPolicy(strangerButShinier, policy)!);
  });

  it('ranks a request-named match above one that merely arrived at the right time', () => {
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: false };
    const named = scoreAgainstPolicy(capture({ correlation: 'REQUEST_ID_MATCH' }), policy)!;
    const temporal = scoreAgainstPolicy(capture({ correlation: 'TEMPORAL_ASSOCIATION' }), policy)!;
    expect(named).toBeGreaterThan(temporal);
  });

  it('does NOT treat temporal association as correlation', () => {
    // Regression guard for the circular bug: a response that merely landed in R1's window must
    // not score as though the request had named R1.
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: false };
    const temporal = capture({ correlation: 'TEMPORAL_ASSOCIATION', releaseId: 'R1' });
    const named = capture({ correlation: 'REQUEST_ID_MATCH', releaseId: 'R1' });
    expect(scoreAgainstPolicy(temporal, policy)).not.toBe(scoreAgainstPolicy(named, policy));
  });

  it('REJECTS everything off-profile once a profile is ACTIVE — a clean timeout beats a confident wrong answer', () => {
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: false, minScore: 10 };
    expect(scoreAgainstPolicy(capture({ fingerprint: 'fp-something-else', score: 99 }), policy)).toBeNull();
  });

  it('allows the heuristic during discovery, when nothing is ACTIVE yet', () => {
    const policy: ResponseMatchPolicy = { activeFingerprints: [], releaseId: 'R1', allowHeuristic: true, minScore: 10 };
    expect(scoreAgainstPolicy(capture({ fingerprint: 'fp-unknown', score: 20 }), policy)).not.toBeNull();
    // Still bounded by the catalog-score floor, so a config blob can't be mistaken for catalog data.
    expect(scoreAgainstPolicy(capture({ fingerprint: 'fp-analytics', score: 2 }), policy)).toBeNull();
  });

  it('allows the heuristic when the profile is DEGRADED, so schema drift is not a total outage', () => {
    // Drift already alerted and degraded the endpoint; the versioned parser still guards
    // correctness. Refusing to look elsewhere would strand every extraction on one schema change.
    const policy: ResponseMatchPolicy = { activeFingerprints: [], releaseId: 'R1', allowHeuristic: true, minScore: 10 };
    expect(scoreAgainstPolicy(capture({ fingerprint: 'fp-new-shape', score: 30 }), policy)).not.toBeNull();
  });

  it('accepts a profile-matching response whose request names no release (endpoint bundles do this)', () => {
    // Not every response is attributable — a page-level bootstrap or an index payload carries real
    // data. Requiring correlation absolutely would reject legitimate bundle members; it is a
    // preference, not a precondition.
    const policy: ResponseMatchPolicy = { activeFingerprints: ['fp-details'], releaseId: 'R1', allowHeuristic: false };
    expect(scoreAgainstPolicy(capture({ correlation: 'TEMPORAL_ASSOCIATION' }), policy)).not.toBeNull();
  });
});
