import { describe, it, expect } from 'vitest';
import { collectKeys, scoreCatalogPayload, hasStrongCatalogSignal, rankCandidate, MIN_CATALOG_SCORE } from './candidate-scoring';
import { endpointIdentity, describeEndpoint, fingerprintEndpoint, fingerprintFromUrl, schemaHash, extractGraphqlOperationName, extractGraphqlVariableKeys } from './endpoint-fingerprint';
import { isInspectableUrl, isSensitivePath, isSensitiveKey, sanitizedQueryKeys, maskPath, redactPayloadShape, redactError, readNetworkDebugConfig, isDebugArtifactExpired } from './redaction';
import { parseDistroKidReleaseV1, locateReleaseObject, SchemaMismatchError, PARSER_VERSION } from './parser-v1';
import { ParserRegistry } from './parser-registry';
import { EndpointRegistry, InMemoryEndpointRegistryStore, matchesProfile, VALIDATION_CAPTURES_REQUIRED, DEGRADE_AFTER_FAILURES } from './endpoint-registry';
import { inferRole, mergeCanonicalRelease, mergePartial } from './endpoint-bundle';
import { readDirectReaderFlags, isDirectReaderAllowed, DirectJsonReader } from './direct-reader';
import { reconcile, deriveStatus, retryableReleaseIds, describeCompleteness } from './completeness';
import { present, absentAtSource, notCaptured, isExtractionFailure, isAbsentAtSource, explainField } from './metadata-model';
import type { RankedCandidate } from './network-discovery';
import type { ReleaseExtractionOutcome, CanonicalDistributorRelease } from './metadata-model';
import { isAllowedDistributorUrl } from './extractor';

// ---------------------------------------------------------------- scoring
describe('candidate scoring', () => {
  it('scores a release payload above the production threshold', () => {
    const payload = { release: { upc: '199751675992', tracks: [{ isrc: 'QT6ED2521965', title: 'Pesa' }] } };
    const keys = collectKeys(payload, 5);
    expect(scoreCatalogPayload(keys)).toBeGreaterThanOrEqual(MIN_CATALOG_SCORE);
    expect(hasStrongCatalogSignal(keys)).toBe(true);
  });

  it('drives analytics/feature-flag/billing JSON to zero so it is never mistaken for catalog data', () => {
    for (const junk of [
      { event: 'pageview', analytics: { sessionId: 'x' } },
      { featureFlags: { newNav: true }, experiment: 'b', variant: 2 },
      { billing: { invoice: 1, card: '****' }, plan: 'pro' },
      { notifications: [{ unread: 2, banner: 'x' }] },
    ]) {
      expect(scoreCatalogPayload(collectKeys(junk, 5))).toBe(0);
    }
  });

  it('collects KEY NAMES only and masks sensitive key names', () => {
    const keys = collectKeys({ upc: '199751675992', authorization: 'Bearer SECRET', email: 'a@b.com' }, 3);
    expect(keys).toContain('upc');
    expect(keys).toContain('{redacted}'); // authorization + email masked
    const joined = keys.join(',');
    expect(joined).not.toContain('SECRET');
    expect(joined).not.toContain('a@b.com');
    expect(joined).not.toContain('199751675992');
  });

  it('penalizes an endpoint whose payload never changes between releases', () => {
    const varies = rankCandidate(20, { fingerprint: 'f', distinctPayloads: 5, observations: 5 });
    const static_ = rankCandidate(20, { fingerprint: 'f', distinctPayloads: 1, observations: 5 });
    expect(varies).toBeGreaterThan(20); // release-specific → boosted
    expect(static_).toBeLessThan(20); // identical every time → demoted
  });
});

