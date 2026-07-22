import type { DistributorProvider } from '@sentinel/core';
import {
  GenericCsvDistributorAdapter,
  type CatalogDiscoveryInput,
  type DistributorAdapter,
  type DistributorCapabilities,
  type DistributorCatalogSnapshot,
  type RawDistributorRelease,
} from '@sentinel/adapters';
import type { Page } from 'playwright';
import { BrowserSession } from './session';
import { installDistributorNetworkDiscovery, type CandidateSink, type CandidateScope, type DiscoveryHandle } from './distrokid/network-discovery';
import { ParserRegistry } from './distrokid/parser-registry';
import { MIN_CATALOG_SCORE } from './distrokid/candidate-scoring';
import type { CanonicalDistributorRelease } from './distrokid/metadata-model';

const CAPABILITIES: DistributorCapabilities = {
  supportsOfficialApi: false,
  supportsCsvImport: true,
  supportsUserExport: true,
  supportsAttendedBrowserAssist: true,
  supportsLyricsStatus: false,
  supportsStoreSelectionStatus: true,
  supportsCreditsStatus: false,
  supportsRoyaltyReports: false,
  supportsSplits: false,
};

const ISRC_RE = /\b[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}\b/;

export interface AttendedDistroKidOptions {
  executablePath?: string;
  /** URLs (all GET/read) — override if DistroKid changes its paths. */
  signInUrl?: string;
  musicUrl?: string;
  /** Text patterns for the read-only export/download control, if present. */
  exportControlText?: RegExp;
  nowIso?: () => string;
  onEvent?: (event: AttendedEvent) => void;
  /** Legacy local Chromium is test-only; production attended login is always Steel. */
  allowLocalBrowserForTests?: boolean;
  /** Injectable so the production guard is deterministic in tests. */
  runtimeEnv?: Readonly<Record<string, string | undefined>>;
}

export type AttendedEvent =
  | { type: 'launched' }
  | { type: 'awaiting-login'; url: string }
  | { type: 'authenticated' }
  | { type: 'extracting' }
  | { type: 'extracted'; releases: number; tracks: number }
  | { type: 'blocked-mutation'; url: string };

/**
 * Read the DistroKid catalogue from an ALREADY-AUTHENTICATED Playwright page supplied by
 * Steel (or by an explicit test fixture). Read-only:
 * navigate to the music page, load the full list, and extract release/track rows.
 */
/** Raw shape scraped from a single release detail page (browser-serializable). */
export interface ScrapedReleaseDetail {
  title: string | null;
  primaryArtist: string | null;
  upc: string | null;
  releaseDate: string | null;
  uploadDate: string | null;
  label: string | null;
  artworkUrl: string | null;
  stores: Array<{ store: string; status: string }>;
  tracks: Array<{ title: string; isrc: string | null; trackNumber: number | null; plainLyrics: string | null; syncedLyrics: string | null; credits: string | null; featured: string[] }>;
}

/** esbuild/tsx compile our `page.evaluate` callbacks with `keepNames`, wrapping helpers in a
 *  `__name(...)` call absent from the browser. Inject this no-op shim (string, not a function —
 *  a function would itself be transpiled) into every tab before it evaluates. */
const ESBUILD_NAME_SHIM =
  'globalThis.__name=globalThis.__name||function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};';

export interface DistroKidCatalogIndexEntry {
  releaseId: string;
  dashboardUrl: string;
  title: string;
  artist?: string;
  /** Independently displayed list-level count. Omitted when the index does not expose one. */
  expectedTrackCount?: number;
}

interface RawCatalogIndexEntry {
  href: string | null;
  title: string;
  artist: string | null;
  id: string | null;
  expectedTrackCount: number | null;
}

async function readVisibleCatalogIndexEntries(page: Page): Promise<RawCatalogIndexEntry[]> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
    const out: Array<{ href: string | null; title: string; artist: string | null; id: string | null; expectedTrackCount: number | null }> = [];
    const trackCount = (element: Element): number | null => {
      const countNode = element.querySelector('[data-track-count], [data-song-count], [data-field="track-count"], .track-count, .song-count');
      const raw = element.getAttribute('data-track-count')
        ?? element.getAttribute('data-song-count')
        ?? countNode?.getAttribute('data-track-count')
        ?? countNode?.getAttribute('data-song-count')
        ?? countNode?.textContent
        ?? '';
      const match = /^\s*([\d,]+)\s*(?:tracks?|songs?)?\s*$/i.exec(raw);
      const parsed = match?.[1] ? Number.parseInt(match[1].replace(/,/g, ''), 10) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    };
    const push = (href: string | null, title: string, artist: string | null, id: string | null, expectedTrackCount: number | null) => {
      if (!title) return;
      out.push({ href, title, artist, id, expectedTrackCount });
    };
    document.querySelectorAll('.release-row, li[data-release-id], [data-release], tr[data-release-id]').forEach((el) => {
      const a = el.querySelector('a.release-link, a[href*="/album/"], a[href*="/release/"], a[href*="/mymusic/"], a[href]') as HTMLAnchorElement | null;
      const title = clean(el.querySelector('.release-link, [data-field="release-title"], a')?.textContent) || clean((el as HTMLElement).getAttribute('data-title'));
      push(
        a?.getAttribute('href') ?? null,
        title,
        clean(el.querySelector('.release-artist, [data-field="release-artist"]')?.textContent) || null,
        (el as HTMLElement).getAttribute('data-release-id'),
        trackCount(el),
      );
    });
    if (out.length === 0) {
      document.querySelectorAll('a[href*="/album/"], a[href*="/release/"], a.release-link').forEach((a) => {
        const el = a as HTMLAnchorElement;
        push(el.getAttribute('href'), clean(el.textContent), null, null, null);
      });
    }
    return out;
  });
}

