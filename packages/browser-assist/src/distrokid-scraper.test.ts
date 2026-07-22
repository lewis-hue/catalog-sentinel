import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  AttendedDistroKidSession,
  readDistroKidCatalogFromPage,
  readDistroKidCatalogIndexFromPage,
} from './distrokid-attended';

/**
 * Verifies the two-level DistroKid scraper (My Music list → each release detail page)
 * against the fixture pages that mirror DistroKid's structure. Proves it extracts EVERY
 * release and EVERY track's details (UPC, ISRC, release date, stores) — not just titles.
 * Uses a real Chromium so the in-page `page.evaluate` extraction is exercised for real.
 */
describe('readDistroKidCatalogFromPage', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => {
    await Promise.allSettled(browser?.contexts().map((context) => context.close()) ?? []);
    await browser?.close();
  }, 30_000);

  it('scrapes all releases + full per-track detail from the logged-in catalogue', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const musicUrl = pathToFileURL(resolve('fixtures/distrokid/catalog-index.html')).href;
    // file:// fixtures issue no XHR, so no catalog JSON exists → this exercises the DOM
    // FALLBACK path. Short network wait so we don't idle waiting for a response that can't come.
    const snap = await readDistroKidCatalogFromPage(page, 'Lewis KE Demo', { musicUrl, contentTimeoutMs: 1500 });

    expect(snap.releases.length).toBe(2);

    const lagos = snap.releases.find((r) => r.title === 'Lagos Nights');
    expect(lagos).toBeTruthy();
    expect(lagos!.upc).toBe('0888072100001');
    expect(lagos!.releaseDate).toBe('2023-04-01');
    expect(lagos!.uploadDate).toBe('2023-03-15');
    expect(lagos!.label).toBe('Lewis Music');
    expect(lagos!.primaryArtist).toBe('Lewis KE Demo');
    // Cover art is captured and upgraded to a high-res variant (300x300 → 1000x1000).
    expect(lagos!.artworkUrl).toBe('https://cdn.example.com/covers/lagos-1000x1000.jpg');
    // Every track on the release, with its ISRC.
    expect(lagos!.tracks.map((t) => t.title)).toEqual(['Lagos City Nights', 'Interlude']);
    expect(lagos!.tracks.map((t) => t.isrc)).toEqual(['USKE12310001', 'USKE12310002']);
    // Store selection is captured too.
    expect(lagos!.storeSelections.map((s) => s.platform)).toEqual(expect.arrayContaining(['spotify', 'apple-music', 'audiomack']));

    // Silent Waves deliberately omits its UPC and one track's ISRC — the scraper must
    // capture the release faithfully, including the gaps (not invent data).
    const silent = snap.releases.find((r) => r.title === 'Silent Waves');
    expect(silent).toBeTruthy();
    expect(silent!.upc).toBeNull();
    expect(silent!.tracks.map((t) => t.title)).toEqual(['Silent Skies', 'Alone Tonight']);
    expect(silent!.tracks[0]!.isrc).toBe('USKE12310003');
    expect(silent!.tracks[1]!.isrc).toBeNull();

    await context.close();
  }, 45000);

  /**
   * THE regression test for the architectural fix. A distributor SPA can finish loading while
   * the metadata JSON is still in flight, or never render it at all (component fails). Treating
   * DOM render as "data available" silently loses metadata. Here the album page renders NOTHING
   * but "Loading…" — the ISRC/UPC/artwork exist ONLY in the authenticated XHR response.
   * Extraction must still be complete.
   */
  it('NETWORK-FIRST: extracts full metadata from the JSON response when the DOM never renders it', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/mymusic')) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body><ul><li class="release-row" data-release-id="R1"><a class="release-link" href="https://distrokid.com/album?id=R1">Pesa</a></li></ul></body></html>',
        });
      }
      if (url.includes('/album?id=R1')) {
        // Renders no metadata — it only kicks off the async fetch, exactly like the real SPA.
        return route.fulfill({
          contentType: 'text/html',
          body: '<html><body><div id="app">Loading…</div><script>fetch("https://distrokid.com/api/release/R1")</script></body></html>',
        });
      }
      if (url.includes('/api/release/R1')) {
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: { release: { title: 'Pesa', upc: '199751675992', artworkUrl: 'https://cdn.example.com/c/250x250-a.jpg', releaseDate: '2025-11-07', label: 'Lewis Music', tracks: [{ title: 'Pesa', isrc: 'QT6ED2521965', trackNumber: 1 }] } },
          }),
        });
      }
      return route.fulfill({ status: 404, body: '' });
    });

    const snap = await readDistroKidCatalogFromPage(page, 'Lewis KE', { musicUrl: 'https://distrokid.com/mymusic', contentTimeoutMs: 10000 });
    const r = snap.releases[0]!;
    expect(r.upc).toBe('199751675992'); // from the JSON — the DOM never showed it
    expect(r.tracks[0]!.isrc).toBe('QT6ED2521965');
    expect(r.tracks[0]!.title).toBe('Pesa');
    expect(r.label).toBe('Lewis Music');
    expect(r.artworkUrl).toContain('1000x1000'); // captured + upgraded to high-res
    await context.close();
  }, 45000);
});

