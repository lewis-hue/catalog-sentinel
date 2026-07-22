import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { BrowserContext, Response } from 'playwright';
import { installDistributorNetworkDiscovery } from './network-discovery';

function responseFor(releaseId: string, finished: Promise<unknown>): Response {
  const payload = Buffer.from(JSON.stringify({ release: { id: releaseId, title: releaseId, upc: '123456789012', tracks: [{ title: 'Song', isrc: 'USABC1200001' }] } }));
  const request = {
    resourceType: () => 'xhr',
    postData: () => null,
    method: () => 'GET',
  };
  return {
    request: () => request,
    status: () => 200,
    url: () => `https://distrokid.com/api/release/${releaseId}`,
    headers: () => ({ 'content-type': 'application/json', 'content-length': String(payload.length) }),
    finished: async () => { await finished; return null; },
    body: async () => payload,
  } as unknown as Response;
}

describe('network discovery release-window fencing', () => {
  it('does not attribute a late response from release A to release B', async () => {
    const context = new EventEmitter() as unknown as BrowserContext;
    const handle = installDistributorNetworkDiscovery(context, {
      origin: 'distrokid.com', knownReleaseIds: new Set(['A', 'B']),
    });

    let finishA!: () => void;
    const delayedA = new Promise<void>((resolve) => { finishA = resolve; });
    handle.setCurrentRelease('A');
    handle.resetCaptures();
    (context as unknown as EventEmitter).emit('response', responseFor('A', delayedA));

    handle.setCurrentRelease('B');
    handle.resetCaptures();
    finishA();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handle.all()).toEqual([]);

    (context as unknown as EventEmitter).emit('response', responseFor('B', Promise.resolve()));
    const hit = await handle.waitForCatalogResponse(500);
    expect(hit?.releaseId).toBe('B');
    expect(hit?.correlation).toBe('REQUEST_ID_MATCH');
    handle.dispose();
  });
});