async function readCatalogLoadState(page: Page): Promise<{ height: number; pending: boolean; expectedTotal: number | null }> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const pending = Array.from(document.querySelectorAll(
      '[aria-busy="true"], [data-loading="true"], [data-state="loading"], .loading, .spinner',
    )).some(visible);

    let expectedTotal: number | null = null;
    for (const element of document.querySelectorAll('[data-total-releases], [data-release-count]')) {
      const raw = element.getAttribute('data-total-releases') ?? element.getAttribute('data-release-count') ?? '';
      const parsed = Number.parseInt(raw.replace(/,/g, ''), 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        expectedTotal = parsed;
        break;
      }
    }
    if (expectedTotal === null) {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      const patterns = [
        /showing\s+[\d,]+(?:\s*(?:-|\u2013)\s*[\d,]+)?\s+(?:of|\/)\s+([\d,]+)\s+releases?\b/i,
        /\b([\d,]+)\s+releases?\s+(?:in\s+total|total)\b/i,
        /\btotal\s+releases?\s*:?\s*([\d,]+)\b/i,
      ];
      for (const pattern of patterns) {
        const match = pattern.exec(text);
        const parsed = match?.[1] ? Number.parseInt(match[1].replace(/,/g, ''), 10) : Number.NaN;
        if (Number.isSafeInteger(parsed) && parsed >= 0) {
          expectedTotal = parsed;
          break;
        }
      }
    }
    return { height: document.body.scrollHeight, pending, expectedTotal };
  });
}

async function clickCatalogLoadMore(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll(
      '[data-testid*="load-more" i], [data-action*="load-more" i], button, a[role="button"]',
    ));
    const control = candidates.find((element) => {
      const node = element as HTMLElement;
      const text = (node.innerText || node.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const disabled = (node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true';
      return !disabled && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0 &&
        /^(?:load|show|view)\s+more(?:\s+releases?)?$/i.test(text);
    }) as HTMLElement | undefined;
    if (!control) return false;
    control.click();
    return true;
  });
}

/**
 * Read only the DistroKid "My Music" index. This function never follows a release
 * link; release detail navigation belongs exclusively to chunk extraction.
 */
export async function readDistroKidCatalogIndexFromPage(
  page: Page,
  opts: {
    musicUrl?: string;
    maxReleases?: number;
    maxScrollRounds?: number;
    stabilityRounds?: number;
    settleDelayMs?: number;
  } = {},
): Promise<DistroKidCatalogIndexEntry[]> {
  const musicUrl = opts.musicUrl ?? 'https://distrokid.com/mymusic';
  const target = new URL(musicUrl);
  if (target.protocol !== 'https:' || !(target.hostname === 'distrokid.com' || target.hostname.endsWith('.distrokid.com'))) {
    throw new Error('DistroKid catalog index URL must use HTTPS on a distrokid.com host.');
  }
  await page.addInitScript({ content: ESBUILD_NAME_SHIM }).catch(() => undefined);
  await page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const landed = new URL(page.url());
  if (!(landed.hostname === 'distrokid.com' || landed.hostname.endsWith('.distrokid.com')) || /\b(sign[-_]?in|login)\b/i.test(landed.pathname)) {
    throw new Error('DistroKid authentication is required before reading the catalog index.');
  }

  const maxReleases = opts.maxReleases ?? 5000;
  const maxScrollRounds = Math.max(1, Math.min(opts.maxScrollRounds ?? 80, 200));
  const requiredStableRounds = Math.max(2, Math.min(opts.stabilityRounds ?? 3, 10));
  const settleDelayMs = Math.max(25, Math.min(opts.settleDelayMs ?? 700, 5000));
  if (!Number.isSafeInteger(maxReleases) || maxReleases < 1) {
    throw new Error('DistroKid catalog maxReleases must be a positive integer.');
  }

  const rows = new Map<string, RawCatalogIndexEntry>();
  const mergeVisibleRows = async () => {
    let added = 0;
    const visibleKeys = new Set<string>();
    for (const rawRow of await readVisibleCatalogIndexEntries(page)) {
      const row = {
        ...rawRow,
        id: rawRow.id?.trim() || null,
        href: rawRow.href?.trim() || null,
      };
      if (!row.id && !row.href) {
        throw new Error('DistroKid catalog row has no stable unique id or release URL; completeness cannot be established.');
      }
      const key = row.id ? `id:${row.id}` : `href:${new URL(row.href!, musicUrl).toString()}`;
      if (visibleKeys.has(key)) {
        throw new Error('DistroKid catalog index contains duplicate stable release identities; completeness cannot be established.');
      }
      visibleKeys.add(key);
      if (!rows.has(key)) {
        rows.set(key, row);
        added += 1;
      }
    }
    return added;
  };

  await mergeVisibleRows();
  let previous = await readCatalogLoadState(page);
  let stableRounds = 0;
  let indexStabilized = false;
  for (let round = 0; round < maxScrollRounds; round += 1) {
    if (rows.size >= maxReleases) {
      throw new Error(`DistroKid catalog index reached the configured ${maxReleases}-release cap; refusing to report a potentially truncated catalog.`);
    }
    const clickedLoadMore = await clickCatalogLoadMore(page).catch(() => false);
    await page.mouse.wheel(0, 6000).catch(() => undefined);
    await page.waitForTimeout(settleDelayMs);
    const added = await mergeVisibleRows();
    const current = await readCatalogLoadState(page);
    const countSatisfied = current.expectedTotal === null || rows.size >= current.expectedTotal;
    const stable = !clickedLoadMore && !current.pending && added === 0 && current.height === previous.height;
    stableRounds = stable ? stableRounds + 1 : 0;
    if (stableRounds >= requiredStableRounds && countSatisfied) {
      indexStabilized = true;
      break;
    }
    previous = current;
  }
  if (!indexStabilized) {
    const state = await readCatalogLoadState(page).catch(() => ({ expectedTotal: null }));
    const expected = state.expectedTotal === null ? 'unknown' : String(state.expectedTotal);
    throw new Error(`DistroKid catalog index did not establish completeness before the load budget (captured=${rows.size}, expected=${expected}).`);
  }

  const finalUrl = new URL(page.url());
  if (!(finalUrl.hostname === 'distrokid.com' || finalUrl.hostname.endsWith('.distrokid.com')) || /\b(sign[-_]?in|login)\b/i.test(finalUrl.pathname)) {
    throw new Error('DistroKid authentication expired while reading the catalog index.');
  }
  if (rows.size === 0) {
    throw new Error('DistroKid returned no recognizable release rows; refusing to treat an unauthenticated, changed, or incomplete page as an empty catalog.');
  }
  if (rows.size >= maxReleases) {
    throw new Error(`DistroKid catalog index reached the configured ${maxReleases}-release cap; refusing to report a potentially truncated catalog.`);
  }
  const entries: DistroKidCatalogIndexEntry[] = [];
  const releaseIds = new Set<string>();
  for (const row of rows.values()) {
    const dashboardUrl = row.href ? new URL(row.href, musicUrl).toString() : musicUrl;
    const dashboard = new URL(dashboardUrl);
    if (dashboard.protocol !== 'https:' || dashboard.username || dashboard.password ||
        (dashboard.port && dashboard.port !== '443') ||
        !(dashboard.hostname === 'distrokid.com' || dashboard.hostname.endsWith('.distrokid.com'))) {
      throw new Error('DistroKid catalog index returned an unsafe release URL.');
    }
    const releaseId = row.id || dashboardUrl;
    if (releaseIds.has(releaseId)) {
      throw new Error('DistroKid catalog index resolved multiple rows to the same release identity; completeness cannot be established.');
    }
    releaseIds.add(releaseId);
    entries.push({
      releaseId,
      dashboardUrl,
      title: row.title,
      ...(row.artist ? { artist: row.artist } : {}),
      ...(row.expectedTrackCount !== null ? { expectedTrackCount: row.expectedTrackCount } : {}),
    });
  }
  return entries;
}

