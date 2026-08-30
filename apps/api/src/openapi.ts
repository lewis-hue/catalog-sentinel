/** Hand-authored OpenAPI 3.1 document served at /openapi.json (PRD §I). */
export function openApiDocument(baseUrl: string, _options: { production?: boolean } = {}): Record<string, unknown> {
  const ok = { description: 'Success' };
  const json = (ref: string) => ({ content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const errorDescriptions: Record<number, string> = {
    400: 'Invalid request', 401: 'Authentication required', 403: 'Insufficient role',
    404: 'Not found', 409: 'Resource state conflict', 422: 'Nothing to process', 429: 'Rate limit exceeded',
    502: 'Upstream operation failed', 503: 'Required cleanup or dependency is not yet confirmed',
  };
  const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), { description: errorDescriptions[code] }]));
  const activePaths = {
    '/health': { get: { summary: 'Process health', security: [], responses: { '200': ok } } },
    '/health/live': { get: { summary: 'Liveness probe', security: [], responses: { '200': ok } } },
    '/health/ready': { get: { summary: 'Dependency-aware readiness probe', security: [], responses: { '200': ok, '503': { description: 'A required dependency is unavailable' } } } },
    '/health/dependencies': { get: { summary: 'Detailed dependency status (operations role)', responses: { '200': ok, ...errors(401, 403) } } },
    '/api/consent': { post: { summary: 'Grant scoped DistroKid catalog-read consent', responses: { '201': ok, ...errors(400, 401, 403, 429) } } },
    '/api/consent/{id}/revoke': { post: { summary: 'Revoke consent and terminate associated Steel sessions', parameters: [pathId()], responses: { '200': ok, '202': { description: 'Consent is revoked; durable Steel cleanup remains pending' }, ...errors(401, 403, 404, 503) } } },
    '/api/connect': { post: { summary: 'Open an attended Steel DistroKid session', responses: { '200': ok, ...errors(400, 401, 403, 429, 502, 503) } } },
    '/api/connect/{id}/scan': { post: { summary: 'Confirm login and enqueue the durable catalog pipeline', parameters: [pathId()], responses: { '200': ok, ...errors(401, 403, 404, 502) } } },
    '/api/connect/{id}/cancel': { post: { summary: 'Terminate an attended Steel session', parameters: [pathId()], responses: { '204': { description: 'Steel session terminated' }, ...errors(401, 403, 404, 502) } } },
    '/api/searches': {
      post: { summary: 'Create and enqueue a principal-owned catalog search', requestBody: json('CreateCatalogSearch'), responses: { '201': ok, ...errors(400, 401, 403, 502) } },
      get: {
        summary: 'List caller-owned catalog searches',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' }, description: 'Opaque cursor returned by the preceding page.' },
        ],
        responses: {
          '200': {
            description: 'Newest-first page. The JSON body remains an array wrapper for compatibility.',
            headers: {
              'X-Sentinel-Next-Cursor': {
                description: 'Opaque cursor for the next page; absent when history is exhausted.',
                schema: { type: 'string' },
              },
            },
          },
          ...errors(400, 401, 403),
        },
      },
    },
    '/api/searches/{id}': {
      get: { summary: 'Get a principal-owned catalog search', parameters: [pathId()], responses: { '200': ok, ...errors(401, 403, 404) } },
      patch: { summary: 'Rename a principal-owned catalog search', parameters: [pathId()], requestBody: json('RenameCatalogSearch'), responses: { '200': ok, ...errors(400, 401, 403, 404) } },
      delete: { summary: 'Delete a terminal principal-owned catalog search', parameters: [pathId()], responses: { '204': { description: 'Deleted' }, ...errors(401, 403, 404, 409) } },
    },
    '/api/searches/{id}/rescan': {
      post: {
        summary: 'Recheck platforms from a saved distributor snapshot',
        description: 'Creates a linked scan and refreshes platform-presence evidence from the saved snapshot. It does not re-extract current DistroKid metadata; clients must link “Refresh from DistroKid” to /connect for a new attended Steel extraction.',
        parameters: [pathId()],
        requestBody: json('RescanCatalogSearch'),
        responses: { '201': { description: 'Platform recheck created and queued' }, ...errors(400, 401, 403, 404, 409, 502, 503) },
      },
    },
    '/api/searches/{id}/catalogue': {
      get: {
        summary: 'Read the scraped distributor catalogue for a search',
        description: 'Releases, tracks, metadata, cover art and ISRCs from the authoritative outcome tables, independent of store-presence verification. This is the standalone catalogue the dashboard renders and exports.',
        parameters: [pathId()],
        responses: { '200': ok, ...errors(401, 403, 404, 503) },
      },
    },
    '/api/searches/{id}/store-check': {
      post: {
        summary: 'Run on-demand store-presence verification for a scraped catalogue',
        description: 'Starts (or re-runs) the multi-store presence check in place on this search, so its per-store results join back to the same catalogue. Scraping is decoupled from verification; this is the explicit trigger. Idempotent while a check is already in flight (409).',
        parameters: [pathId()],
        responses: { '202': { description: 'Store-presence check queued' }, ...errors(401, 403, 404, 409, 422, 503) },
      },
    },
    '/api/searches/{id}/lyrics-check': {
      post: {
        summary: 'Run on-demand lyric-availability verification (LRCLIB) for a scraped catalogue',
        description: 'Starts (or re-runs) the fault-isolated lyric check in place on this search, resolving whether plain and time-synced lyrics exist for each track. Independent of the store-presence check (they can run concurrently); only the scrape reading state blocks it.',
        parameters: [pathId()],
        responses: { '202': { description: 'Lyric check queued' }, ...errors(401, 403, 404, 409, 422, 503) },
      },
    },
    '/api/searches/{id}/manual-review': { get: { summary: 'List principal-scoped manual-review items', parameters: [pathId()], responses: { '200': ok, ...errors(401, 403, 404) } } },
    '/api/searches/{id}/manual-review/{itemId}': { patch: { summary: 'Record a principal-scoped manual-review decision', parameters: [pathId(), pathParam('itemId')], responses: { '200': ok, ...errors(400, 401, 403, 404) } } },
    '/api/distributor-imports/csv': { post: { summary: 'Import a principal-owned distributor CSV export', responses: { '200': ok, ...errors(400, 401, 403) } } },
    '/api/integrations/steel/status': { get: { summary: 'Get redacted Steel readiness status', responses: { '200': ok } } },
    '/api/search-provider/status': { get: { summary: 'Get search-provider status (operations role)', responses: { '200': ok } } },
    '/api/platforms/credential-status': { get: { summary: 'Get redacted platform credential status (operations role)', responses: { '200': ok } } },
    '/api/queues/status': { get: { summary: 'Get queue status (operations role)', responses: { '200': ok } } },
    '/api/catalogue/engine': { get: { summary: 'Get active catalog extraction engine (operations role)', responses: { '200': ok } } },
    '/api/admin/distributor-scans/{scanId}/endpoint-candidates': { get: { summary: 'List sanitized endpoint candidates (operations role)', parameters: [pathParam('scanId')], responses: { '200': ok } } },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Artist Catalog Sentinel API',
      version: '1.0.0',
      description:
        'Audits authorized distributor catalogs against DSP catalogs. Every record is scoped to the OIDC subject that created it (per-user isolation; no cross-user access), and distributor login uses attended Steel sessions; passwords and Steel API credentials are never accepted by this API.',
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    paths: activePaths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        CreateCatalogSearch: {
          type: 'object',
          required: ['artist'],
          properties: {
            name: scanNameSchema(),
            artist: { type: 'string', minLength: 1 },
            distributor: { type: 'string' },
            platforms: { type: 'array', items: { type: 'string' } },
          },
        },
        RenameCatalogSearch: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: scanNameSchema() },
        },
        RescanCatalogSearch: {
          type: 'object',
          additionalProperties: false,
          properties: { name: scanNameSchema() },
        },
      },
    },
  };
}

function pathId() {
  return pathParam('id');
}
function pathParam(name: string) {
  return { name, in: 'path', required: true, schema: { type: 'string' } };
}
function scanNameSchema() {
  return { type: 'string', minLength: 1, maxLength: 120 };
}