// ---------------------------------------------------------------- fingerprinting
describe('endpoint fingerprinting', () => {
  it('keeps query KEY names, drops values, masks ids in the path', () => {
    const id = endpointIdentity('GET', 'https://distrokid.com/api/album/82C05623-BA75-4770-A051-6052237A6409?albumuuid=SECRET&t=99999');
    expect(id.pathPattern).toBe('/api/album/{uuid}');
    expect(id.queryKeys).toEqual(['albumuuid', 't']);
    const d = describeEndpoint(id);
    expect(d).not.toContain('SECRET');
    expect(d).not.toContain('99999');
  });

  it('masks sensitive query KEY names entirely', () => {
    const u = new URL('https://distrokid.com/api/x?access_token=abc&albumuuid=1');
    const keys = sanitizedQueryKeys(u);
    expect(keys).toContain('{redacted}');
    expect(keys).not.toContain('access_token');
  });

  it('is stable for the same shape and distinct per GraphQL operation', () => {
    const a = fingerprintEndpoint(endpointIdentity('POST', 'https://distrokid.com/graphql', 'ReleaseDetails'));
    const b = fingerprintEndpoint(endpointIdentity('POST', 'https://distrokid.com/graphql?x=1', 'ReleaseDetails'));
    const c = fingerprintEndpoint(endpointIdentity('POST', 'https://distrokid.com/graphql', 'TrackIdentifiers'));
    expect(a).not.toBe(b); // query shape is part of identity
    expect(a).not.toBe(c); // operation is part of identity
    expect(a).toBe(fingerprintEndpoint(endpointIdentity('POST', 'https://distrokid.com/graphql', 'ReleaseDetails')));
  });

  it('ids differing only by uuid VALUE produce the SAME fingerprint', () => {
    const one = fingerprintFromUrl('GET', 'https://distrokid.com/api/album/11111111-1111-1111-1111-111111111111');
    const two = fingerprintFromUrl('GET', 'https://distrokid.com/api/album/22222222-2222-2222-2222-222222222222');
    expect(one.fingerprint).toBe(two.fingerprint);
  });

  it('detects GraphQL operationName without retaining variable VALUES', () => {
    const post = JSON.stringify({ operationName: 'ReleaseDetails', variables: { albumUuid: 'SECRET', token: 'T' } });
    expect(extractGraphqlOperationName(post)).toBe('ReleaseDetails');
    expect(extractGraphqlVariableKeys(post)).toEqual(['albumUuid', 'token']); // KEY names only
    expect(extractGraphqlOperationName('not json')).toBeUndefined();
  });

  it('schema hash changes when the shape changes (drift detection)', () => {
    expect(schemaHash(['isrc', 'upc'])).toBe(schemaHash(['upc', 'isrc'])); // order-insensitive
    expect(schemaHash(['isrc', 'upc'])).not.toBe(schemaHash(['isrc', 'upc', 'newField']));
  });
});

// ---------------------------------------------------------------- redaction / security
describe('redaction + security boundary', () => {
  it('allows only HTTPS navigation within the configured distributor origin', () => {
    expect(isAllowedDistributorUrl('https://distrokid.com/dashboard/album/R1', 'distrokid.com')).toBe(true);
    expect(isAllowedDistributorUrl('https://dashboard.distrokid.com/release/R1', 'distrokid.com')).toBe(true);
    expect(isAllowedDistributorUrl('http://distrokid.com/release/R1', 'distrokid.com')).toBe(false);
    expect(isAllowedDistributorUrl('https://distrokid.com.evil.example/R1', 'distrokid.com')).toBe(false);
    expect(isAllowedDistributorUrl('https://169.254.169.254/latest/meta-data', 'distrokid.com')).toBe(false);
  });

  it('only inspects the distributor origin', () => {
    expect(isInspectableUrl('https://distrokid.com/api/x', 'distrokid.com')).toBe(true);
    expect(isInspectableUrl('https://cdn.distrokid.com/api/x', 'distrokid.com')).toBe(true);
    expect(isInspectableUrl('https://evil.com/api/x', 'distrokid.com')).toBe(false);
    expect(isInspectableUrl('https://notdistrokid.com/api/x', 'distrokid.com')).toBe(false);
  });

  it('never inspects money/identity/auth routes', () => {
    for (const p of ['/bank/details', '/tax/forms', '/payment/methods', '/account/settings', '/api/auth/token', '/signin']) {
      expect(isSensitivePath(p)).toBe(true);
      expect(isInspectableUrl(`https://distrokid.com${p}`, 'distrokid.com')).toBe(false);
    }
    expect(isSensitivePath('/api/album/123')).toBe(false);
  });

  it('recognizes sensitive keys', () => {
    for (const k of ['cookie', 'Authorization', 'access_token', 'password', 'ssn', 'iban', 'email']) expect(isSensitiveKey(k)).toBe(true);
    expect(isSensitiveKey('upc')).toBe(false);
    expect(isSensitiveKey('isrc')).toBe(false);
  });

  it('debug shape redaction keeps structure but no values', () => {
    const shape = redactPayloadShape({ upc: '199751675992', authorization: 'Bearer X', nested: { isrc: 'QT6ED2521965' } });
    const s = JSON.stringify(shape);
    expect(s).not.toContain('199751675992');
    expect(s).not.toContain('Bearer X');
    expect(s).not.toContain('QT6ED2521965');
    expect(s).toContain('{string}');
    expect(s).toContain('{redacted}');
  });

  it('redacts errors to a category only', () => {
    expect(redactError(new TypeError('token=SECRET leaked'))).toBe('TypeError');
    expect(redactError('raw string')).toBe('UnknownError');
  });

  it('raw network debug is OFF by default and TTL-bounded when on', () => {
    expect(readNetworkDebugConfig({}).enabled).toBe(false);
    const cfg = readNetworkDebugConfig({ ENABLE_DISTRIBUTOR_NETWORK_DEBUG: 'true', DISTRIBUTOR_NETWORK_DEBUG_TTL_MINUTES: '30' });
    expect(cfg.enabled).toBe(true);
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    expect(isDebugArtifactExpired(old, cfg)).toBe(true);
    expect(isDebugArtifactExpired(new Date().toISOString(), cfg)).toBe(false);
  });

  it('masks ids in paths', () => {
    expect(maskPath('/dashboard/album/82C05623-BA75-4770-A051-6052237A6409')).toBe('/dashboard/album/{uuid}');
    expect(maskPath('/api/release/123456')).toBe('/api/release/{n}');
  });
});