export async function readDistroKidCatalogFromPage(
  page: Page,
  artistName?: string,
  opts: {
    musicUrl?: string;
    nowIso?: () => string;
    /** Max releases to visit. Default 5000 — supports very large catalogues (1000+ songs). */
    maxReleases?: number;
    /** Overall budget for visiting release detail pages; when exceeded we stop and return
     *  what we have (with list-level info for the rest). Keeps a huge/slow catalogue bounded. */
    maxDurationMs?: number;
    /** How many release detail pages to read in parallel (pool of tabs on the same session).
     *  Keep LOW — the DistroKid dashboard is a heavy SPA; too many concurrent tabs starve each
     *  other and time out. Default 2. */
    concurrency?: number;
    /** Per-page navigation timeout (ms). Default 30s (with 'commit' this is just the response). */
    gotoTimeoutMs?: number;
    /** Playwright navigation wait condition. Default 'commit' (see contentTimeoutMs). */
    waitUntil?: 'load' | 'domcontentloaded' | 'commit' | 'networkidle';
    /** After navigation, how long to wait for the release DATA (UPC/ISRC) to render. Default 20s. */
    contentTimeoutMs?: number;
    /** Called after each release detail is read, for progress logging. */
    onProgress?: (done: number, total: number) => void;
    /** Extraction diagnostics: which source served the metadata, and the SANITIZED endpoint
     *  descriptors that carried catalog JSON (no values/secrets) — for endpoint discovery. */
    onDiagnostics?: (d: { netFirst: number; domFallback: number; endpoints: Array<[string, number]> }) => void;
    /** Records sanitized endpoint candidates (admin API ranks them; no manual log reading). */
    candidateSink?: CandidateSink;
    /** Tenant + scan every candidate is attributed to (required with candidateSink). */
    candidateScope?: CandidateScope;
  } = {},
): Promise<DistributorCatalogSnapshot> {
  const musicUrl = opts.musicUrl ?? 'https://distrokid.com/mymusic';
  const maxReleases = opts.maxReleases ?? 5000;
  const maxDurationMs = opts.maxDurationMs ?? 600_000; // 10 min budget for the detail-page sweep
  const warnings: string[] = [];

  // esbuild/tsx compile our page.evaluate callbacks with `keepNames`, wrapping helpers in a
  // `__name(...)` call that doesn't exist in the browser context → "__name is not defined",
  // which the evaluate .catch() would swallow (0 releases). Inject a faithful shim as a STRING
  // init script (a FUNCTION would itself be transpiled and reintroduce the __name reference).
  // Matches @sentinel/browser-link's ESBUILD_PAGE_HELPERS. The connect providers already
  // prepare their pages; this keeps the scraper self-sufficient for any caller (e.g. tests)
  // that hands it a raw page. Runs on every navigation this scraper performs.
  await page
    .addInitScript({
      content:
        'globalThis.__name=globalThis.__name||function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};',
    })
    .catch(() => undefined);

  await page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
  // Load the whole list (DistroKid lazy-loads long catalogues on scroll).
  for (let i = 0; i < 40; i++) {
    const before = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    await page.mouse.wheel(0, 6000).catch(() => undefined);
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
    if (after === before) break;
  }

  // 1) Collect release rows + links from the "My Music" list. Structured fixture selectors
  //    first, then real-DistroKid link patterns, then any anchor inside a release-ish row.
  const list = await page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');
    const out: Array<{ href: string | null; title: string; artist: string | null; date: string | null; id: string | null }> = [];
    const seen = new Set<string>();
    const rows = document.querySelectorAll('.release-row, li[data-release-id], [data-release], tr[data-release-id]');
    const push = (href: string | null, title: string, artist: string | null, date: string | null, id: string | null) => {
      const key = href || title;
      if (!title || seen.has(key)) return;
      seen.add(key);
      out.push({ href, title, artist, date, id });
    };
    rows.forEach((el) => {
      const a = el.querySelector('a.release-link, a[href*="/album/"], a[href*="/release/"], a[href*="/mymusic/"], a[href]') as HTMLAnchorElement | null;
      const title = clean(el.querySelector('.release-link, [data-field="release-title"], a')?.textContent) || clean((el as HTMLElement).getAttribute('data-title'));
      push(a?.getAttribute('href') ?? null, title, clean(el.querySelector('.release-artist, [data-field="release-artist"]')?.textContent) || null, clean(el.querySelector('.release-date, [data-field="release-date"]')?.textContent) || null, (el as HTMLElement).getAttribute('data-release-id'));
    });
    if (out.length === 0) {
      document.querySelectorAll('a[href*="/album/"], a[href*="/release/"], a.release-link').forEach((a) => {
        const el = a as HTMLAnchorElement;
        push(el.getAttribute('href'), clean(el.textContent), null, null, null);
      });
    }
    return out;
  }).catch(() => [] as Array<{ href: string | null; title: string; artist: string | null; date: string | null; id: string | null }>);

  const detailLinks = list.filter((r) => r.href).slice(0, maxReleases);
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, detailLinks.length || 1));
  const gotoTimeoutMs = opts.gotoTimeoutMs ?? 30000;
  // DistroKid's dashboard is a heavy SPA whose `domcontentloaded`/`load` can hang for >60s.
  // Default to 'commit' (resolves once the server responds) and then wait for the release DATA
  // to actually render (UPC/ISRC in the page), instead of an ambiguous load event.
  const waitUntil = opts.waitUntil ?? 'commit';
  const contentTimeoutMs = opts.contentTimeoutMs ?? 20000;

  // Each tab that runs `page.evaluate(scrapeReleaseDetailInPage)` MUST have the esbuild `__name`
  // page shim, or the evaluate throws "__name is not defined" and the release drops to list-level
  // only (no UPC/ISRC/dates). The caller's page was prepared by the provider; apply the SAME
  // page-level shim to it (defensive) and to every extra tab (they're created here, unprepared).
  const applyNameShim = (p: Page) => p.addInitScript({ content: ESBUILD_NAME_SHIM }).catch(() => undefined);
  await applyNameShim(page);

  // 2) Visit each release detail page and extract FULL details (UPC, dates, label, stores, and
  //    every track's ISRC/lyrics/credits) IN PARALLEL — a small pool of tabs sharing the same
  //    logged-in session, so a 1000+ song catalogue reads in minutes, not hours. Bounded by
  //    `maxDurationMs`: past the budget we stop navigating and keep the remaining releases with
  //    list-level info only, so it never holds a paid remote session unbounded.
  const results: Array<RawDistributorRelease | null> = new Array(detailLinks.length).fill(null);
  const deadline = Date.now() + maxDurationMs;
  let next = 0;
  let completed = 0;
  let budgetHit = false;
  // Where the metadata actually came from, and which sanitized endpoints served catalog JSON.
  let netFirstCount = 0;
  let domFallbackCount = 0;
  const detailOrigin = (() => { try { return new URL(musicUrl).hostname.replace(/^www\./, ''); } catch { return 'distrokid.com'; } })();

  // NETWORK-FIRST. Discovery is installed at the BROWSER CONTEXT level (covers the extra tabs and
  // any service-worker-served requests) and BEFORE any release navigation, so the metadata
  // response can never be missed. Payloads are parsed by the VERSIONED registry; schema drift
  // surfaces an alert rather than silently-partial data.
  const parsers = new ParserRegistry(undefined, (a) => warnings.push(`[${a.code}] ${a.message}`));
  const discovery: DiscoveryHandle = installDistributorNetworkDiscovery(page.context(), {
    origin: detailOrigin,
    ...(opts.candidateSink && opts.candidateScope ? { sink: opts.candidateSink, scope: opts.candidateScope } : {}),
    minScore: MIN_CATALOG_SCORE,
  });

  // Pool = the caller's page + (concurrency-1) extra tabs. `next++` is atomic in JS's single
  // thread (no await between read and increment), so tabs never claim the same index.
  const extraPages: Page[] = [];
  for (let i = 1; i < concurrency; i++) {
    const p = await page.context().newPage().catch(() => null);
    if (p) { await applyNameShim(p); extraPages.push(p); }
  }
  const readOn = async (tab: Page): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= detailLinks.length) return;
      if (Date.now() > deadline) { budgetHit = true; return; }
      const row = detailLinks[idx]!;
      const detailUrl = new URL(row.href!, musicUrl).toString();
      // Up to 2 attempts: the heavy dashboard page occasionally exceeds the timeout under load
      // but loads on a retry. On the last failure keep the list-level info so nothing is lost.
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Scope capture to THIS release: correlation for discovery, and so one release's
        // payload can never be attributed to another.
        discovery.setCurrentRelease(row.id ?? detailUrl);
        discovery.resetCaptures();
        try {
          await tab.goto(detailUrl, { waitUntil, timeout: gotoTimeoutMs });
          // Wait for the metadata RESPONSE — never for a component to render.
          const hit = await discovery.waitForCatalogResponse(contentTimeoutMs);

          let d: ScrapedReleaseDetail | null = null;
          if (hit) {
            const parsed = parsers.parse(hit.payload, 'NETWORK_JSON');
            if (parsed.ok) { d = canonicalToScraped(parsed.release); netFirstCount++; }
            // parsed.ok === false → schema drift already alerted into `warnings`; fall through
            // to the lower tiers rather than emitting silently-partial data.
          }
          if (!d) {
            // FALLBACK ONLY (tier 5): no usable catalog JSON → read whatever the DOM rendered,
            // with an event-based wait (bounded), never a fixed sleep.
            await tab
              .waitForFunction(
                () => {
                  const t = (document.body && document.body.innerText) || '';
                  return /\b\d{12,13}\b/.test(t) || /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/.test(t);
                },
                { timeout: Math.min(contentTimeoutMs, 8000), polling: 400 },
              )
              .catch(() => undefined);
            d = await tab.evaluate(scrapeReleaseDetailInPage);
            if (d && (d.upc || d.tracks.some((t) => t.isrc))) domFallbackCount++;
          }
          results[idx] = toRawRelease(d, row, detailUrl, artistName);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        warnings.push(`Could not read release "${row.title}" (${detailUrl}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
        results[idx] = toRawRelease(null, row, detailUrl, artistName); // keep list-level info
      }
      opts.onProgress?.(++completed, detailLinks.length);
    }
  };
  await Promise.all([page, ...extraPages].map((tab) => readOn(tab)));
  await Promise.all(extraPages.map((p) => p.close().catch(() => undefined))); // leave caller's page open

  // Fill any releases skipped by the budget with list-level info so nothing is lost.
  let skipped = 0;
  for (let idx = 0; idx < detailLinks.length; idx++) {
    if (results[idx] === null) { results[idx] = toRawRelease(null, detailLinks[idx]!, new URL(detailLinks[idx]!.href!, musicUrl).toString(), artistName); skipped++; }
  }
  if (budgetHit && skipped) warnings.push(`Detail-read budget (${Math.round(maxDurationMs / 1000)}s) reached; ${skipped} release(s) kept with list-level info only.`);
  const releases: RawDistributorRelease[] = results.filter((r): r is RawDistributorRelease => r !== null);

  if (releases.length === 0) {
    warnings.push(`No releases extracted from ${musicUrl}. DistroKid's layout may have changed or the catalogue is empty — capture the page HTML to tune the selectors, or use CSV import.`);
  }
  const ranked = discovery.report();
  discovery.dispose();
  opts.onDiagnostics?.({
    netFirst: netFirstCount,
    domFallback: domFallbackCount,
    // Sanitized descriptors only (method/host/masked-path/query KEY names) — never values.
    endpoints: ranked.slice(0, 10).map((c) => [c.descriptor, c.observations] as [string, number]),
  });
  return { provider: 'distrokid' as DistributorProvider, sourceMode: 'attended-browser-assist', capturedAt: (opts.nowIso ?? (() => new Date().toISOString()))(), artistName: artistName ?? null, releases, warnings };
}

