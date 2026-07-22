import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { installDistributorNetworkDiscovery, InMemoryCandidateSink } from './network-discovery';
import { ParserRegistry } from './parser-registry';
import { NetworkFirstExtractor } from './extractor';
import { inferRole } from './endpoint-bundle';

/**
 * Integration tests against a REAL Chromium with a routed fake distributor.
 *
 * These encode the architectural contract: the metadata is the JSON RESPONSE, not the DOM.
 * A page that renders nothing (or renders late, or fails to render) must still extract fully.
 */

const ORIGIN = 'distrokid.com';
const RELEASE_JSON = {
  data: { release: { id: 'R1', title: 'Pesa', upc: '199751675992', artworkUrl: 'https://cdn.example.com/c/1000x1000-a.jpg', releaseDate: '2025-11-07', label: 'Lewis Music', tracks: [{ id: 'T1', title: 'Pesa', isrc: 'QT6ED2521965', trackNumber: 1 }] } },
};

async function routeFakeDistroKid(page: Page, opts: { renderDom?: boolean; delayMs?: number; splitEndpoints?: boolean; serviceWorker?: boolean } = {}): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/dashboard/album')) {
      const body = opts.splitEndpoints
        ? `<html><body><div id="app">Loading…</div><script>
             fetch('https://distrokid.com/api/release/R1');
             fetch('https://distrokid.com/api/release/R1/isrcs');
           </script></body></html>`
        : `<html><body><div id="app">${opts.renderDom ? 'UPC 199751675992 ISRC QT6ED2521965' : 'Loading…'}</div><script>
             setTimeout(function(){ fetch('https://distrokid.com/api/release/R1'); }, ${opts.delayMs ?? 0});
           </script></body></html>`;
      return route.fulfill({ contentType: 'text/html', body });
    }
    if (url.endsWith('/api/release/R1')) {
      const payload = opts.splitEndpoints
        ? { release: { id: 'R1', title: 'Pesa', upc: '199751675992', artworkUrl: 'https://cdn.example.com/c/1000x1000-a.jpg', tracks: [{ id: 'T1', title: 'Pesa', trackNumber: 1 }] } }
        : RELEASE_JSON;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (url.endsWith('/api/release/R1/isrcs')) {
      // A SECOND endpoint that carries only the identifiers (an endpoint bundle).
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tracks: [{ id: 'T1', title: 'Pesa', isrc: 'QT6ED2521965', trackNumber: 1 }] }) });
    }
    if (url.includes('/api/analytics') || url.includes('/api/flags')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ event: 'pageview', featureFlags: { a: 1 } }) });
    }
    if (url.includes('/bank/') || url.includes('/api/profile')) {
      // Sensitive route — must never be inspected.
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ iban: 'GB33BUKB20201555555555', email: 'a@b.com', isrc: 'FAKE12345678' }) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
}

const mkExtractor = (page: Page, sink?: InMemoryCandidateSink) =>
  new NetworkFirstExtractor(
    page,
    { origin: ORIGIN, distributor: 'DISTROKID', responseTimeoutMs: 8000, gotoTimeoutMs: 15000, ...(sink ? { candidateSink: sink } : {}) },
    { parsers: new ParserRegistry() },
  );