// ---------------------------------------------------------------- field status / identifier modeling
describe('field status + identifier modeling', () => {
  it('distinguishes absent-at-source from extraction failure', () => {
    const absent = absentAtSource<string>('NETWORK_JSON', 'v1');
    const timedOut = notCaptured<string>('TIMEOUT', 'NETWORK_JSON', 'v1');
    expect(isAbsentAtSource(absent)).toBe(true);
    expect(isExtractionFailure(absent)).toBe(false);
    expect(isExtractionFailure(timedOut)).toBe(true);
  });

  it('never renders a not-captured field as "Missing"', () => {
    expect(explainField(notCaptured<string>('TIMEOUT', 'NETWORK_JSON', 'v1'), 'ISRC')).toBe('ISRC: not captured — distributor metadata request timed out');
    expect(explainField(absentAtSource<string>('NETWORK_JSON', 'v1'), 'ISRC')).toBe('ISRC: none at distributor');
    expect(explainField(present('QT6ED2521965', 'NETWORK_JSON', 'v1'), 'ISRC')).toBe('ISRC: QT6ED2521965');
  });
});

// ---------------------------------------------------------------- parser v1
describe('parser v1 (Zod, schema-versioned)', () => {
  it('locates the release object inside an envelope', () => {
    expect(locateReleaseObject({ data: { release: { upc: '199751675992', tracks: [] } } })).toMatchObject({ upc: '199751675992' });
    expect(locateReleaseObject({ nothing: true })).toBeUndefined();
  });

  it('parses release-level UPC/artwork and track-level ISRC with correct statuses', () => {
    const r = parseDistroKidReleaseV1({
      data: { release: { id: 'R1', title: 'Lagos Nights', upc: '0888072100001', artworkUrl: 'https://cdn/x.jpg', releaseDate: '2023-04-01', label: 'Lewis Music', tracks: [{ id: 'T1', title: 'Lagos City Nights', isrc: 'USKE12310001', trackNumber: 1 }] } },
    });
    expect(r.distributorReleaseId).toBe('R1');
    expect(r.upc).toMatchObject({ value: '0888072100001', status: 'PRESENT', source: 'NETWORK_JSON', parserVersion: PARSER_VERSION });
    expect(r.artworkUrl.status).toBe('PRESENT');
    expect(r.tracks[0]!.isrc).toMatchObject({ value: 'USKE12310001', status: 'PRESENT' });
    expect(r.tracks[0]!.distributorTrackId).toBe('T1');
  });

  it('keeps fields omitted by a partial endpoint retryable instead of inventing source absence', () => {
    const r = parseDistroKidReleaseV1({ release: { id: 'R2', title: 'Silent Waves', tracks: [{ title: 'Alone Tonight', trackNumber: 1 }] } });
    expect(r.upc.status).toBe('NOT_CAPTURED');
    expect(r.artworkUrl.status).toBe('NOT_CAPTURED');
    expect(r.releaseDate.status).toBe('NOT_CAPTURED');
    expect(r.tracks[0]!.isrc.status).toBe('NOT_CAPTURED');
  });

  it('marks supplied-but-malformed identifiers and artwork as PARSE_FAILED, never absent at source', () => {
    const r = parseDistroKidReleaseV1({
      release: {
        id: 'R3', title: 'X', upc: 'NOT-A-UPC', artworkUrl: 'not a URL',
        tracks: [{ title: 'Y', isrc: 'NOT-AN-ISRC', trackNumber: 1 }],
      },
    });
    expect(r.upc.status).toBe('PARSE_FAILED');
    expect(r.artworkUrl.status).toBe('PARSE_FAILED');
    expect(r.tracks[0]!.isrc.status).toBe('PARSE_FAILED');
    expect(isExtractionFailure(r.upc)).toBe(true);
    expect(isExtractionFailure(r.artworkUrl)).toBe(true);
    expect(isExtractionFailure(r.tracks[0]!.isrc)).toBe(true);
  });

  it('treats explicitly supplied null or empty fields as genuinely absent at source', () => {
    const r = parseDistroKidReleaseV1({
      release: {
        id: 'R-empty', title: 'X', upc: '  ', artworkUrl: '', releaseDate: null,
        uploadDate: null, label: null, tracks: [{ title: 'Y', isrc: ' ' }],
      },
    });
    expect(r.upc.status).toBe('ABSENT_AT_SOURCE');
    expect(r.artworkUrl.status).toBe('ABSENT_AT_SOURCE');
    expect(r.releaseDate.status).toBe('ABSENT_AT_SOURCE');
    expect(r.uploadDate?.status).toBe('ABSENT_AT_SOURCE');
    expect(r.label?.status).toBe('ABSENT_AT_SOURCE');
    expect(r.tracks[0]!.isrc.status).toBe('ABSENT_AT_SOURCE');
  });

  it('rejects a blank track row instead of completing an identity-less track', () => {
    expect(() => parseDistroKidReleaseV1({ release: { id: 'R-blank', title: 'X', tracks: [{}] } }))
      .toThrow(/track 1 has no id, title, or valid ISRC/);
  });

  it('accepts an identifiers-only track when its ISRC supplies a stable identity', () => {
    const r = parseDistroKidReleaseV1({ release: { id: 'R-identifiers', tracks: [{ isrc: 'QT6ED2521965' }] } });
    expect(r.tracks[0]).toMatchObject({ title: '', isrc: { status: 'PRESENT', value: 'QT6ED2521965' } });
  });

  it('accepts alternate field names (barcode/coverArt/name/position)', () => {
    const r = parseDistroKidReleaseV1({ album: { albumUuid: 'U1', name: 'Pesa', barcode: '199751675992', coverArt: 'https://cdn/c.jpg', tracks: [{ name: 'Pesa', isrc: 'QT6ED2521965', position: 1 }] } });
    expect(r.upc.value).toBe('199751675992');
    expect(r.artworkUrl.value).toBe('https://cdn/c.jpg');
    expect(r.tracks[0]!.isrc.value).toBe('QT6ED2521965');
    expect(r.tracks[0]!.trackNumber).toBe(1);
  });

  it('normalizes structured release featured-artist arrays without parsing free text', () => {
    const source = [
      '  Nviiri  ',
      { name: 'Bensoul' },
      { artistName: 'nviiri' },
      { artist: { name: '  Bien  ' } },
      '   ',
    ];
    const r = parseDistroKidReleaseV1({
      release: { id: 'R-features', title: 'Collaboration', featuredArtists: source, tracks: [] },
    });
    expect(r.featuredArtists).toEqual(['Nviiri', 'Bensoul', 'Bien']);

    // The normalized result owns its array and strings; retaining the source payload for a retry
    // cannot let a later consumer mutate the parsed release (or vice versa).
    source.push('Later mutation');
    r.featuredArtists!.push('Projection mutation');
    expect(source).not.toContain('Projection mutation');
    expect(r.featuredArtists).not.toContain('Later mutation');
  });

  it('rejects scalar/free-text featured credits instead of guessing how to split them', () => {
    expect(() => parseDistroKidReleaseV1({
      release: { id: 'R-free-text', title: 'X', featuredArtists: 'A feat. B, C', tracks: [] },
    })).toThrow(/schema validation/i);
    expect(() => parseDistroKidReleaseV1({
      release: { id: 'R-unknown-credit', title: 'X', featuredArtists: [{ display: 'A' }], tracks: [] },
    })).toThrow(/schema validation/i);
  });

  it('throws SchemaMismatchError when there is no release object', () => {
    expect(() => parseDistroKidReleaseV1({ event: 'ping' })).toThrow(SchemaMismatchError);
  });
});