/**
 * Bridge the canonical (network-first, field-status-carrying) model back onto the legacy scraped
 * shape that `toRawRelease` consumes, so the network path and the DOM fallback converge on one
 * downstream mapping. Field STATUS is preserved upstream in the canonical model; here we only
 * need the values (an absent-at-source field simply becomes null).
 */
function canonicalToScraped(r: CanonicalDistributorRelease): ScrapedReleaseDetail {
  return {
    title: r.title || null,
    primaryArtist: r.primaryArtist ?? null,
    upc: r.upc.value ?? null,
    releaseDate: r.releaseDate.value ?? null,
    uploadDate: r.uploadDate?.value ?? null,
    label: r.label?.value ?? null,
    artworkUrl: r.artworkUrl.value ?? null,
    stores: [],
    tracks: r.tracks.map((t, i) => ({
      title: t.title,
      isrc: t.isrc.value ?? null,
      trackNumber: t.trackNumber ?? i + 1,
      plainLyrics: null,
      syncedLyrics: null,
      credits: null,
      // The canonical network model currently exposes featured artists at release level. Clone
      // the list for every flattened track so downstream normalization preserves the credit and
      // no track can mutate a sibling's array.
      featured: [...(r.featuredArtists ?? [])],
    })),
  };
}

/** Upgrade a known store/CDN cover-art thumbnail to a high-resolution variant (best-effort;
 *  unknown hosts pass through unchanged). Apple/iTunes, Deezer, and imgix-style sizing. */
