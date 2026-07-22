import { describe, it, expect, vi } from 'vitest';
import type { BrowserContext, Request, Route } from 'playwright';
import { installReadOnlyGuard, shouldBlockRequest } from './read-only-guard';

describe('read-only guard — the "cannot edit/delete/add" guarantee', () => {
  it('never blocks read (GET/HEAD) requests', () => {
    expect(shouldBlockRequest('GET', 'https://distrokid.com/mymusic', true)).toBe(false);
    expect(shouldBlockRequest('GET', 'https://distrokid.com/api/release/delete', true)).toBe(false);
    expect(shouldBlockRequest('HEAD', 'https://distrokid.com/export', true)).toBe(false);
  });

  it('blocks mutation-shaped POST/PUT/PATCH/DELETE to catalog endpoints', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(shouldBlockRequest(m, 'https://distrokid.com/api/release/delete', true)).toBe(true);
      expect(shouldBlockRequest(m, 'https://distrokid.com/api/stores/add', true)).toBe(true);
      expect(shouldBlockRequest(m, 'https://distrokid.com/release/123/takedown', true)).toBe(true);
      expect(shouldBlockRequest(m, 'https://distrokid.com/release/update', true)).toBe(true);
    }
  });

  it('allows the user auth POST before extraction, blocks all mutations during extraction', () => {
    // During login (pre-extraction) an auth POST must succeed.
    expect(shouldBlockRequest('POST', 'https://distrokid.com/signin', false)).toBe(false);
    // A catalog mutation is blocked even before extraction.
    expect(shouldBlockRequest('POST', 'https://distrokid.com/release/delete', false)).toBe(true);
    // Once extracting, even auth-looking mutations are blocked (we never mutate).
    expect(shouldBlockRequest('POST', 'https://distrokid.com/auth/release/update', true)).toBe(true);
  });

  it('fails closed on opaque non-idempotent endpoints during extraction', () => {
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true)).toBe(true);
    expect(shouldBlockRequest('POST', 'https://api.audiomack.com/v1/search', true)).toBe(true);
    expect(shouldBlockRequest('PATCH', 'https://distrokid.com/api/action', true)).toBe(true);
  });

  it('allows only explicitly recognizable GraphQL reads, never mutations', () => {
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query: 'query Release { release { id } }' }))).toBe(false);
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ operationName: 'GetRelease' }))).toBe(true);
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query: 'mutation Delete { deleteRelease(id: 1) }' }))).toBe(true);
  });

  it('uses the selected operation and blocks multi-operation/query-smuggling bypasses', () => {
    const document = 'query Safe { release { id } } mutation Evil { deleteRelease(id: 1) }';
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query: document, operationName: 'Safe' }))).toBe(false);
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query: document, operationName: 'Evil' }))).toBe(true);
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query: document }))).toBe(true);
  });

  it('does not treat mutation-like text inside strings/comments as an operation', () => {
    const query = 'query Safe($text: String = "mutation Evil { x }") # mutation Nope { y }\n { search(q: $text) { id } }';
    expect(shouldBlockRequest('POST', 'https://distrokid.com/graphql', true, JSON.stringify({ query, operationName: 'Safe' }))).toBe(false);
  });

  it('removes its exact route handler once when disposed', async () => {
    const route = vi.fn(async (_pattern: string, _handler: unknown) => undefined);
    const unroute = vi.fn(async (_pattern: string, _handler: unknown) => undefined);
    const context = { route, unroute } as unknown as BrowserContext;
    const guard = await installReadOnlyGuard(context);

    expect(route).toHaveBeenCalledOnce();
    const handler = route.mock.calls[0]![1] as unknown as (route: Route, request: Request) => Promise<void>;
    await guard.dispose();
    await guard.dispose();

    expect(unroute).toHaveBeenCalledOnce();
    expect(unroute).toHaveBeenCalledWith('**/*', handler);
  });
});
