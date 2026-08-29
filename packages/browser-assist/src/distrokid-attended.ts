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
import type { CanonicalDistributorRelease, LyricStatus } from './distrokid/metadata-model';

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
  /** URLs (all GET/read), override if DistroKid changes its paths. */
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
  /** Stores DistroKid shows this release was submitted to ("Submitted to X" icon strip), with the
   *  deep-link to the release on that store when DistroKid provides one. */
  submittedStores: Array<{ store: string; url: string | null }>;
  tracks: Array<{ title: string; isrc: string | null; trackNumber: number | null; plainLyrics: LyricStatus | null; syncedLyrics: LyricStatus | null; credits: string | null; featured: string[] }>;
}

/** esbuild/tsx compile our `page.evaluate` callbacks with `keepNames`, wrapping helpers in a
 *  `__name(...)` call absent from the browser. Inject this no-op shim (string, not a function -
 *  a function would itself be transpiled) into every tab before it evaluates. */
export const ESBUILD_NAME_SHIM =
  'globalThis.__name=globalThis.__name||function(t,v){try{Object.defineProperty(t,"name",{value:v,configurable:true})}catch(e){}return t};';

export interface DistroKidCatalogIndexEntry {
  releaseId: string;
  dashboardUrl: string;
  title: string;
  artist?: string;
  /** Independently displayed list-level count. Omitted when the index does not expose one. */
  expectedTrackCount?: number;
}

/**
 * Stable, sanitized failure vocabulary for the catalog-index boundary.
 *
 * Callers may persist or expose `code`; `message` is deliberately controlled below and never
 * contains a distributor URL, release identity, page content, cookie, token, or response body.
 */
export const DISTROKID_CATALOG_INDEX_ERROR_CODES = [
  'INVALID_CATALOG_URL',
  'AUTHENTICATION_REQUIRED',
  'INVALID_RELEASE_LIMIT',
  'RELEASE_IDENTITY_MISSING',
  'RELEASE_IDENTITY_CONFLICT',
  'RELEASE_LIMIT_REACHED',
  'LOAD_BUDGET_EXHAUSTED',
  'AUTHENTICATION_EXPIRED',
  'NO_RECOGNIZABLE_RELEASES',
  'UNSAFE_RELEASE_URL',
] as const;

export type DistroKidCatalogIndexErrorCode =
  (typeof DISTROKID_CATALOG_INDEX_ERROR_CODES)[number];

const DISTROKID_CATALOG_INDEX_ERROR_CODE_SET: ReadonlySet<string> =
  new Set(DISTROKID_CATALOG_INDEX_ERROR_CODES);
const DISTROKID_CATALOG_INDEX_ERROR_PREFIX = 'DISTROKID_CATALOG_INDEX:';

export class DistroKidCatalogIndexError extends Error {
  constructor(
    readonly code: DistroKidCatalogIndexErrorCode,
    message: string,
  ) {
    super(`[${DISTROKID_CATALOG_INDEX_ERROR_PREFIX}${code}] ${message}`);
    this.name = 'DistroKidCatalogIndexError';
  }
}

/**
 * Recover a code from BullMQ's persisted `failedReason` without trusting arbitrary text as a
 * public failure category. Unknown, malformed, or non-index messages always return null.
 */