function upgradeArtworkRes(url: string | null): string | null {
  if (!url) return null;
  let u = url;
  u = u.replace(/\/\d{2,4}x\d{2,4}(bb|cc)?\.(jpg|jpeg|png|webp)/i, '/1000x1000$1.$2'); // Apple/iTunes
  u = u.replace(/(\/|-)\d{2,4}x\d{2,4}([.\-/])/g, '$11000x1000$2'); // Deezer & square CDNs
  u = u.replace(/([?&])(w|width)=\d+/gi, '$1$2=1000').replace(/([?&])(h|height)=\d+/gi, '$1$2=1000'); // imgix
  return u;
}

/** DistroKid list rows read as "Title Single Artist". Strip a trailing release-type word and
 *  the artist so the title is just the title ("Pesa Single Lewis KE" + "Lewis KE" → "Pesa"). */
function cleanReleaseTitle(raw: string, artist: string | null): string {
  let t = (raw || '').trim();
  if (!t) return t;
  if (artist && artist.trim()) {
    const a = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('[\\s\\-–—·|,]*' + a + '\\s*$', 'i'), '').trim();
  }
  t = t.replace(/[\s\-–—·|,]*(single|album|ep|lp|deluxe|mixtape)\s*$/i, '').trim();
  return t || (raw || '').trim();
}

/** Map a scraped detail (+ list row fallback) to the adapter's raw release shape. */
function toRawRelease(
  d: ScrapedReleaseDetail | null,
  row: { title: string; artist: string | null; date: string | null; id: string | null },
  detailUrl: string,
  artistName?: string,
): RawDistributorRelease {
  const artist = d?.primaryArtist || row.artist || artistName || 'Unknown Artist';
  // DistroKid's "My Music" rows often read as "Title Single Artist" — strip the release-type
  // word and the trailing artist so the release title is just the title (e.g. "Pesa").
  const title = cleanReleaseTitle(d?.title || row.title || '', artist) || 'Untitled release';
  const tracks = (d?.tracks ?? []).map((t, i) => {
    const tt = (t.title || '').trim();
    // A single's per-track title is often blank on the detail page → fall back to the (clean)
    // release title, not a generic "Untitled"/"Track N".
    const trackTitle = tt && !/^untitled/i.test(tt) ? tt : title !== 'Untitled release' ? title : `Track ${i + 1}`;
    return {
      distributorTrackId: null,
      title: trackTitle,
      primaryArtist: artist,
      featuredArtists: t.featured ?? [],
      isrc: t.isrc,
      trackNumber: t.trackNumber ?? i + 1,
      durationSec: null,
      isExplicit: null,
      lyrics: t.plainLyrics || t.syncedLyrics ? { plain: mapLyrics(t.plainLyrics), synced: mapLyrics(t.syncedLyrics) } : null,
      credits: t.credits ? { state: 'submitted' as const, hasSongwriter: false, hasProducer: false } : null,
    };
  });
  const storeSelections: RawDistributorRelease['storeSelections'] = [];
  for (const s of d?.stores ?? []) {
    const platform = normalizeStorePlatform(s.store);
    if (platform) storeSelections.push({ platform, status: 'selected' });
  }
  return {
    distributorReleaseId: row.id ?? detailUrl,
    title,
    primaryArtist: artist,
    upc: d?.upc ?? null,
    releaseDate: d?.releaseDate ?? row.date ?? null,
    uploadDate: d?.uploadDate ?? null,
    distributorUrl: detailUrl,
    label: d?.label ?? null,
    artworkUrl: upgradeArtworkRes(d?.artworkUrl ?? null),
    storeSelections,
    albumExtras: [],
    tracks: tracks.length ? tracks : [{ distributorTrackId: null, title, primaryArtist: artist, featuredArtists: [], isrc: null, trackNumber: 1, durationSec: null, isExplicit: null, lyrics: null, credits: null }],
  };
}

