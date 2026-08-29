import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  AttendedDistroKidSession,
  DistroKidCatalogIndexError,
  distroKidCatalogIndexErrorCodeFromMessage,
  readDistroKidCatalogFromPage,
  readDistroKidCatalogIndexFromPage,
} from './distrokid-attended';

/**
 * Verifies the two-level DistroKid scraper (My Music list → each release detail page)
 * against the fixture pages that mirror DistroKid's structure. Proves it extracts EVERY
 * release and EVERY track's details (UPC, ISRC, release date, stores), not just titles.
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

    // Silent Waves deliberately omits its UPC and one track's ISRC, the scraper must
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
   * but "Loading…", the ISRC/UPC/artwork exist ONLY in the authenticated XHR response.
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
        // Renders no metadata, it only kicks off the async fetch, exactly like the real SPA.
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
    expect(r.upc).toBe('199751675992'); // from the JSON, the DOM never showed it
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

  it('reveals releases collapsed behind the "Show all releases" toggle and indexes every one', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // DistroKid shows the first 10 releases and hides the rest behind #show-all-btn (rows without
    // .release-row-show are display:none). All are real releases with distinct albumuuid hrefs, the
    // index must capture ALL of them, not just the 10 shown by default.
    const TOTAL = 15;
    const rows = Array.from({ length: TOTAL }, (_, i) => {
      const n = i + 1;
      const shown = i < 10 ? ' release-row-show' : '';
      return `<a class="tableRow release-row${shown}" href="/dashboard/album/?albumuuid=R${n}">Release ${n}</a>`;
    }).join('');
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><style>
        .release-row { display: none; }
        .release-row.release-row-show { display: flex; width: 120px; height: 20px; }
      </style></head><body><div class="releases-list">${rows}</div>
      <button id="show-all-btn" onclick="void 0">Show all releases</button></body></html>`,
    }));

    const refs = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      stabilityRounds: 3,
      maxScrollRounds: 20,
    });

    expect(refs).toHaveLength(TOTAL);
    const uuids = new Set(refs.map((r) => new URL(r.dashboardUrl).searchParams.get('albumuuid')));
    expect(uuids.size).toBe(TOTAL);
    await context.close();
  }, 30_000);

  it('collapses equivalent responsive renderings of one stable release', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: [
        '<div class="release-row" data-release-id="R1" data-track-count="2">',
        '<a class="release-link" href="/dashboard/album/?albumuuid=R1">One</a></div>',
        '<div class="release-row" data-release-id="R1" data-track-count="2">',
        '<a class="release-link" href="/mymusic/?albumuuid=R1">One</a>',
        '<span class="release-artist">Lewis KE</span></div>',
      ].join(''),
    }));

    const refs = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
    });

    expect(refs).toEqual([{
      releaseId: 'R1',
      dashboardUrl: 'https://distrokid.com/dashboard/album/?albumuuid=R1',
      title: 'One',
      artist: 'Lewis KE',
      expectedTrackCount: 2,
    }]);
    await context.close();
  }, 30_000);

  it('ignores hidden responsive rows instead of treating them as independent identities', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: [
        '<div class="release-row" data-release-id="R1">',
        '<a class="release-link" href="/album?albumuuid=shared">One</a></div>',
        '<div class="release-row" data-release-id="stale-responsive-copy" style="display:none">',
        '<a class="release-link" href="/album?albumuuid=shared">Hidden copy</a></div>',
      ].join(''),
    }));

    const refs = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
    });

    expect(refs).toEqual([{
      releaseId: 'R1',
      dashboardUrl: 'https://distrokid.com/album?albumuuid=shared',
      title: 'One',
    }]);
    await context.close();
  }, 30_000);

  it('retains an earlier total when virtualization removes the count element', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body>
        <ul id="releases" data-total-releases="3">
          <li class="release-row" data-release-id="R1"><a class="release-link" href="/album?id=R1">One</a></li>
        </ul>
        <button id="more">Load more releases</button>
        <script>
          document.querySelector('#more').addEventListener('click', function () {
            document.querySelector('#releases').removeAttribute('data-total-releases');
            document.querySelector('#releases').innerHTML =
              '<li class="release-row" data-release-id="R2"><a class="release-link" href="/album?id=R2">Two</a></li>';
            this.remove();
          });
        </script>
      `,
    }));

    const error = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      stabilityRounds: 2,
      maxScrollRounds: 5,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DistroKidCatalogIndexError);
    expect(error).toMatchObject({ code: 'LOAD_BUDGET_EXHAUSTED' });
    await context.close();
  }, 30_000);

  it('uses the strongest responsive total instead of the first counter in the DOM', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: [
        '<span data-total-releases="1">1 release</span>',
        '<span data-total-releases="2" style="display:none">2 releases</span>',
        '<div class="release-row" data-release-id="R1">',
        '<a class="release-link" href="/album?id=R1">One</a></div>',
      ].join(''),
    }));

    const error = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      maxScrollRounds: 5,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DistroKidCatalogIndexError);
    expect(error).toMatchObject({ code: 'LOAD_BUDGET_EXHAUSTED' });
    await context.close();
  }, 30_000);

  it('rejects a stable index whose unique row count exceeds the independent total', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: [
        '<div data-total-releases="2"></div>',
        ...[1, 2, 3].map((ordinal) => [
          `<div class="release-row" data-release-id="R${ordinal}">`,
          `<a class="release-link" href="/album?id=R${ordinal}">Release ${ordinal}</a></div>`,
        ].join('')),
      ].join(''),
    }));

    const error = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      stabilityRounds: 2,
      maxScrollRounds: 5,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(DistroKidCatalogIndexError);
    expect(error).toMatchObject({ code: 'RELEASE_IDENTITY_CONFLICT' });
    await context.close();
  }, 30_000);

  it('indexes more than one thousand incrementally loaded releases without truncation', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const releaseCount = 1_200;
    await page.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><body>
        <ul id="releases" data-total-releases="${releaseCount}"></ul>
        <button id="more">Load more releases</button>
        <script>
          let next = 1;
          const appendBatch = () => {
            const fragment = document.createDocumentFragment();
            for (let count = 0; count < 25 && next <= ${releaseCount}; count += 1, next += 1) {
              const row = document.createElement('li');
              row.className = 'release-row';
              row.dataset.releaseId = 'R' + next;
              row.innerHTML = '<a class="release-link" href="/album?id=R' + next + '">Release ' + next + '</a>';
              fragment.appendChild(row);
            }
            document.querySelector('#releases').appendChild(fragment);
            if (next > ${releaseCount}) document.querySelector('#more')?.remove();
          };
          document.querySelector('#more').addEventListener('click', appendBatch);
          appendBatch();
        </script>
      `,
    }));

    const refs = await readDistroKidCatalogIndexFromPage(page, {
      musicUrl: 'https://distrokid.com/mymusic',
      settleDelayMs: 25,
      maxScrollRounds: 75,
    });

    expect(refs).toHaveLength(releaseCount);
    expect(refs[0]?.releaseId).toBe('R1');
    expect(refs.at(-1)?.releaseId).toBe(`R${releaseCount}`);
    await context.close();
  }, 30_000);

  it('fails closed when rows have no stable identity or one URL maps to different release ids', async () => {
    const identitylessContext = await browser.newContext();
    const identitylessPage = await identitylessContext.newPage();
    await identitylessPage.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<div class="release-row" data-title="Same"><span class="release-artist">Artist</span></div><div class="release-row" data-title="Same"><span class="release-artist">Artist</span></div>',
    }));
    const identityError = await readDistroKidCatalogIndexFromPage(identitylessPage, {
      musicUrl: 'https://distrokid.com/mymusic', settleDelayMs: 25,
    }).catch((error: unknown) => error);
    expect(identityError).toBeInstanceOf(DistroKidCatalogIndexError);
    expect(identityError).toMatchObject({ code: 'RELEASE_IDENTITY_MISSING' });
    expect((identityError as Error).message).toMatch(/stable unique id or release URL/i);
    expect(distroKidCatalogIndexErrorCodeFromMessage((identityError as Error).message))
      .toBe('RELEASE_IDENTITY_MISSING');
    await identitylessContext.close();

    const duplicateContext = await browser.newContext();
    const duplicatePage = await duplicateContext.newPage();
    await duplicatePage.route('https://distrokid.com/mymusic', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<div class="release-row" data-release-id="R1"><a href="/album?albumuuid=shared">One</a></div><div class="release-row" data-release-id="R2"><a href="/album?albumuuid=shared">Two</a></div>',
    }));
    const conflictError = await readDistroKidCatalogIndexFromPage(duplicatePage, {
      musicUrl: 'https://distrokid.com/mymusic', settleDelayMs: 25,
    }).catch((error: unknown) => error);
    expect(conflictError).toBeInstanceOf(DistroKidCatalogIndexError);
    expect(conflictError).toMatchObject({ code: 'RELEASE_IDENTITY_CONFLICT' });
    expect((conflictError as Error).message).toMatch(/multiple stable release ids/i);
    expect(distroKidCatalogIndexErrorCodeFromMessage((conflictError as Error).message))
      .toBe('RELEASE_IDENTITY_CONFLICT');
    expect(distroKidCatalogIndexErrorCodeFromMessage(
      '[DISTROKID_CATALOG_INDEX:UNREVIEWED_CODE] arbitrary text',
    )).toBeNull();
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