export function distroKidCatalogIndexErrorCodeFromMessage(
  message: string,
): DistroKidCatalogIndexErrorCode | null {
  const close = message.indexOf(']');
  if (close < 0 || message[0] !== '[') return null;
  const token = message.slice(1, close);
  if (!token.startsWith(DISTROKID_CATALOG_INDEX_ERROR_PREFIX)) return null;
  const code = token.slice(DISTROKID_CATALOG_INDEX_ERROR_PREFIX.length);
  return DISTROKID_CATALOG_INDEX_ERROR_CODE_SET.has(code)
    ? code as DistroKidCatalogIndexErrorCode
    : null;
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
    const visible = (element: Element): boolean => {
      const node = element as HTMLElement;
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
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
    // DistroKid collapses releases at index >= 10 behind a "Show all releases" toggle
    // (toggleExpand() adds display-flex/display-inline/release-row-show). Those hidden rows are
    // REAL releases with distinct albumuuid hrefs, not responsive duplicates, so reveal them
    // locally (a read-only DOM change, never a network mutation) before the visible-row read below.
    // Without this, only the ~10 shown by default are indexed. Idempotent across scroll rounds.
    document.querySelectorAll('.release-row').forEach((row, index) => {
      if (index >= 10) row.classList.add('display-flex', 'display-inline', 'release-row-show');
    });
    document.querySelectorAll('.release-row, li[data-release-id], [data-release], tr[data-release-id]').forEach((el) => {
      // DistroKid can keep desktop and mobile renderings in the DOM simultaneously. Hidden
      // responsive copies are not independent releases and must not inflate or invalidate the
      // authoritative index.
      if (!visible(el)) return;
      const anchors = Array.from(el.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const a = anchors
        .map((anchor, ordinal) => {
          const href = anchor.getAttribute('href') ?? '';
          let score = 0;
          if (anchor.matches('.release-link, [data-field="release-title"]')) score += 100;
          if (/[?&](?:albumuuid|release(?:id|uuid)?)=/i.test(href)) score += 80;
          if (/\/(?:dashboard\/)?album(?:\/|$)/i.test(href)) score += 60;
          if (/\/release(?:\/|$)/i.test(href)) score += 50;
          if (/\/mymusic(?:\/|$)/i.test(href)) score += 20;
          return { anchor, ordinal, score };
        })
        .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)[0]?.anchor ?? null;
      const title = clean(el.querySelector('.release-link, [data-field="release-title"], [data-testid*="release-title" i]')?.textContent)
        || clean((el as HTMLElement).getAttribute('data-title'))
        || clean(a?.textContent);
      const href = a?.getAttribute('href') ?? null;
      let hrefId: string | null = null;
      if (href) {
        try {
          const parsed = new URL(href, document.baseURI);
          hrefId = parsed.searchParams.get('albumuuid')
            ?? parsed.searchParams.get('releaseuuid')
            ?? parsed.searchParams.get('releaseId');
        } catch {
          // The server-side URL policy below rejects malformed or unsafe links.
        }
      }
      push(
        href,
        title,
        clean(el.querySelector('.release-artist, [data-field="release-artist"]')?.textContent) || null,
        (el as HTMLElement).getAttribute('data-release-id')
          ?? (el as HTMLElement).getAttribute('data-albumuuid')
          ?? (el as HTMLElement).getAttribute('data-album-uuid')
          ?? hrefId,
        trackCount(el),
      );
    });
    if (out.length === 0) {
      document.querySelectorAll('a[href*="/album/"], a[href*="/release/"], a.release-link').forEach((a) => {
        if (!visible(a)) return;
        const el = a as HTMLAnchorElement;
        push(el.getAttribute('href'), clean(el.textContent), null, null, null);
      });
    }
    return out;
  });
}

interface CatalogIndexAccumulator {
  row: RawCatalogIndexEntry;
  ids: Set<string>;
  hrefs: Set<string>;
  trackCountConflict: boolean;
}

function preferredCatalogText(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming;
  if (!incoming) return current;
  const generic = /^(?:album|edit|manage|music|release|stats?|view)$/i;
  const currentScore = (generic.test(current) ? 0 : 1_000) + current.length;
  const incomingScore = (generic.test(incoming) ? 0 : 1_000) + incoming.length;
  return incomingScore > currentScore ? incoming : current;
}

function preferredCatalogHref(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming;
  if (!incoming || current === incoming) return current;
  const score = (raw: string): number => {
    try {
      const url = new URL(raw);
      let value = 0;
      if (url.searchParams.has('albumuuid') || url.searchParams.has('releaseuuid') || url.searchParams.has('releaseId')) value += 100;
      if (/\/(?:dashboard\/)?album(?:\/|$)/i.test(url.pathname)) value += 80;
      if (/\/release(?:\/|$)/i.test(url.pathname)) value += 60;
      if (/\/mymusic(?:\/|$)/i.test(url.pathname)) value += 20;
      return value;
    } catch {
      return -1;
    }
  };
  return score(incoming) > score(current) ? incoming : current;
}

function mergeCatalogIndexRow(
  accumulator: CatalogIndexAccumulator,
  incoming: RawCatalogIndexEntry,
): void {
  const currentCount = accumulator.row.expectedTrackCount;
  const incomingCount = incoming.expectedTrackCount;
  if (currentCount !== null && incomingCount !== null && currentCount !== incomingCount) {
    // Conflicting list-level totals are not fatal to release discovery, but they are not
    // independent proof either. Keep the expectation explicitly unknown and let release-detail
    // extraction establish only the observed track count.
    accumulator.trackCountConflict = true;
  }
  accumulator.row = {
    href: preferredCatalogHref(accumulator.row.href, incoming.href),
    title: preferredCatalogText(accumulator.row.title, incoming.title) ?? incoming.title,
    artist: preferredCatalogText(accumulator.row.artist, incoming.artist),
    id: accumulator.row.id ?? incoming.id,
    expectedTrackCount: accumulator.trackCountConflict
      ? null
      : currentCount ?? incomingCount,
  };
}

interface CatalogLoadState {
  height: number;
  pending: boolean;
  expectedTotal: number | null;
  hasLoadMore: boolean;
  atScrollableEnd: boolean;
}