function mapLyrics(v: string | null): 'none' | 'plain-submitted' | 'plain-approved' | 'synced-submitted' | 'synced-approved' | 'rejected' {
  const s = (v ?? '').toLowerCase();
  if (s.includes('reject')) return 'rejected';
  if (s.includes('approv')) return s.includes('sync') ? 'synced-approved' : 'plain-approved';
  if (s.includes('submit') || s.includes('sync') || s.includes('plain')) return s.includes('sync') ? 'synced-submitted' : 'plain-submitted';
  return 'none';
}

type DKPlatform = RawDistributorRelease['storeSelections'][number]['platform'];
function normalizeStorePlatform(store: string): DKPlatform | null {
  const s = store.toLowerCase();
  if (s.includes('spotify')) return 'spotify';
  if (s.includes('apple') || s.includes('itunes')) return 'apple-music';
  if (s.includes('audiomack')) return 'audiomack';
  if (s.includes('youtube')) return 'youtube-music';
  if (s.includes('tidal')) return 'tidal';
  if (s.includes('amazon')) return 'amazon-music';
  if (s.includes('deezer')) return 'deezer';
  if (s.includes('soundcloud')) return 'soundcloud';
  return null;
}

/**
 * Extract a release detail page's data. Runs INSIDE the browser (page.evaluate), so it is
 * fully self-contained (no imports/closures). Prefers DistroKid's structured markup, then
 * falls back to label-text + regex extraction so it survives layout changes.
 */
export function scrapeReleaseDetailInPage(): ScrapedReleaseDetail {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const ISRC = /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/;
  const UPC = /\b\d{12,13}\b/;
  const DATE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},\s*\d{4})\b/;
  const bodyText = clean(document.body?.innerText || document.body?.textContent);

  const field = (name: string): string | null => {
    const el = document.querySelector(`[data-field="${name}"]`);
    return el ? clean(el.textContent) : null;
  };
  // Value of a <dt>Label</dt><dd>value</dd> pair or a "Label: value" run of text.
  const nearLabel = (labels: string[], re?: RegExp): string | null => {
    for (const dt of Array.from(document.querySelectorAll('dt, th, .label, strong, b'))) {
      const t = clean(dt.textContent).toLowerCase();
      if (labels.some((l) => t === l || t.startsWith(l))) {
        const dd = (dt as HTMLElement).nextElementSibling;
        const v = clean(dd?.textContent);
        if (v) return re ? re.exec(v)?.[0] ?? v : v;
      }
    }
    if (re) {
      for (const l of labels) {
        const idx = bodyText.toLowerCase().indexOf(l);
        if (idx >= 0) { const m = re.exec(bodyText.slice(idx, idx + 80)); if (m) return m[0]; }
      }
    }
    return null;
  };

  const title = field('release-title') || clean(document.querySelector('h1')?.textContent) || null;
  const primaryArtist = field('release-artist') || null;
  const upc = field('upc') || nearLabel(['upc', 'barcode', 'ean'], UPC) || (UPC.exec(bodyText)?.[0] ?? null);
  const releaseDate = field('release-date') || nearLabel(['release date', 'released', 'sale date'], DATE);
  const uploadDate = nearLabel(['upload date', 'uploaded', 'date added', 'submitted', 'created'], DATE);
  const label = field('label') || nearLabel(['label', 'record label']);

  // Cover art: structured selectors first, then the largest non-icon image on the page. Wrapped
  // so a selector/DOM quirk can NEVER abort the (more important) UPC/ISRC/date/track extraction.
  let artworkUrl: string | null = null;
  try {
    const artFrom = (im: Element | null): string | null => {
      if (!im) return null;
      const ss = im.getAttribute('srcset');
      if (ss) { const u = ss.split(',').pop()?.trim().split(/\s+/)[0]; if (u) return u; }
      return im.getAttribute('src') || im.getAttribute('data-src') || null;
    };
    artworkUrl = artFrom(document.querySelector('[data-field="artwork"] img, img[data-field="artwork"], .artwork img, img.artwork, img[alt*="cover"], img[src*="cover"], img[src*="artwork"], img[src*="album"]'));
    if (!artworkUrl) {
      const imgs = Array.from(document.querySelectorAll('img')).filter((im) => { const s = im.getAttribute('src') || ''; return !!s && !/logo|icon|avatar|sprite|spinner|\.svg(\?|$)/i.test(s); });
      imgs.sort((a, b) => ((b as HTMLImageElement).naturalWidth || 0) - ((a as HTMLImageElement).naturalWidth || 0));
      artworkUrl = artFrom(imgs[0] ?? null);
    }
    if (artworkUrl && !/^https?:|^data:/i.test(artworkUrl)) { artworkUrl = new URL(artworkUrl, location.href).href; }
  } catch { artworkUrl = null; }

  const stores: ScrapedReleaseDetail['stores'] = [];
  document.querySelectorAll('[data-store]').forEach((el) => {
    stores.push({ store: (el as HTMLElement).getAttribute('data-store') || clean(el.textContent), status: (el as HTMLElement).getAttribute('data-status') || 'selected' });
  });

  // Tracks: prefer a structured table, else any table/list rows carrying an ISRC.
  const tracks: ScrapedReleaseDetail['tracks'] = [];
  const rowsEls = document.querySelectorAll('table[data-field="tracks"] tbody tr, table tbody tr[data-track-id], [data-track-id], .track-row');
  const seen = new Set<string>();
  const pushTrack = (title: string, isrc: string | null, num: number | null, plain: string | null, synced: string | null, credits: string | null) => {
    const key = `${title}|${isrc ?? ''}`;
    if (!title && !isrc) return;
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push({ title: title || '', isrc, trackNumber: num, plainLyrics: plain, syncedLyrics: synced, credits, featured: [] });
  };
  rowsEls.forEach((tr, i) => {
    const cell = (col: string) => clean(tr.querySelector(`[data-col="${col}"]`)?.textContent);
    const rowText = clean(tr.textContent);
    const t = cell('title') || clean(tr.querySelector('.track-title, td:nth-child(2)')?.textContent);
    const isrc = cell('isrc') || (ISRC.exec(rowText)?.[0] ?? null);
    const numRaw = cell('num') || clean(tr.querySelector('td:first-child')?.textContent);
    const num = /^\d+$/.test(numRaw) ? Number(numRaw) : i + 1;
    pushTrack(t, isrc, num, cell('lyrics') || null, cell('synced') || null, cell('credits') || null);
  });
  // Last-resort: any elements exposing an ISRC in text, if no table matched.
  if (tracks.length === 0) {
    document.querySelectorAll('li, tr, p, div').forEach((el) => {
      const txt = clean(el.textContent);
      const isrc = ISRC.exec(txt)?.[0];
      if (isrc && txt.length < 200) pushTrack(txt.replace(ISRC, '').replace(/ISRC/i, '').trim() || '', isrc, null, null, null, null);
    });
  }

  return { title, primaryArtist, upc, releaseDate, uploadDate, label, artworkUrl, stores, tracks };
}