describe('readDistroKidCatalogIndexFromPage', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => {
    await Promise.allSettled(browser?.contexts().map((context) => context.close()) ?? []);
    await browser?.close();
  }, 30_000);

  it('reads release refs without ever navigating to a detail page', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requested: string[] = [];
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      requested.push(url);
      if (url.endsWith('/mymusic')) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<ul><li class="release-row" data-release-id="R1"><a class="release-link" href="/album?id=R1">One</a><span class="release-artist">Lewis KE</span></li><li class="release-row" data-release-id="R2"><a class="release-link" href="/album?id=R2">Two</a></li></ul>',
        });
      }
      return route.fulfill({ contentType: 'text/html', body: '<h1>DETAIL PAGE MUST NOT BE VISITED</h1>' });
    });

    const refs = await readDistroKidCatalogIndexFromPage(page, { musicUrl: 'https://distrokid.com/mymusic' });
    expect(refs).toEqual([
      { releaseId: 'R1', dashboardUrl: 'https://distrokid.com/album?id=R1', title: 'One', artist: 'Lewis KE' },
      { releaseId: 'R2', dashboardUrl: 'https://distrokid.com/album?id=R2', title: 'Two' },
    ]);
    expect(requested.filter((url) => url.includes('/album'))).toEqual([]);
    expect(page.url()).toBe('https://distrokid.com/mymusic');
    await context.close();
  }, 30_000);

  it('waits through delayed load-more work and accumulates virtualized rows', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body>
        <ul id="releases" data-total-releases="2">
          <li class="release-row" data-release-id="R1"><a class="release-link" href="/album?id=R1">One</a></li>
        </ul>
        <div id="busy" aria-busy="false" style="width:1px;height:1px"></div>
        <button id="more">Load more releases</button>
        <script>
          document.querySelector('#more').addEventListener('click', function () {
            this.disabled = true;
            document.querySelector('#busy').setAttribute('aria-busy', 'true');
            setTimeout(function () {
              document.querySelector('#releases').innerHTML = '<li class="release-row" data-release-id="R2"><a class="release-link" href="/album?id=R2">Two</a></li>';
              document.querySelector('#busy').setAttribute('aria-busy', 'false');
              document.querySelector('#more').remove();
            }, 90);
          });
        </script>
      `,
    }));

    const refs = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      stabilityRounds: 3,
      maxScrollRounds: 20,
    });

    expect(refs.map((ref) => ref.releaseId)).toEqual(['R1', 'R2']);
    await context.close();
  }, 30_000);

  it('fails closed when rows have no stable identity or duplicate a stable release id', async () => {
    const identitylessContext = await browser.newContext();
    const identitylessPage = await identitylessContext.newPage();
    await identitylessPage.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<div class="release-row" data-title="Same"><span class="release-artist">Artist</span></div><div class="release-row" data-title="Same"><span class="release-artist">Artist</span></div>',
    }));
    await expect(readDistroKidCatalogIndexFromPage(identitylessPage, {
      musicUrl: 'https://distrokid.com/mymusic', settleDelayMs: 25,
    })).rejects.toThrow(/stable unique id or release URL/i);
    await identitylessContext.close();

    const duplicateContext = await browser.newContext();
    const duplicatePage = await duplicateContext.newPage();
    await duplicatePage.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<div class="release-row" data-release-id="R1"><a href="/album?a">One</a></div><div class="release-row" data-release-id="R1"><a href="/album?b">Two</a></div>',
    }));
    await expect(readDistroKidCatalogIndexFromPage(duplicatePage, {
      musicUrl: 'https://distrokid.com/mymusic', settleDelayMs: 25,
    })).rejects.toThrow(/duplicate stable release identities/i);
    await duplicateContext.close();
  }, 30_000);

  it('rejects the legacy local attended browser outside an explicit test path', async () => {
    const session = new AttendedDistroKidSession({
      allowLocalBrowserForTests: true,
      runtimeEnv: { NODE_ENV: 'production' },
    });
    await expect(session.start()).rejects.toThrow(/Steel session/i);
  });
});