async function readCatalogLoadState(page: Page): Promise<CatalogLoadState> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const loadMore = (element: Element) => {
      const node = element as HTMLElement;
      const text = (node.innerText || node.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
      const disabled = (node as HTMLButtonElement).disabled || node.getAttribute('aria-disabled') === 'true';
      return !disabled && visible(node) &&
        /^(?:load|show|view)\s+more(?:\s+releases?)?$/i.test(text);
    };
    const scrollSurfaces = (): HTMLElement[] => {
      const surfaces = new Set<HTMLElement>();
      const scrolling = document.scrollingElement as HTMLElement | null;
      if (scrolling) surfaces.add(scrolling);
      const firstRelease = document.querySelector(
        '.release-row, li[data-release-id], [data-release], tr[data-release-id]',
      );
      for (let node = firstRelease?.parentElement ?? null; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 2 &&
            /(?:auto|scroll|overlay)/i.test(style.overflowY)) {
          surfaces.add(node);
        }
      }
      return [...surfaces];
    };
    const pending = Array.from(document.querySelectorAll(
      '[aria-busy="true"], [data-loading="true"], [data-state="loading"], .loading, .spinner',
    )).some(visible);

    const totals: number[] = [];
    for (const element of document.querySelectorAll('[data-total-releases], [data-release-count]')) {
      const raw = element.getAttribute('data-total-releases') ?? element.getAttribute('data-release-count') ?? '';
      const normalized = raw.trim().replace(/,/g, '');
      const parsed = /^\d+$/.test(normalized) ? Number.parseInt(normalized, 10) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed >= 0) {
        totals.push(parsed);
      }
    }
    if (totals.length === 0) {
      const text = document.body.innerText.replace(/\s+/g, ' ');
      const patterns = [
        /showing\s+[\d,]+(?:\s*(?:-|\u2013)\s*[\d,]+)?\s+(?:of|\/)\s+([\d,]+)\s+releases?\b/gi,
        /\b([\d,]+)\s+releases?\s+(?:in\s+total|total)\b/gi,
        /\btotal\s+releases?\s*:?\s*([\d,]+)\b/gi,
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) {
          const parsed = match[1] ? Number.parseInt(match[1].replace(/,/g, ''), 10) : Number.NaN;
          if (Number.isSafeInteger(parsed) && parsed >= 0) totals.push(parsed);
        }
      }
    }
    const surfaces = scrollSurfaces();
    const atScrollableEnd = surfaces.every(
      (surface) => surface.scrollHeight - surface.scrollTop - surface.clientHeight <= 4,
    );
    const height = surfaces.reduce(
      (total, surface) => total + surface.scrollHeight,
      Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    );
    return {
      height,
      pending,
      expectedTotal: totals.length > 0 ? Math.max(...totals) : null,
      hasLoadMore: Array.from(document.querySelectorAll(
        '[data-testid*="load-more" i], [data-action*="load-more" i], button, a[role="button"]',
      )).some(loadMore),
      atScrollableEnd,
    };
  });
}

async function scrollCatalogSurfacesToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const surfaces = new Set<HTMLElement>();
    const scrolling = document.scrollingElement as HTMLElement | null;
    if (scrolling) surfaces.add(scrolling);
    const firstRelease = document.querySelector(
      '.release-row, li[data-release-id], [data-release], tr[data-release-id]',
    );
    for (let node = firstRelease?.parentElement ?? null; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 2 &&
          /(?:auto|scroll|overlay)/i.test(style.overflowY)) {
        surfaces.add(node);
      }
    }
    for (const surface of surfaces) surface.scrollTop = surface.scrollHeight;
    window.scrollTo(0, Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
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
  let target: URL;
  try {
    target = new URL(musicUrl);
  } catch {
    throw new DistroKidCatalogIndexError(
      'INVALID_CATALOG_URL',
      'DistroKid catalog index URL must use HTTPS on a distrokid.com host.',
    );
  }
  if (target.protocol !== 'https:' || !(target.hostname === 'distrokid.com' || target.hostname.endsWith('.distrokid.com'))) {
    throw new DistroKidCatalogIndexError(
      'INVALID_CATALOG_URL',
      'DistroKid catalog index URL must use HTTPS on a distrokid.com host.',
    );
  }
  await page.addInitScript({ content: ESBUILD_NAME_SHIM }).catch(() => undefined);
  await page.goto(musicUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const landed = new URL(page.url());
  if (!(landed.hostname === 'distrokid.com' || landed.hostname.endsWith('.distrokid.com')) || /\b(sign[-_]?in|login)\b/i.test(landed.pathname)) {
    throw new DistroKidCatalogIndexError(
      'AUTHENTICATION_REQUIRED',
      'DistroKid authentication is required before reading the catalog index.',
    );
  }

  const maxReleases = opts.maxReleases ?? 5000;
  const maxScrollRounds = Math.max(1, Math.min(opts.maxScrollRounds ?? 500, 2_000));
  const requiredStableRounds = Math.max(2, Math.min(opts.stabilityRounds ?? 3, 10));
  // When DistroKid does not expose an independent total, require a substantially longer quiet
  // period at the bottom of both the document and the catalogue's own scroll container.
  const unknownTotalStableRounds = Math.max(requiredStableRounds, 10);
  const settleDelayMs = Math.max(25, Math.min(opts.settleDelayMs ?? 700, 5000));
  if (!Number.isSafeInteger(maxReleases) || maxReleases < 1) {
    throw new DistroKidCatalogIndexError(
      'INVALID_RELEASE_LIMIT',
      'DistroKid catalog maxReleases must be a positive integer.',
    );
  }

  // A modern responsive/virtualized dashboard may render the same release more than once. Treat
  // stable ids and absolute detail URLs as aliases for one release. A true collision (one URL
  // associated with two distinct stable ids, or one sampled row bridging two prior releases)
  // still fails closed because catalogue cardinality would be ambiguous.
  const rows = new Set<CatalogIndexAccumulator>();
  const byId = new Map<string, CatalogIndexAccumulator>();
  const byHref = new Map<string, CatalogIndexAccumulator>();
  const mergeVisibleRows = async () => {
    let added = 0;
    for (const rawRow of await readVisibleCatalogIndexEntries(page)) {
      let href: string | null = null;
      if (rawRow.href?.trim()) {
        try {
          href = new URL(rawRow.href.trim(), musicUrl).toString();
        } catch {
          throw new DistroKidCatalogIndexError(
            'UNSAFE_RELEASE_URL',
            'DistroKid catalog index returned an unsafe release URL.',
          );
        }
      }
      const row = {
        ...rawRow,
        id: rawRow.id?.trim() || null,
        href,
      };
      if (!row.id && !row.href) {
        throw new DistroKidCatalogIndexError(
          'RELEASE_IDENTITY_MISSING',
          'DistroKid catalog row has no stable unique id or release URL; completeness cannot be established.',
        );
      }
      const idMatch = row.id ? byId.get(row.id) : undefined;
      const hrefMatch = row.href ? byHref.get(row.href) : undefined;
      if (idMatch && hrefMatch && idMatch !== hrefMatch) {
        throw new DistroKidCatalogIndexError(
          'RELEASE_IDENTITY_CONFLICT',
          'DistroKid catalog row associates two conflicting stable release identities; completeness cannot be established.',
        );
      }
      const accumulator = idMatch ?? hrefMatch ?? {
        row,
        ids: new Set<string>(),
        hrefs: new Set<string>(),
        trackCountConflict: false,
      };
      if (row.id && accumulator.ids.size > 0 && !accumulator.ids.has(row.id)) {
        throw new DistroKidCatalogIndexError(
          'RELEASE_IDENTITY_CONFLICT',
          'DistroKid catalog URL maps to multiple stable release ids; completeness cannot be established.',
        );
      }
      if (!idMatch && !hrefMatch) {
        rows.add(accumulator);
        added += 1;
      } else {
        mergeCatalogIndexRow(accumulator, row);
      }
      if (row.id) {
        accumulator.ids.add(row.id);
        byId.set(row.id, accumulator);
      }
      if (row.href) {
        accumulator.hrefs.add(row.href);
        byHref.set(row.href, accumulator);
      }
    }
    return added;
  };

  await mergeVisibleRows();
  let previous = await readCatalogLoadState(page);
  let strongestExpectedTotal = previous.expectedTotal;
  let stableRounds = 0;
  let indexStabilized = false;
  for (let round = 0; round < maxScrollRounds; round += 1) {
    if (rows.size >= maxReleases) {
      throw new DistroKidCatalogIndexError(
        'RELEASE_LIMIT_REACHED',
        `DistroKid catalog index reached the configured ${maxReleases}-release cap; refusing to report a potentially truncated catalog.`,
      );
    }
    const clickedLoadMore = await clickCatalogLoadMore(page).catch(() => false);
    await scrollCatalogSurfacesToEnd(page).catch(() => undefined);
    await page.mouse.wheel(0, 6000).catch(() => undefined);
    await page.waitForTimeout(settleDelayMs);
    const added = await mergeVisibleRows();
    const current = await readCatalogLoadState(page);
    if (current.expectedTotal !== null) {
      // Virtualized dashboards can remove the count node while scrolling. Never forget a
      // stronger expectation observed earlier and then declare a truncated viewport complete.
      strongestExpectedTotal = strongestExpectedTotal === null
        ? current.expectedTotal
        : Math.max(strongestExpectedTotal, current.expectedTotal);
    }
    const countSatisfied = strongestExpectedTotal !== null && rows.size === strongestExpectedTotal;
    const endObserved = !current.hasLoadMore && current.atScrollableEnd;
    const stable = !clickedLoadMore && !current.pending && added === 0 &&
      current.height === previous.height && endObserved;
    stableRounds = stable ? stableRounds + 1 : 0;
    if (strongestExpectedTotal !== null && rows.size > strongestExpectedTotal &&
        stableRounds >= requiredStableRounds) {
      throw new DistroKidCatalogIndexError(
        'RELEASE_IDENTITY_CONFLICT',
        'DistroKid catalog index captured more stable releases than its independent total; completeness cannot be established.',
      );
    }
    const stableThreshold = strongestExpectedTotal === null
      ? unknownTotalStableRounds
      : requiredStableRounds;
    if (stableRounds >= stableThreshold &&
        (strongestExpectedTotal === null || countSatisfied)) {
      indexStabilized = true;
      break;
    }
    previous = current;
  }
  if (!indexStabilized) {
    const state = await readCatalogLoadState(page).catch(() => ({
      height: 0,
      pending: false,
      expectedTotal: null,
      hasLoadMore: false,
      atScrollableEnd: false,
    }));
    const finalExpected = state.expectedTotal === null
      ? strongestExpectedTotal
      : strongestExpectedTotal === null
        ? state.expectedTotal
        : Math.max(strongestExpectedTotal, state.expectedTotal);
    const expected = finalExpected === null ? 'unknown' : String(finalExpected);
    throw new DistroKidCatalogIndexError(
      'LOAD_BUDGET_EXHAUSTED',
      `DistroKid catalog index did not establish completeness before the load budget (captured=${rows.size}, expected=${expected}).`,
    );
  }

  const finalUrl = new URL(page.url());
  if (!(finalUrl.hostname === 'distrokid.com' || finalUrl.hostname.endsWith('.distrokid.com')) || /\b(sign[-_]?in|login)\b/i.test(finalUrl.pathname)) {
    throw new DistroKidCatalogIndexError(
      'AUTHENTICATION_EXPIRED',
      'DistroKid authentication expired while reading the catalog index.',
    );
  }
  if (rows.size === 0) {
    throw new DistroKidCatalogIndexError(
      'NO_RECOGNIZABLE_RELEASES',
      'DistroKid returned no recognizable release rows; refusing to treat an unauthenticated, changed, or incomplete page as an empty catalog.',
    );
  }
  if (rows.size >= maxReleases) {
    throw new DistroKidCatalogIndexError(
      'RELEASE_LIMIT_REACHED',
      `DistroKid catalog index reached the configured ${maxReleases}-release cap; refusing to report a potentially truncated catalog.`,
    );
  }
  const entries: DistroKidCatalogIndexEntry[] = [];
  const releaseIds = new Set<string>();
  for (const { row } of rows) {
    const dashboardUrl = row.href ? new URL(row.href, musicUrl).toString() : musicUrl;
    const dashboard = new URL(dashboardUrl);
    if (dashboard.protocol !== 'https:' || dashboard.username || dashboard.password ||
        (dashboard.port && dashboard.port !== '443') ||
        !(dashboard.hostname === 'distrokid.com' || dashboard.hostname.endsWith('.distrokid.com'))) {
      throw new DistroKidCatalogIndexError(
        'UNSAFE_RELEASE_URL',
        'DistroKid catalog index returned an unsafe release URL.',
      );
    }
    const releaseId = row.id || dashboardUrl;
    if (releaseIds.has(releaseId)) {
      throw new DistroKidCatalogIndexError(
        'RELEASE_IDENTITY_CONFLICT',
        'DistroKid catalog index resolved multiple rows to the same release identity; completeness cannot be established.',
      );
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
    /** Max releases to visit. Default 5000, supports very large catalogues (1000+ songs). */
    maxReleases?: number;
    /** Overall budget for visiting release detail pages; when exceeded we stop and return
     *  what we have (with list-level info for the rest). Keeps a huge/slow catalogue bounded. */
    maxDurationMs?: number;
    /** How many release detail pages to read in parallel (pool of tabs on the same session).
     *  Keep LOW, the DistroKid dashboard is a heavy SPA; too many concurrent tabs starve each
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
     *  descriptors that carried catalog JSON (no values/secrets), for endpoint discovery. */
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
  //    every track's ISRC/lyrics/credits) IN PARALLEL, a small pool of tabs sharing the same
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
          // Wait for the metadata RESPONSE, never for a component to render.
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
    warnings.push(`No releases extracted from ${musicUrl}. DistroKid's layout may have changed or the catalogue is empty, capture the page HTML to tune the selectors, or use CSV import.`);
  }
  const ranked = discovery.report();
  discovery.dispose();
  opts.onDiagnostics?.({
    netFirst: netFirstCount,
    domFallback: domFallbackCount,
    // Sanitized descriptors only (method/host/masked-path/query KEY names), never values.
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
    submittedStores: r.submittedStores ?? [],
    tracks: r.tracks.map((t, i) => ({
      title: t.title,
      isrc: t.isrc.value ?? null,
      trackNumber: t.trackNumber ?? i + 1,
      plainLyrics: t.lyrics?.plain ?? null,
      syncedLyrics: t.lyrics?.synced ?? null,
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
  // DistroKid's "My Music" rows often read as "Title Single Artist", strip the release-type
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
      lyrics: t.plainLyrics || t.syncedLyrics ? { plain: rawLyricState('plain', t.plainLyrics), synced: rawLyricState('synced', t.syncedLyrics) } : null,
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

/** Map a normalized per-type LyricStatus to the adapter's raw lyric-state vocabulary. The kind
 *  (plain vs synced) supplies the distinction the flat status token does not carry. */
function rawLyricState(kind: 'plain' | 'synced', s: LyricStatus | null): 'none' | 'plain-submitted' | 'plain-approved' | 'synced-submitted' | 'synced-approved' | 'rejected' {
  if (s === 'present') return kind === 'synced' ? 'synced-approved' : 'plain-approved';
  if (s === 'processing') return kind === 'synced' ? 'synced-submitted' : 'plain-submitted';
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
  // Value of a <dt>Label</dt><dd>value</dd> pair, DistroKid's <span>Label:</span><span
  // class="info-value">value</span> pattern, or a "Label: value" run of text.
  const nearLabel = (labels: string[], re?: RegExp): string | null => {
    for (const dt of Array.from(document.querySelectorAll('dt, th, .label, strong, b, span'))) {
      const t = clean(dt.textContent).toLowerCase();
      if (labels.some((l) => t === l || t.startsWith(l))) {
        // Prefer a sibling .info-value (DistroKid), else the next element sibling.
        const dd = (dt.parentElement?.querySelector('.info-value') as HTMLElement | null)
          ?? (dt as HTMLElement).nextElementSibling;
        const v = clean(dd?.textContent);
        if (v && v.toLowerCase() !== t) return re ? re.exec(v)?.[0] ?? v : v;
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

  // DistroKid's album page carries clean release + artist in its social meta tags:
  //   og:title       = "<Artist> - <Release>"
  //   og:description = "<Release> by <Artist>. Released <date> (<n> songs)"
  // These beat the <h1> (which concatenates "<Release> Single <Artist>") and fix a null artist.
  const metaTag = (sel: string): string | null => document.querySelector(sel)?.getAttribute('content') || null;
  const ogTitle = clean(metaTag('meta[property="og:title"]'));
  const ogDesc = clean(metaTag('meta[property="og:description"]'));
  let metaRelease: string | null = null;
  let metaArtist: string | null = null;
  const descMatch = ogDesc ? /^(.+?)\s+by\s+(.+?)\.\s/.exec(ogDesc) : null;
  if (descMatch) { metaRelease = clean(descMatch[1]); metaArtist = clean(descMatch[2]); }
  if ((!metaArtist || !metaRelease) && ogTitle && ogTitle.includes(' - ')) {
    const [head, ...rest] = ogTitle.split(' - ');
    if (!metaArtist) metaArtist = clean(head);
    if (!metaRelease) metaRelease = clean(rest.join(' - '));
  }
  const title = field('release-title') || metaRelease || clean(document.querySelector('h1')?.textContent) || null;
  const primaryArtist = field('release-artist') || metaArtist || null;
  // DistroKid renders the barcode in #js-album-upc behind a "DistroKid UPC:" span label.
  const upcById = clean(document.querySelector('#js-album-upc')?.textContent);
  const upc = (upcById && UPC.test(upcById) ? upcById : null)
    || field('upc') || nearLabel(['distrokid upc', 'upc', 'barcode', 'ean'], UPC) || (UPC.exec(bodyText)?.[0] ?? null);
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
    // DistroKid exposes the high-res (3000x3000) cover via og:image, the most reliable source,
    // and it avoids grabbing the user's avatar (also an S3 image) as a false cover.
    const metaContent = (sel: string) => document.querySelector(sel)?.getAttribute('content') || null;
    const ogArt = metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');
    artworkUrl = (ogArt && !/\/avatar-/i.test(ogArt) ? ogArt : null)
      || artFrom(document.querySelector('[data-field="artwork"] img, img[data-field="artwork"], .artwork img, img.artwork, img[alt*="cover"], img[src*="cover"], img[src*="artwork"], img[src*="album"]'));
    if (!artworkUrl) {
      const imgs = Array.from(document.querySelectorAll('img')).filter((im) => { const s = im.getAttribute('src') || ''; return !!s && !/logo|icon|avatar|sprite|spinner|\.svg(\?|$)/i.test(s); });
      imgs.sort((a, b) => ((b as HTMLImageElement).naturalWidth || 0) - ((a as HTMLImageElement).naturalWidth || 0));
      artworkUrl = artFrom(imgs[0] ?? null);
    }
    // Normalize protocol-relative + http S3 URLs so stored cover links are https.
    if (artworkUrl && artworkUrl.startsWith('//')) artworkUrl = 'https:' + artworkUrl;
    if (artworkUrl && /^http:\/\/s3[.-]/i.test(artworkUrl)) artworkUrl = artworkUrl.replace(/^http:/i, 'https:');
    if (artworkUrl && !/^https?:|^data:/i.test(artworkUrl)) { artworkUrl = new URL(artworkUrl, location.href).href; }
  } catch { artworkUrl = null; }

  const stores: ScrapedReleaseDetail['stores'] = [];
  document.querySelectorAll('[data-store]').forEach((el) => {
    stores.push({ store: (el as HTMLElement).getAttribute('data-store') || clean(el.textContent), status: (el as HTMLElement).getAttribute('data-status') || 'selected' });
  });

  // "Submitted to X" store icons, DistroKid's authoritative record of which stores this release was
  // delivered to. The store name is the img title (minus the "Submitted to " prefix); a few stores
  // also carry a deep-link to the release on that store via the wrapping <a>.
  const submittedStores: ScrapedReleaseDetail['submittedStores'] = [];
  const seenSubmit = new Set<string>();
  document.querySelectorAll('img.littleStoreIcons[title]').forEach((el) => {
    const title = (el as HTMLElement).getAttribute('title') || '';
    const m = /^\s*submitted to\s+(.+)$/i.exec(title);
    if (!m) return;
    const store = clean(m[1]);
    if (!store || seenSubmit.has(store.toLowerCase())) return;
    seenSubmit.add(store.toLowerCase());
    const anchor = (el as HTMLElement).closest('a');
    const href = anchor ? anchor.getAttribute('href') : null;
    const url = href && /^https?:\/\//i.test(anchor!.href) ? anchor!.href : null;
    submittedStores.push({ store, url });
  });

  // Tracks: prefer a structured table, else any table/list rows carrying an ISRC.
  const tracks: ScrapedReleaseDetail['tracks'] = [];
  const rowsEls = document.querySelectorAll('table[data-field="tracks"] tbody tr, table tbody tr[data-track-id], [data-track-id], .track-row');
  const seen = new Set<string>();
  const pushTrack = (title: string, isrc: string | null, num: number | null, plain: LyricStatus | null, synced: LyricStatus | null, credits: string | null) => {
    const key = `${title}|${isrc ?? ''}`;
    if (!title && !isrc) return;
    if (seen.has(key)) return;
    seen.add(key);
    tracks.push({ title: title || '', isrc, trackNumber: num, plainLyrics: plain, syncedLyrics: synced, credits, featured: [] });
  };
  // DistroKid marks per-track lyric availability in dedicated feature cells and never in the row's
  // main text. We read the STATE (present / processing / empty), never the lyric content itself:
  //   .track-lyrics        → plain lyrics: green circle-check + title "Plain lyrics uploaded" when
  //                          present; a plus/add icon when the slot is empty.
  //   .track-synced-lyrics → synced (time-coded) lyrics: authoritative data-haslyrics /
  //                          data-hasapprovedlyrics attributes, plus the same green-check styling.
  // A missing cell returns null (unknown), never "none", which would falsely assert emptiness.
  const isGreen = (icon: Element | null): boolean =>
    !!icon && (icon.classList.contains('green') || /green/i.test(icon.getAttribute('style') || ''));
  // DistroKid gives each track's PLAIN lyric control a deterministic id `plain-lyrics-track-<n>`
  // (n = 1-based position). We resolve lyric state from THAT control's feature-links container,
  // not from whichever row representation the tracklist loop happened to parse, the compact list
  // rows the loop reads for title/ISRC often do NOT contain the lyric cells, which land in a
  // separate `.song-feature-links` block. Falling back to the row keeps older markup working.
  const lyricScope = (row: Element, num: number | null): Element => {
    if (num != null) {
      const link = document.getElementById(`plain-lyrics-track-${num}`);
      const fl = link && (link.closest('.song-feature-links') || link.closest('.track-row'));
      if (fl) return fl;
    }
    return row.querySelector('.song-feature-links') || row;
  };
  const readPlain = (scope: Element): LyricStatus | null => {
    const cellEl = scope.querySelector('.track-lyrics');
    if (!cellEl) return null;
    const icon = cellEl.querySelector('.state-icon, i');
    const title = (icon?.getAttribute('title') || '').toLowerCase();
    if (isGreen(icon) || /uploaded|saved|approved|added/.test(title)) return 'present';
    if (/process|pending|review|wait/.test(title)) return 'processing';
    return 'none';
  };
  const readSynced = (scope: Element): LyricStatus | null => {
    const cellEl = scope.querySelector('.track-synced-lyrics');
    if (!cellEl) return null;
    const a = cellEl.querySelector('a') || cellEl;
    if ((a.getAttribute('data-hasapprovedlyrics') || '').toLowerCase() === 'true') return 'present';
    if ((a.getAttribute('data-haslyrics') || '').toLowerCase() === 'true') return 'processing';
    const icon = cellEl.querySelector('.state-icon, i');
    const title = (icon?.getAttribute('title') || '').toLowerCase();
    if (isGreen(icon) || /saved|approved|uploaded/.test(title)) return 'present';
    if (/process|pending|review/.test(title)) return 'processing';
    return 'none';
  };
  rowsEls.forEach((tr, i) => {
    const cell = (col: string) => clean(tr.querySelector(`[data-col="${col}"]`)?.textContent);
    const rowText = clean(tr.textContent);
    // DistroKid track row: .track-cell.track-name (a span[title] holds the clean title),
    // .track-cell.track-num, and .track-cell.track-isrc > .isrc-item > .isrc-value.
    const nameEl = tr.querySelector('.track-name');
    const nameFromTitle = clean(nameEl?.querySelector('[title]')?.getAttribute('title'));
    const nameFromText = clean(nameEl?.textContent);
    // DistroKid shows a track's VARIANT ("(Sped Up)", "(Pitched Up)", "(Slowed Down)") in the
    // visible name text, while the [title] attribute holds only the BASE name, so prefer whichever
    // is longer. Otherwise sped-up/pitched versions all collapse to one base title and become
    // indistinguishable (e.g. three tracks all reading "Now").
    const t = cell('title') || (nameFromText.length > nameFromTitle.length ? nameFromText : (nameFromTitle || nameFromText))
      || clean(tr.querySelector('.track-title, td:nth-child(2)')?.textContent);
    let isrc = cell('isrc') || clean(tr.querySelector('.track-isrc .isrc-value, .isrc-value')?.textContent) || null;
    if (isrc && !ISRC.test(isrc)) isrc = null;
    if (!isrc) isrc = ISRC.exec(rowText)?.[0] ?? null;
    const numRaw = cell('num') || clean(tr.querySelector('.track-num')?.textContent) || clean(tr.querySelector('td:first-child')?.textContent);
    const num = /^\d+$/.test(numRaw) ? Number(numRaw) : i + 1;
    const scope = lyricScope(tr, num);
    pushTrack(t, isrc, num, readPlain(scope), readSynced(scope), cell('credits') || null);
  });
  // Last-resort: any elements exposing an ISRC in text, if no table matched.
  if (tracks.length === 0) {
    document.querySelectorAll('li, tr, p, div').forEach((el) => {
      const txt = clean(el.textContent);
      const isrc = ISRC.exec(txt)?.[0];
      if (isrc && txt.length < 200) pushTrack(txt.replace(ISRC, '').replace(/ISRC/i, '').trim() || '', isrc, null, null, null, null);
    });
  }

  // Robust lyric read: DistroKid gives each track's plain-lyric control the id
  // `plain-lyrics-track-<n>` (n = 1-based position). Map every RENDERED control to the track with
  // that number, independent of which row representation the loop parsed for title/ISRC (the two
  // can diverge). Only overrides when a state is actually read, so it can only improve the result.
  document.querySelectorAll('[id^="plain-lyrics-track-"]').forEach((link) => {
    const match = /plain-lyrics-track-(\d+)/.exec(link.id);
    const n = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(n)) return;
    const track = tracks.find((t) => t.trackNumber === n);
    if (!track) return;
    const scope = link.closest('.song-feature-links') || link.closest('.track-row') || link.parentElement;
    if (!scope) return;
    const p = readPlain(scope); if (p) track.plainLyrics = p;
    const s = readSynced(scope); if (s) track.syncedLyrics = s;
  });

  return { title, primaryArtist, upc, releaseDate, uploadDate, label, artworkUrl, stores, submittedStores, tracks };
}

/**
 * Attended DistroKid session (PRD critical rule). The USER logs in themselves in
 * a real browser, the app NEVER sees, types, stores, or transmits the password,
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
   * export), the RAW bytes + suggested filename, so its true format (CSV/XLSX)
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
      // Never fail silently, report exactly what the browser was looking at so
      // the selectors can be tuned to this account's DistroKid layout.
      const diag = await this.pageDiagnostics();
      warnings.push(
        `No releases extracted. The browser was on "${diag.title}" (${diag.url}). ` +
          `Found ${diag.releaseLinks} release links and ${diag.tables} tables. ` +
          `If you were logged in, the catalog page layout differs from the default selectors, share this and it can be tuned.`,
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