/**
 * Attended DistroKid session (PRD critical rule). The USER logs in themselves in
 * a real browser — the app NEVER sees, types, stores, or transmits the password,
 * and never bypasses 2FA/CAPTCHA. After the user is authenticated, only READ
 * actions run: it prefers DistroKid's own catalog export (a download of the
 * user's own data) and falls back to reading the release list DOM. The read-only
 * guard blocks any mutation-shaped request as defense in depth, so the tool
 * cannot edit, delete, move, or add releases to stores.
 *
 * @deprecated Test-only local harness. Product attended login must use Steel.
 */
export class AttendedDistroKidSession {
  private session: BrowserSession;
  private page: Page | null = null;
  private loginConfirmed = false;

  constructor(private readonly opts: AttendedDistroKidOptions = {}) {
    // Headed so the user can see and complete the login themselves.
    this.session = new BrowserSession({ headless: false, executablePath: opts.executablePath, slowMo: 50, nowIso: opts.nowIso });
  }

  private emit(e: AttendedEvent): void {
    this.opts.onEvent?.(e);
  }

  /** Launch the browser and land on the DistroKid sign-in page for the user. */
  async start(): Promise<{ signInUrl: string }> {
    const runtime = this.opts.runtimeEnv ?? process.env;
    if (runtime.NODE_ENV !== 'test' || this.opts.allowLocalBrowserForTests !== true) {
      throw new Error('Local attended Chromium is test-only. Start an interactive Steel session for DistroKid login.');
    }
    const ctx = await this.session.start();
    this.page = await ctx.newPage();
    const signInUrl = this.opts.signInUrl ?? 'https://distrokid.com/signin';
    this.emit({ type: 'launched' });
    await this.page.goto(signInUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    this.emit({ type: 'awaiting-login', url: signInUrl });
    return { signInUrl };
  }

  /**
   * Poll until the user has completed login (URL leaves the sign-in page and an
   * authenticated-only surface is reachable). We never automate the credentials.
   */
  async waitForAuthenticated(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
    if (!this.page) throw new Error('start() must be called first');
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Primary signal: the user tells us they've finished logging in (from the
      // app's "I've logged in" button). This never guesses DistroKid's DOM.
      if (this.loginConfirmed) {
        this.emit({ type: 'authenticated' });
        return true;
      }
      // Best-effort auto-detect as a convenience (does not gate the flow).
      const url = this.page.url();
      const onSignin = /signin|sign-in|login/i.test(url);
      const hasAccountNav = await this.page
        .locator('a[href*="mymusic"], a[href*="dashboard"], a[href*="bank"], #signOut, a[href*="signout"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!onSignin && hasAccountNav) {
        this.emit({ type: 'authenticated' });
        return true;
      }
      await this.page.waitForTimeout(pollMs);
    }
    return false;
  }

  /** Called when the user confirms (in the app) that they've completed login. */
  confirmLoggedIn(): void {
    this.loginConfirmed = true;
  }

  /** Navigate to the catalog/music page (read-only). Used before a debug capture. */
  async gotoMusic(): Promise<void> {
    if (!this.page) throw new Error('start() must be called first');
    const musicUrl = this.opts.musicUrl ?? 'https://distrokid.com/mymusic';
    await this.page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    await this.page.waitForTimeout(1500);
  }

  /** Allow the download (read) to proceed past the read-only guard. */
  enterExtractionMode(): void {
    this.session.enterExtractionMode();
  }

  /**
   * Capture the next file download (e.g. DistroKid's own catalog spreadsheet
   * export) — the RAW bytes + suggested filename, so its true format (CSV/XLSX)
   * and columns can be inspected. Read-only. Returns null if none arrives in time.
   */
  async captureNextDownload(timeoutMs = 120_000): Promise<{ filename: string; buffer: Buffer } | null> {
    if (!this.page) throw new Error('start() must be called first');
    try {
      const download = await this.page.waitForEvent('download', { timeout: timeoutMs });
      const filename = download.suggestedFilename();
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      if (stream) for await (const c of stream) chunks.push(Buffer.from(c));
      return { filename, buffer: Buffer.concat(chunks) };
    } catch {
      return null;
    }
  }