// ---------------------------------------------------------------- parser registry / drift
describe('parser registry (schema drift → alert, never silent partial data)', () => {
  it('parses via v1 and reports the version used', () => {
    const reg = new ParserRegistry();
    const out = reg.parse({ release: { id: '1', title: 'T', upc: '199751675992', tracks: [] } });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.parserVersion).toBe(PARSER_VERSION);
  });

  it('raises SOURCE_SCHEMA_CHANGED when no variant matches — it does not guess', () => {
    const alerts: string[] = [];
    const reg = new ParserRegistry(undefined, (a) => alerts.push(a.code));
    const out = reg.parse({ totally: 'different', shape: [1, 2, 3] });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('SCHEMA_CHANGED');
    expect(alerts).toContain('SOURCE_SCHEMA_CHANGED');
  });

  it('keeps older parsers so a rollback is config, not code', () => {
    expect(new ParserRegistry().versions).toContain(PARSER_VERSION);
  });
});

// ---------------------------------------------------------------- endpoint registry
describe('endpoint registry lifecycle', () => {
  const candidate = (fp: string, score = 20): RankedCandidate => ({
    fingerprint: fp, descriptor: `GET distrokid.com/api/album/{uuid}`,
    identity: { method: 'GET', host: 'distrokid.com', pathPattern: '/api/album/{uuid}', queryKeys: [] },
    score, rank: score, schemaKeys: ['isrc', 'upc', 'tracks'], schemaHash: 'h1',
    observations: 3, distinctPayloads: 3, hasStrongSignal: true, releaseIds: ['R1'],
  });

  it('promotes CANDIDATE → VALIDATING → ACTIVE automatically (no manual step)', async () => {
    const reg = new EndpointRegistry(new InMemoryEndpointRegistryStore(), { tenantId: 't1', distributor: 'DISTROKID' });
    const p = await reg.observe(candidate('f1'), 'releaseDetails', 'v1');
    expect(p.status).toBe('CANDIDATE');
    let cur = await reg.recordSuccess('f1', 'h1');
    expect(cur!.status).toBe('VALIDATING');
    for (let i = 1; i < VALIDATION_CAPTURES_REQUIRED; i++) cur = await reg.recordSuccess('f1', 'h1');
    expect(cur!.status).toBe('ACTIVE');
    expect(cur!.approvedAt).toBeDefined();
  });

  it('degrades an ACTIVE endpoint after repeated failures and alerts', async () => {
    const alerts: string[] = [];
    const reg = new EndpointRegistry(new InMemoryEndpointRegistryStore(), { tenantId: 't1', distributor: 'DISTROKID' }, (a) => alerts.push(a.code));
    await reg.observe(candidate('f2'), 'releaseDetails', 'v1');
    for (let i = 0; i < VALIDATION_CAPTURES_REQUIRED; i++) await reg.recordSuccess('f2', 'h1');
    let cur = null;
    for (let i = 0; i < DEGRADE_AFTER_FAILURES; i++) cur = await reg.recordFailure('f2', 'TIMEOUT');
    expect(cur!.status).toBe('DEGRADED');
    expect(alerts).toContain('ENDPOINT_DEGRADED');
  });

  it('schema drift marks DEGRADED + alerts SOURCE_SCHEMA_CHANGED', async () => {
    const alerts: string[] = [];
    const reg = new EndpointRegistry(new InMemoryEndpointRegistryStore(), { tenantId: 't1', distributor: 'DISTROKID' }, (a) => alerts.push(a.code));
    await reg.observe(candidate('f3'), 'releaseDetails', 'v1');
    const drifted = await reg.recordSchemaDrift('f3', 'DIFFERENT_HASH');
    expect(drifted!.status).toBe('DEGRADED');
    expect(alerts).toContain('SOURCE_SCHEMA_CHANGED');
  });

  it('prefers ACTIVE over CANDIDATE for a role', async () => {
    const reg = new EndpointRegistry(new InMemoryEndpointRegistryStore(), { tenantId: 't1', distributor: 'DISTROKID' });
    await reg.observe(candidate('low', 5), 'releaseDetails', 'v1');
    await reg.observe(candidate('high', 30), 'releaseDetails', 'v1');
    for (let i = 0; i < VALIDATION_CAPTURES_REQUIRED; i++) await reg.recordSuccess('low', 'h1');
    const chosen = await reg.activeFor('releaseDetails');
    expect(chosen!.fingerprint).toBe('low'); // ACTIVE beats a higher-scoring CANDIDATE
  });

  it('matches a response identity to a profile by SHAPE', async () => {
    const reg = new EndpointRegistry(new InMemoryEndpointRegistryStore(), { tenantId: 't1', distributor: 'DISTROKID' });
    const p = await reg.observe(candidate('f4'), 'releaseDetails', 'v1');
    expect(matchesProfile(p, { method: 'GET', host: 'distrokid.com', pathPattern: '/api/album/{uuid}', queryKeys: [] })).toBe(true);
    expect(matchesProfile(p, { method: 'POST', host: 'distrokid.com', pathPattern: '/api/album/{uuid}', queryKeys: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------- endpoint bundles
describe('endpoint bundles (never assume one endpoint)', () => {
  const c = (keys: string[], distinct = 3): RankedCandidate => ({
    fingerprint: 'f', descriptor: 'd', identity: { method: 'GET', host: 'h', pathPattern: '/p', queryKeys: [] },
    score: 10, rank: 10, schemaKeys: keys, schemaHash: 'h', observations: 3, distinctPayloads: distinct, hasStrongSignal: true, releaseIds: [],
  });

  it('infers a role from schema shape', () => {
    expect(inferRole(c(['upc', 'tracks', 'isrc']))).toBe('releaseDetails');
    expect(inferRole(c(['isrc', 'trackid']))).toBe('trackIdentifiers');
    expect(inferRole(c(['artwork', 'coverurl']))).toBe('artwork');
    expect(inferRole(c(['releases', 'releaseid'], 1))).toBe('catalogIndex');
  });

  it('merges partials without overwriting existing values', () => {
    expect(mergePartial({ a: 1, b: undefined as unknown as number, list: [] as number[] }, { b: 2, list: [3], a: 9 })).toEqual({ a: 1, b: 2, list: [3] });
  });

  it('merges release credits and identifier/detail track gaps without mutation aliasing', () => {
    const base: CanonicalDistributorRelease = {
      distributorReleaseId: 'R1', title: '', featuredArtists: [],
      upc: present('199751675992', 'NETWORK_JSON', 'v1'),
      artworkUrl: absentAtSource('NETWORK_JSON', 'v1'),
      releaseDate: absentAtSource('NETWORK_JSON', 'v1'),
      tracks: [{ title: '', trackNumber: 1, isrc: present('QT6ED2521965', 'NETWORK_JSON', 'v1') }],
    };
    const extra: CanonicalDistributorRelease = {
      distributorReleaseId: 'R1', title: 'Catalog title', featuredArtists: ['Guest One', 'Guest Two'],
      upc: absentAtSource('NETWORK_JSON', 'v1'),
      artworkUrl: present('https://cdn.example/art.jpg', 'NETWORK_JSON', 'v1'),
      releaseDate: present('2026-01-01', 'NETWORK_JSON', 'v1'),
      tracks: [{ title: 'Catalog track title', trackNumber: 1, isrc: absentAtSource('NETWORK_JSON', 'v1') }],
    };

    const merged = mergeCanonicalRelease(base, extra);
    expect(merged).toMatchObject({
      title: 'Catalog title', featuredArtists: ['Guest One', 'Guest Two'],
      tracks: [{ title: 'Catalog track title', isrc: { status: 'PRESENT', value: 'QT6ED2521965' } }],
      artworkUrl: { status: 'PRESENT', value: 'https://cdn.example/art.jpg' },
    });
    merged.featuredArtists!.push('Projection mutation');
    merged.tracks[0]!.title = 'Projection mutation';
    expect(extra.featuredArtists).toEqual(['Guest One', 'Guest Two']);
    expect(extra.tracks[0]!.title).toBe('Catalog track title');
    expect(base.featuredArtists).toEqual([]);
    expect(base.tracks[0]!.title).toBe('');
  });
});

// ---------------------------------------------------------------- gated direct reader
describe('direct JSON reader is gated', () => {
  it('is disabled by default', () => {
    expect(isDirectReaderAllowed(readDirectReaderFlags({}))).toBe(false);
  });

  it('requires BOTH the feature flag and the legal-review flag', () => {
    expect(isDirectReaderAllowed(readDirectReaderFlags({ ENABLE_DISTROKID_DIRECT_JSON_READER: 'true' }))).toBe(false);
    expect(isDirectReaderAllowed(readDirectReaderFlags({ LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED: 'true' }))).toBe(false);
    expect(isDirectReaderAllowed(readDirectReaderFlags({ ENABLE_DISTROKID_DIRECT_JSON_READER: 'true', LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED: 'true' }))).toBe(true);
  });

  it('refuses to run when not approved, even if called', async () => {
    const r = new DirectJsonReader(readDirectReaderFlags({}), 'distrokid.com', new Set(['R1']));
    const out = await r.fetchRelease({} as never, 'R1', 'https://distrokid.com/api/album/R1');
    expect(out).toMatchObject({ ok: false, reason: 'DISABLED' });
  });

  it('refuses a release id NOT discovered from the connected account (no enumeration)', async () => {
    const flags = readDirectReaderFlags({ ENABLE_DISTROKID_DIRECT_JSON_READER: 'true', LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED: 'true' });
    const r = new DirectJsonReader(flags, 'distrokid.com', new Set(['MINE']));
    const out = await r.fetchRelease({} as never, 'SOMEONE_ELSE', 'https://distrokid.com/api/album/SOMEONE_ELSE');
    expect(out).toMatchObject({ ok: false, reason: 'NOT_OWNED' });
  });

  it('refuses a cross-origin or sensitive URL', async () => {
    const flags = readDirectReaderFlags({ ENABLE_DISTROKID_DIRECT_JSON_READER: 'true', LEGAL_REVIEW_DISTROKID_DIRECT_JSON_APPROVED: 'true' });
    const r = new DirectJsonReader(flags, 'distrokid.com', new Set(['R1']));
    expect(await r.fetchRelease({} as never, 'R1', 'https://evil.com/x')).toMatchObject({ ok: false, reason: 'FORBIDDEN_URL' });
    expect(await r.fetchRelease({} as never, 'R1', 'https://distrokid.com/bank/details')).toMatchObject({ ok: false, reason: 'FORBIDDEN_URL' });
  });

  it('halts on reauth and does not keep hammering the account', async () => {
    const flags = { enabled: true, legalApproved: true, minDelayMs: 0 };
    const page = { request: { get: async () => ({ status: () => 401, ok: () => false, json: async () => ({}) }) } };
    const r = new DirectJsonReader(flags, 'distrokid.com', new Set(['R1']));
    const first = await r.fetchRelease(page as never, 'R1', 'https://distrokid.com/api/album/R1');
    expect(first).toMatchObject({ ok: false, reason: 'REAUTH_REQUIRED' });
    expect(r.isHalted).toBe(true);
    expect(await r.fetchRelease(page as never, 'R1', 'https://distrokid.com/api/album/R1')).toMatchObject({ reason: 'REAUTH_REQUIRED' });
  });

  it('respects the minimum delay between requests (rate-limit preservation)', async () => {
    const flags = { enabled: true, legalApproved: true, minDelayMs: 750 };
    let slept = 0;
    let clock = 0;
    const page = { request: { get: async () => ({ status: () => 200, ok: () => true, json: async () => ({ ok: 1 }) }) } };
    const r = new DirectJsonReader(flags, 'distrokid.com', new Set(['A', 'B']), async (ms) => { slept += ms; clock += ms; }, () => clock);
    await r.fetchRelease(page as never, 'A', 'https://distrokid.com/api/album/A');
    await r.fetchRelease(page as never, 'B', 'https://distrokid.com/api/album/B');
    expect(slept).toBeGreaterThanOrEqual(750);
  });
});

// ---------------------------------------------------------------- completeness
describe('completeness reconciliation', () => {
  const rel = (id: string, upc: 'PRESENT' | 'ABSENT_AT_SOURCE' | 'TIMEOUT', isrcs: Array<'PRESENT' | 'ABSENT_AT_SOURCE'>): CanonicalDistributorRelease => ({
    distributorReleaseId: id, title: id,
    upc: upc === 'PRESENT' ? present('199751675992', 'NETWORK_JSON', 'v1') : upc === 'ABSENT_AT_SOURCE' ? absentAtSource('NETWORK_JSON', 'v1') : notCaptured('TIMEOUT', 'NETWORK_JSON', 'v1'),
    artworkUrl: present('https://cdn/x.jpg', 'NETWORK_JSON', 'v1'),
    releaseDate: present('2025-01-01', 'NETWORK_JSON', 'v1'),
    tracks: isrcs.map((s, i) => ({ title: `t${i}`, isrc: s === 'PRESENT' ? present(`USKE1231000${i}`, 'NETWORK_JSON', 'v1') : absentAtSource('NETWORK_JSON', 'v1') })),
  });
  const done = (r: CanonicalDistributorRelease): ReleaseExtractionOutcome => ({ kind: 'COMPLETED', release: r, source: 'NETWORK_JSON', elapsedMs: 10 });

  it('is COMPLETE only when every release is terminal and nothing was our failure', () => {
    const { status, completeness } = reconcile({ expectedReleaseIds: ['A', 'B'], outcomes: [done(rel('A', 'PRESENT', ['PRESENT'])), done(rel('B', 'PRESENT', ['PRESENT']))] });
    expect(status).toBe('COMPLETE');
    expect(completeness.releasesWithUpc).toBe(2);
    expect(completeness.tracksWithIsrc).toBe(2);
    expect(completeness.expectedTracksKnown).toBe(false);
    expect(describeCompleteness(completeness, status)).toContain('tracks 2/unknown');
  });

  it('marks the expected track total as known only when it was independently supplied', () => {
    const { status, completeness } = reconcile({
      expectedReleaseIds: ['A'], expectedTracks: 3,
      outcomes: [done(rel('A', 'PRESENT', ['PRESENT', 'PRESENT']))],
    });
    expect(completeness.expectedTracksKnown).toBe(true);
    expect(completeness.expectedTracks).toBe(3);
    expect(completeness.extractedTracks).toBe(2);
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(describeCompleteness(completeness, status)).toContain('tracks 2/3');
  });

  it('an indexed release with NO outcome is never silently ignored', () => {
    const { status, completeness } = reconcile({ expectedReleaseIds: ['A', 'B'], outcomes: [done(rel('A', 'PRESENT', ['PRESENT']))] });
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(completeness.unresolvedReleaseIds).toEqual(['B']);
  });

  it('source gaps are COMPLETE_WITH_SOURCE_GAPS — not our failure', () => {
    const { status } = reconcile({ expectedReleaseIds: ['A'], outcomes: [done(rel('A', 'ABSENT_AT_SOURCE', ['ABSENT_AT_SOURCE']))] });
    expect(status).toBe('COMPLETE_WITH_SOURCE_GAPS');
  });

  it('OUR extraction failure is PARTIAL_RETRYABLE, never reported as complete', () => {
    const { status, completeness } = reconcile({ expectedReleaseIds: ['A'], outcomes: [done(rel('A', 'TIMEOUT', ['PRESENT']))] });
    expect(status).toBe('PARTIAL_RETRYABLE');
    expect(completeness.releasesUpcNotCaptured).toBe(1);
    expect(completeness.releasesUpcAbsentAtSource).toBe(0);
  });

  it('schema change and reauth get their own terminal statuses', () => {
    expect(reconcile({ expectedReleaseIds: ['A'], outcomes: [{ kind: 'FAILED', distributorReleaseId: 'A', reason: 'SCHEMA_CHANGED', detail: 'x', elapsedMs: 1 }] }).status).toBe('FAILED_SCHEMA_CHANGED');
    expect(reconcile({ expectedReleaseIds: ['A'], outcomes: [{ kind: 'FAILED', distributorReleaseId: 'A', reason: 'REAUTH_REQUIRED', detail: 'x', elapsedMs: 1 }] }).status).toBe('PARTIAL_REAUTH_REQUIRED');
  });

  it('retries FAILED + unresolved releases only — never the whole catalogue', () => {
    const ids = retryableReleaseIds({
      expectedReleaseIds: ['OK', 'TIMEDOUT', 'NEVER_ATTEMPTED', 'FORBIDDEN'],
      outcomes: [
        done(rel('OK', 'PRESENT', ['PRESENT'])),
        { kind: 'FAILED', distributorReleaseId: 'TIMEDOUT', reason: 'TIMEOUT', detail: '', elapsedMs: 1 },
        { kind: 'FAILED', distributorReleaseId: 'FORBIDDEN', reason: 'NOT_AUTHORIZED', detail: '', elapsedMs: 1 },
      ],
    });
    expect(ids.sort()).toEqual(['NEVER_ATTEMPTED', 'TIMEDOUT']); // OK excluded; NOT_AUTHORIZED not retryable
  });

  it('reports UPC and ISRC coverage SEPARATELY (never one combined number)', () => {
    const { completeness, status } = reconcile({ expectedReleaseIds: ['A'], outcomes: [done(rel('A', 'PRESENT', ['PRESENT', 'ABSENT_AT_SOURCE']))] });
    const line = describeCompleteness(completeness, status);
    expect(line).toContain('UPC 1/1');
    expect(line).toContain('ISRC 1/2');
    expect(line).toContain('artwork 1/1');
  });

  it('deriveStatus fails a snapshot where nothing completed', () => {
    expect(deriveStatus({ ...reconcile({ expectedReleaseIds: [], outcomes: [] }).completeness, expectedReleases: 5, completedReleases: 0 })).toBe('FAILED');
  });
});
