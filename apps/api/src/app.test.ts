import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { openApiDocument } from './openapi';
import { createAppTestServices } from './app.test-support';

describe('Sentinel API (in-process inject)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp(createAppTestServices());
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /openapi.json returns only the active authenticated API', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/connect']).toBeDefined();
    expect(doc.paths['/api/scans']).toBeUndefined();
  });

  it('publishes only the active authenticated surface in the production OpenAPI view', () => {
    const doc = openApiDocument('https://sentinel.example', { production: true }) as {
      paths: Record<string, {
        post?: { summary?: string; description?: string; responses?: Record<string, unknown> };
        get?: { parameters?: Array<{ name?: string }>; responses?: Record<string, { headers?: Record<string, unknown> }> };
        patch?: { responses?: Record<string, unknown> };
        delete?: { responses?: Record<string, unknown> };
      }>;
    };
    expect(doc.paths['/api/connect']).toBeTruthy();
    expect(doc.paths['/api/consent']).toBeTruthy();
    expect(doc.paths['/api/demo/seed']).toBeUndefined();
    expect(doc.paths['/api/live-scan']).toBeUndefined();
    expect(doc.paths['/api/connect']?.post?.responses?.['200']).toBeTruthy();
    expect(doc.paths['/api/connect/{id}/scan']?.post?.responses?.['200']).toBeTruthy();
    expect(doc.paths['/api/connect/{id}/cancel']?.post?.responses?.['204']).toBeTruthy();
    expect(doc.paths['/api/searches']?.post?.responses?.['201']).toBeTruthy();
    expect(doc.paths['/api/searches']?.get?.parameters?.map((parameter) => parameter.name)).toEqual(['limit', 'cursor']);
    expect(doc.paths['/api/searches']?.get?.responses?.['200']?.headers?.['X-Sentinel-Next-Cursor']).toBeTruthy();
    expect(doc.paths['/api/searches/{id}']?.patch?.responses?.['200']).toBeTruthy();
    expect(doc.paths['/api/searches/{id}']?.delete?.responses?.['409']).toBeTruthy();
    expect(doc.paths['/api/searches/{id}/rescan']?.post?.responses?.['201']).toBeTruthy();
    expect(doc.paths['/api/searches/{id}/rescan']?.post?.summary).toMatch(/saved distributor snapshot/i);
    expect(doc.paths['/api/searches/{id}/rescan']?.post?.description).toMatch(/does not re-extract/i);
    expect(doc.paths['/api/distributor-imports/csv']?.post?.responses?.['200']).toBeTruthy();
    expect(doc.paths['/api/organization/members']?.get?.responses?.['200']).toBeTruthy();
    expect(doc.paths['/api/organization/invitations']?.post?.responses?.['201']).toBeTruthy();
    expect(doc.paths['/api/organization/invitations/accept']?.post?.responses?.['403']).toBeTruthy();
    expect(doc.paths['/api/organization/workspaces/{workspaceId}/members/{subjectId}']?.delete?.responses?.['409']).toBeTruthy();
  });

  it('applies security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('removed legacy routes stay absent and cannot be reached through percent encoding', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const direct = await app.inject({ method: 'GET', url: '/api/legacy-login/test-session' });
      const encoded = await app.inject({ method: 'GET', url: '/api/%6cegacy-login/test-session' });
      const previouslyMissed = await app.inject({ method: 'GET', url: '/api/catalog-scan?artist=test' });
      const browserLink = await app.inject({ method: 'POST', url: '/api/browser-link/sessions', payload: {} });
      const encodedBrowserLink = await app.inject({ method: 'POST', url: '/api/%62rowser-link/sessions', payload: {} });
      const demoSeed = await app.inject({ method: 'POST', url: '/api/demo/seed' });
      const workspaceCreate = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name: 'Hidden' } });
      const workspaceRead = await app.inject({ method: 'GET', url: '/api/workspaces/ws_lewis_ke_demo' });
      const workspaceDelete = await app.inject({ method: 'DELETE', url: '/api/workspaces/ws_lewis_ke_demo' });
      const catalogTracks = await app.inject({ method: 'GET', url: '/api/catalog/tracks?workspaceId=ws_lewis_ke_demo' });
      expect(direct.statusCode).toBe(404);
      expect(encoded.statusCode).toBe(404);
      expect(previouslyMissed.statusCode).toBe(404);
      expect(browserLink.statusCode).toBe(404);
      expect(encodedBrowserLink.statusCode).toBe(404);
      expect(demoSeed.statusCode).toBe(404);
      expect(workspaceCreate.statusCode).toBe(404);
      expect(workspaceRead.statusCode).toBe(404);
      expect(workspaceDelete.statusCode).toBe(404);
      expect(catalogTracks.statusCode).toBe(404);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