  /**
   * Capture the current page's URL, title, HTML, and a full-page screenshot for
   * tuning the extraction selectors to a real DistroKid account. Read-only; the
   * caller decides where to persist the bytes (kept out of this package).
   */
  async captureCurrentPage(): Promise<{ url: string; title: string; html: string; screenshot: Buffer }> {
    if (!this.page) throw new Error('start() must be called first');
    const url = this.page.url();
    const title = await this.page.title().catch(() => '');
    const html = await this.page.content().catch(() => '');
    const screenshot = await this.page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0));
    return { url, title, html, screenshot };
  }

  /** Read-only catalog extraction. Export-first, DOM fallback. */
  async extractCatalog(artistName?: string): Promise<DistributorCatalogSnapshot> {
    if (!this.page) throw new Error('start() must be called first');
    this.session.enterExtractionMode();
    this.emit({ type: 'extracting' });

    const csv = await this.tryExportDownload();
    if (csv) {
      const parser = new GenericCsvDistributorAdapter('distrokid', 'attended-browser-assist', this.opts.nowIso);
      const snap = parser.parseCatalog(csv, artistName ?? null);
      this.emit({ type: 'extracted', releases: snap.releases.length, tracks: snap.releases.reduce((n, r) => n + r.tracks.length, 0) });
      return snap;
    }

    const releases = await this.scrapeReleaseList(artistName);
    const warnings: string[] = [];
    if (releases.length === 0) {
      // Never fail silently — report exactly what the browser was looking at so
      // the selectors can be tuned to this account's DistroKid layout.
      const diag = await this.pageDiagnostics();
      warnings.push(
        `No releases extracted. The browser was on "${diag.title}" (${diag.url}). ` +
          `Found ${diag.releaseLinks} release links and ${diag.tables} tables. ` +
          `If you were logged in, the catalog page layout differs from the default selectors — share this and it can be tuned.`,
      );
    }
    const snap: DistributorCatalogSnapshot = {
      provider: 'distrokid' as DistributorProvider,
      sourceMode: 'attended-browser-assist',
      capturedAt: (this.opts.nowIso ?? (() => new Date().toISOString()))(),
      artistName: artistName ?? null,
      releases,
      warnings,
    };
    this.emit({ type: 'extracted', releases: snap.releases.length, tracks: releases.reduce((n, r) => n + r.tracks.length, 0) });
    return snap;
  }

  /** Attempt DistroKid's own "download CSV/spreadsheet" export (read-only). */
  private async tryExportDownload(): Promise<string | null> {
    if (!this.page) return null;
    const musicUrl = this.opts.musicUrl ?? 'https://distrokid.com/mymusic';
    try {
      await this.page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.waitForTimeout(1500);
      const text = this.opts.exportControlText ?? /download|export|spreadsheet|csv/i;
      const control = this.page.getByText(text).first();
      if (!(await control.isVisible().catch(() => false))) return null;
      const [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: 30000 }),
        control.click({ timeout: 5000 }),
      ]);
      const stream = await download.createReadStream();
      if (!stream) return null;
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Fallback: read the release list from the DOM (titles, URLs, visible ISRCs). */
  private async scrapeReleaseList(artistName?: string): Promise<RawDistributorRelease[]> {
    if (!this.page) return [];
    const musicUrl = this.opts.musicUrl ?? 'https://distrokid.com/mymusic';
    await this.page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Scroll to load the full list.
    for (let i = 0; i < 30; i++) {
      const before = await this.page.evaluate(() => document.body.scrollHeight);
      await this.page.mouse.wheel(0, 6000);
      await this.page.waitForTimeout(900);
      const after = await this.page.evaluate(() => document.body.scrollHeight);
      if (after === before) break;
    }
    const raw = await this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('a[href*="/album/"], a[href*="/release/"], [data-release], tr'));
      return rows
        .map((el) => {
          const a = el.matches('a') ? (el as HTMLAnchorElement) : el.querySelector('a');
          const title = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
          return { href: a?.getAttribute('href') ?? null, title };
        })
        .filter((r) => r.title.length > 0);
    });

    return raw.slice(0, 5000).map((r, idx) => {
      const isrc = ISRC_RE.exec(r.title)?.[0] ?? null;
      const title = r.title.replace(ISRC_RE, '').trim() || `Release ${idx + 1}`;
      return {
        distributorReleaseId: r.href,
        title,
        primaryArtist: artistName ?? 'Unknown Artist',
        upc: null,
        releaseDate: null,
        uploadDate: null,
        distributorUrl: r.href ? new URL(r.href, 'https://distrokid.com').toString() : null,
        label: null,
        storeSelections: [{ platform: 'audiomack', status: 'selected' }],
        albumExtras: ['audiomack-opt-in'],
        tracks: [
          {
            distributorTrackId: null,
            title,
            primaryArtist: artistName ?? 'Unknown Artist',
            featuredArtists: [],
            isrc,
            trackNumber: 1,
            durationSec: null,
            isExplicit: null,
            lyrics: null,
            credits: null,
          },
        ],
      };
    });
  }

  private async pageDiagnostics(): Promise<{ url: string; title: string; releaseLinks: number; tables: number }> {
    if (!this.page) return { url: '(no page)', title: '(no page)', releaseLinks: 0, tables: 0 };
    const url = this.page.url();
    const title = await this.page.title().catch(() => '(unknown)');
    const counts = await this.page
      .evaluate(() => ({
        releaseLinks: document.querySelectorAll('a[href*="/album/"], a[href*="/release/"]').length,
        tables: document.querySelectorAll('table, [role="table"], [data-release]').length,
      }))
      .catch(() => ({ releaseLinks: 0, tables: 0 }));
    return { url, title, ...counts };
  }

  blockedMutations(): number {
    return this.session.guard?.blocked.length ?? 0;
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

/**
 * DistributorAdapter wrapper around an already-authenticated attended session.
 * Used by the engine/API once the user has logged in.
 */
export class AttendedDistroKidAdapter implements DistributorAdapter {
  readonly provider = 'distrokid' as const;
  readonly capabilities = CAPABILITIES;
  constructor(private readonly session: AttendedDistroKidSession, private readonly artistName?: string) {}

  async discoverCatalog(_input: CatalogDiscoveryInput): Promise<DistributorCatalogSnapshot> {
    return this.session.extractCatalog(this.artistName);
  }
  async discoverReleaseDetails(): Promise<never> {
    throw new Error('Use discoverCatalog for attended extraction.');
  }
  async discoverTrackDetails(): Promise<never> {
    throw new Error('Use discoverCatalog for attended extraction.');
  }
  async discoverStoreSelection(): Promise<never> {
    throw new Error('Not supported in attended mode.');
  }
  async discoverLyricsStatus(): Promise<never> {
    throw new Error('Not supported in attended mode.');
  }
  async discoverCreditsStatus(): Promise<never> {
    throw new Error('Not supported in attended mode.');
  }
}
