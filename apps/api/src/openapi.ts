/** Hand-authored OpenAPI 3.1 document served at /openapi.json (PRD §I). */
export function openApiDocument(baseUrl: string, _options: { production?: boolean } = {}): Record<string, unknown> {
  const ok = { description: 'Success' };
  const json = (ref: string) => ({ content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } } });
  const errorDescriptions: Record<number, string> = {
    400: 'Invalid request', 401: 'Authentication required', 403: 'Insufficient role',
    404: 'Not found', 409: 'Resource state conflict', 429: 'Rate limit exceeded', 502: 'Upstream operation failed',
    503: 'Required cleanup or dependency is not yet confirmed',
  };
  const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), { description: errorDescriptions[code] }]));
  const activePaths = {
    '/health': { get: { summary: 'Process health', security: [], responses: { '200': ok } } },
    '/health/live': { get: { summary: 'Liveness probe', security: [], responses: { '200': ok } } },
    '/health/ready': { get: { summary: 'Dependency-aware readiness probe', security: [], responses: { '200': ok, '503': { description: 'A required dependency is unavailable' } } } },
    '/health/dependencies': { get: { summary: 'Detailed dependency status (operations role)', responses: { '200': ok, ...errors(401, 403) } } },
    '/api/organization/members': {
      get: { summary: 'List organization memberships visible to the caller', responses: { '200': ok, ...errors(401, 403, 503) } },
    },
    '/api/organization/members/{subjectId}': {
      patch: {
        summary: 'Change an organization member role or status',
        parameters: [pathParam('subjectId')],
        requestBody: json('OrganizationMembershipUpdate'),
        responses: { '200': ok, ...errors(400, 401, 403, 409, 503) },
      },
      delete: {
        summary: 'Remove an organization member while preserving the last owner',
        parameters: [pathParam('subjectId')],
        responses: { '204': { description: 'Removed' }, ...errors(401, 403, 404, 409, 503) },
      },
    },
    '/api/organization/workspace-memberships': {
      get: {
        summary: 'List caller-visible workspace memberships',
        parameters: [{ name: 'workspaceId', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': ok, ...errors(400, 401, 403, 503) },
      },
    },
    '/api/organization/workspaces/{workspaceId}/members/{subjectId}': {
      put: {
        summary: 'Grant or change a workspace membership',
        parameters: [pathParam('workspaceId'), pathParam('subjectId')],
        requestBody: json('WorkspaceMembershipGrant'),
        responses: { '200': ok, ...errors(400, 401, 403, 503) },
      },
      delete: {
        summary: 'Remove a workspace membership while preserving the last owner',
        parameters: [pathParam('workspaceId'), pathParam('subjectId')],
        responses: { '204': { description: 'Removed' }, ...errors(401, 403, 404, 409, 503) },
      },
    },
    '/api/organization/invitations': {
      post: {
        summary: 'Issue an organization invitation',
        description: 'Requires Idempotency-Key. The bearer token is returned only on the creation response and is never persisted in plaintext.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 } }],
        requestBody: json('IssueOrganizationInvitation'),
        responses: { '201': { description: 'Invitation created; includes the one-time bearer token' }, '200': { description: 'Idempotent replay; bearerToken is null' }, ...errors(400, 401, 403, 409, 503) },
      },
    },
    '/api/organization/invitations/{invitationId}/revoke': {
      post: {
        summary: 'Revoke an unaccepted organization invitation',
        parameters: [pathParam('invitationId')],
        responses: { '204': { description: 'Revoked' }, ...errors(401, 403, 404, 503) },
      },
    },
    '/api/organization/invitations/accept': {
      post: {
        summary: 'Accept an invitation using the caller verified OIDC email',
        requestBody: json('AcceptOrganizationInvitation'),
        responses: { '200': ok, ...errors(400, 401, 403, 409, 503) },
      },
    },
    '/api/organization/erasure-requests': {
      post: {
        summary: 'Queue comprehensive erasure of the active organization',
        description: 'Requires an active organization owner and Idempotency-Key. Execution is durable and processes every governed data class.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 200 } }],
        requestBody: json('RequestTenantErasure'),
        responses: { '202': { description: 'Erasure request accepted or idempotently returned' }, ...errors(400, 401, 403, 409, 503) },
      },
    },
    '/api/organization/erasure-requests/{requestId}': {
      get: {
        summary: 'Read tenant-scoped erasure progress',
        parameters: [pathParam('requestId')],
        responses: { '200': ok, ...errors(400, 401, 403, 404, 503) },
      },
    },
    '/api/consent': { post: { summary: 'Grant scoped DistroKid catalog-read consent', responses: { '201': ok, ...errors(400, 401, 403, 429) } } },
    '/api/consent/{id}/revoke': { post: { summary: 'Revoke consent and terminate associated Steel sessions', parameters: [pathId()], responses: { '200': ok, '202': { description: 'Consent is revoked; durable Steel cleanup remains pending' }, ...errors(401, 403, 404, 503) } } },
    '/api/connect': { post: { summary: 'Open an attended Steel DistroKid session', responses: { '200': ok, ...errors(400, 401, 403, 429, 502) } } },
    '/api/connect/{id}/scan': { post: { summary: 'Confirm login and enqueue the durable catalog pipeline', parameters: [pathId()], responses: { '200': ok, ...errors(401, 403, 404, 502) } } },
    '/api/connect/{id}/cancel': { post: { summary: 'Terminate an attended Steel session', parameters: [pathId()], responses: { '204': { description: 'Steel session terminated' }, ...errors(401, 403, 404, 502) } } },
    '/api/searches': {
      post: { summary: 'Create and enqueue a principal-owned catalog search', requestBody: json('CreateCatalogSearch'), responses: { '201': ok, ...errors(400, 401, 403, 502) } },
      get: {
        summary: 'List caller-owned catalog searches (or same-tenant searches for tenant admins)',
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
        'Audits authorized distributor catalogs against DSP catalogs. Production search data is scoped by tenant, OIDC subject, and artist workspace (with explicit same-tenant administrator access), and distributor login uses attended Steel sessions; passwords and Steel API credentials are never accepted by this API.',
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
          required: ['artistWorkspaceId', 'artist'],
          properties: {
            name: scanNameSchema(),
            artistWorkspaceId: { type: 'string', minLength: 1, maxLength: 255 },
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
        OrganizationMembershipUpdate: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'status'],
          properties: {
            role: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING'] },
            status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
          },
        },
        WorkspaceMembershipGrant: {
          type: 'object',
          additionalProperties: false,
          required: ['role'],
          properties: { role: { type: 'string', enum: ['OWNER', 'MANAGER', 'EDITOR', 'VIEWER'] } },
        },
        IssueOrganizationInvitation: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'organizationRole', 'workspaceGrants', 'expiresAt'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 320 },
            organizationRole: { type: 'string', enum: ['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR', 'BILLING'] },
            expiresAt: { type: 'string', format: 'date-time' },
            workspaceGrants: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['workspaceId', 'role'],
                properties: {
                  workspaceId: { type: 'string', minLength: 1, maxLength: 255 },
                  role: { type: 'string', enum: ['OWNER', 'MANAGER', 'EDITOR', 'VIEWER'] },
                },
              },
            },
          },
        },
        AcceptOrganizationInvitation: {
          type: 'object',
          additionalProperties: false,
          required: ['bearerToken'],
          properties: { bearerToken: { type: 'string', minLength: 1, maxLength: 512, writeOnly: true } },
        },
        RequestTenantErasure: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 } },
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