describe('network-first extraction (real browser)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => {
    await Promise.allSettled(browser?.contexts().map((context) => context.close()) ?? []);
    await browser?.close();
  }, 30_000);

  it('extracts full metadata when the DOM renders NOTHING', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { renderDom: false });
    const ex = mkExtractor(page);
    await ex.install();
    const out = await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });
    expect(out.kind).toBe('COMPLETED');
    if (out.kind === 'COMPLETED') {
      expect(out.source).toBe('NETWORK_JSON');
      expect(out.release.upc.value).toBe('199751675992');
      expect(out.release.tracks[0]!.isrc.value).toBe('QT6ED2521965');
      expect(out.release.artworkUrl.value).toContain('1000x1000');
    }
    await ex.dispose();
    await page.close();
  }, 30000);

  it('fails retryably when an independent index count proves that track extraction was truncated', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { renderDom: false });
    const ex = mkExtractor(page);
    await ex.install();
    const out = await ex.extractRelease({
      releaseId: 'R1',
      dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1',
      expectedTrackCount: 2,
    });
    expect(out).toMatchObject({ kind: 'FAILED', reason: 'PARSE_FAILED' });
    await ex.dispose();
    await page.close();
  }, 30000);

  it('a DELAYED SPA component does not affect extraction (we wait on the response)', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { renderDom: false, delayMs: 1200 });
    const ex = mkExtractor(page);
    await ex.install();
    const out = await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });
    expect(out.kind).toBe('COMPLETED');
    if (out.kind === 'COMPLETED') expect(out.release.tracks[0]!.isrc.value).toBe('QT6ED2521965');
    await ex.dispose();
    await page.close();
  }, 30000);

  it('merges an endpoint BUNDLE: release details + a separate identifiers endpoint', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { splitEndpoints: true });
    const ex = mkExtractor(page);
    await ex.install();
    const out = await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });
    expect(out.kind).toBe('COMPLETED');
    if (out.kind === 'COMPLETED') {
      expect(out.release.upc.value).toBe('199751675992'); // from the details endpoint
      expect(out.release.tracks[0]!.isrc.value).toBe('QT6ED2521965'); // backfilled from the identifiers endpoint
    }
    await ex.dispose();
    await page.close();
  }, 30000);

  it('records ranked, SANITIZED candidates and ignores analytics + sensitive routes', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { renderDom: false });
    const sink = new InMemoryCandidateSink();
    const ex = mkExtractor(page, sink);
    await ex.install();
    // Touch an analytics endpoint and a sensitive one alongside the real read.
    await page.goto('https://distrokid.com/dashboard/album/?albumuuid=R1', { waitUntil: 'commit' }).catch(() => undefined);
    await page.evaluate(() => { void fetch('/api/analytics'); void fetch('/bank/details'); }).catch(() => undefined);
    await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });

    const report = ex.report();
    expect(report.length).toBeGreaterThan(0);
    const top = report[0]!;
    expect(top.descriptor).toContain('distrokid.com/api/release');
    expect(top.hasStrongSignal).toBe(true);
    // The sensitive route is never inspected, even though its body contained an ISRC-looking value.
    expect(report.some((c) => c.descriptor.includes('/bank/'))).toBe(false);
    // Analytics scores 0 → never recorded as a candidate.
    expect(report.some((c) => c.descriptor.includes('/api/analytics'))).toBe(false);
    // Nothing sensitive leaked into the sink.
    const dump = JSON.stringify(sink.candidates);
    expect(dump).not.toContain('GB33BUKB');
    expect(dump).not.toContain('a@b.com');
    expect(dump).not.toContain('199751675992'); // values are never stored
    await ex.dispose();
    await page.close();
  }, 30000);

  it('infers roles for a bundle from observed schema shapes', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { splitEndpoints: true });
    const sink = new InMemoryCandidateSink();
    const ex = mkExtractor(page, sink);
    await ex.install();
    await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });
    const roles = ex.report().map((c) => inferRole(c));
    expect(roles).toContain('releaseDetails');
    await ex.dispose();
    await page.close();
  }, 30000);

  it('falls back to the DOM only when no catalog JSON is served', async () => {
    const page = await (await browser.newContext()).newPage();
    // No JSON endpoint at all — the DOM carries the data.
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.includes('/dashboard/album')) return route.fulfill({ contentType: 'text/html', body: '<html><body>UPC 199751675992 · ISRC QT6ED2521965</body></html>' });
      return route.fulfill({ status: 404, body: '' });
    });
    const ex = new NetworkFirstExtractor(
      page,
      {
        origin: ORIGIN, distributor: 'DISTROKID', responseTimeoutMs: 1200, gotoTimeoutMs: 15000,
        // Tier 5 fallback supplied by the caller.
        readDom: async (p) => {
          const text = await p.evaluate(() => document.body.innerText);
          const upc = /\b(\d{12,13})\b/.exec(text)?.[1];
          const isrc = /\b([A-Z]{2}[A-Z0-9]{3}\d{7})\b/.exec(text)?.[1];
          if (!upc && !isrc) return null;
          const now = new Date().toISOString();
          return {
            distributorReleaseId: 'R1', title: 'Pesa',
            upc: upc ? { value: upc, status: 'PRESENT', source: 'DOM', capturedAt: now, parserVersion: 'dom' } : { status: 'ABSENT_AT_SOURCE', source: 'DOM', capturedAt: now, parserVersion: 'dom' },
            artworkUrl: { status: 'ABSENT_AT_SOURCE', source: 'DOM', capturedAt: now, parserVersion: 'dom' },
            releaseDate: { status: 'ABSENT_AT_SOURCE', source: 'DOM', capturedAt: now, parserVersion: 'dom' },
            tracks: isrc ? [{ title: 'Pesa', isrc: { value: isrc, status: 'PRESENT', source: 'DOM', capturedAt: now, parserVersion: 'dom' } }] : [],
          };
        },
      },
      { parsers: new ParserRegistry() },
    );
    await ex.install();
    const out = await ex.extractRelease({ releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' });
    expect(out.kind).toBe('COMPLETED');
    if (out.kind === 'COMPLETED') {
      expect(out.source).toBe('DOM'); // only because no JSON existed
      expect(out.release.upc.value).toBe('199751675992');
    }
    await ex.dispose();
    await page.close();
  }, 30000);

  it('returns a TERMINAL failure (never a silent skip) when nothing yields data', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.route('**/*', async (route) => route.fulfill({ contentType: 'text/html', body: '<html><body>Loading…</body></html>' }));
    const ex = new NetworkFirstExtractor(page, { origin: ORIGIN, distributor: 'DISTROKID', responseTimeoutMs: 800, gotoTimeoutMs: 15000 }, { parsers: new ParserRegistry() });
    await ex.install();
    const out = await ex.extractRelease({ releaseId: 'R9', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R9' });
    expect(out.kind).toBe('FAILED');
    if (out.kind === 'FAILED') {
      expect(out.reason).toBe('TIMEOUT');
      expect(out.distributorReleaseId).toBe('R9'); // still accounted for
    }
    await ex.dispose();
    await page.close();
  }, 30000);

  it('discovery mode samples releases and ranks candidates automatically', async () => {
    const page = await (await browser.newContext()).newPage();
    await routeFakeDistroKid(page, { renderDom: false });
    const ex = mkExtractor(page);
    await ex.install();
    const res = await ex.discover([
      { releaseId: 'R1', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' },
      { releaseId: 'R1b', dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1' },
    ]);
    expect(res.sampled).toBe(2);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates[0]!.hasStrongSignal).toBe(true);
    expect(res.candidates[0]!.descriptor).toContain('distrokid.com');
    await ex.dispose();
    await page.close();
  }, 30000);
});
