import type { Page, Response } from 'playwright';
import {
  scrapeReleaseDetailInPage,
  ESBUILD_NAME_SHIM,
  type ScrapedReleaseDetail,
} from '../distrokid-attended';
import {
  present,
  notCaptured,
  type CanonicalDistributorRelease,
  type CanonicalDistributorTrack,
  type LyricStatus,
  type MetadataField,
} from './metadata-model';

/**
 * DistroKid album-page reader (Tier-5 DOM fallback for the network-first extractor).
 *
 * DistroKid renders per-release metadata (UPC, per-track ISRC, artwork) as SERVER HTML, it does
 * not expose a per-release JSON endpoint the passive network capture can observe. The pipeline's
 * `NetworkFirstExtractor` already supports a `readDom` fallback seam; this module supplies the
 * DistroKid implementation of it, reusing the battle-tested in-page scraper (`scrapeReleaseDetail-
 * InPage`) that the legacy attended path uses. Without this wired in, every DistroKid release
 * falls through to TIMEOUT because there is no JSON response to match.
 *
 * Read-only: this only reads the already-rendered page; it never submits a form or mutates state.
 */

/** Parser identity stamped on every DOM-sourced field, so a stored value is traceable to the
 *  reader version that produced it (mirrors the network parser's versioning). */
export const DISTROKID_DOM_PARSER_VERSION = 'distrokid-dom-v1';

function domField(value: string | null | undefined): MetadataField<string> {
  const v = (value ?? '').trim();
  return v
    ? present<string>(v, 'DOM', DISTROKID_DOM_PARSER_VERSION)
    // A DOM miss is OUR failure to read, not proof the distributor has no value. Never claim
    // ABSENT_AT_SOURCE from a scrape, that would falsely assert completeness.
    : notCaptured<string>('NOT_CAPTURED', 'DOM', DISTROKID_DOM_PARSER_VERSION);
}

/**
 * Convert the DOM-scraped shape into the canonical model the extractor persists. Pure and
 * independently unit-tested (no browser needed). `distributorReleaseId` is left 'unknown' on
 * purpose: `NetworkFirstExtractor.complete()` substitutes the catalog-index `ref.releaseId`.
 */
export function scrapedReleaseToCanonical(d: ScrapedReleaseDetail): CanonicalDistributorRelease {
  const tracks: CanonicalDistributorTrack[] = d.tracks.map((t, i) => ({
    title: (t.title ?? '').trim(),
    isrc: domField(t.isrc),
    trackNumber: t.trackNumber != null ? t.trackNumber : i + 1,
    // A missing cell reads as `unknown` (never `none`), we never assert the artist omitted lyrics
    // just because the scrape could not see the state.
    lyrics: { plain: t.plainLyrics ?? 'unknown', synced: t.syncedLyrics ?? 'unknown' },
  }));
  return {
    distributorReleaseId: 'unknown',
    title: (d.title ?? '').trim(),
    ...(d.primaryArtist && d.primaryArtist.trim() ? { primaryArtist: d.primaryArtist.trim() } : {}),
    upc: domField(d.upc),
    artworkUrl: domField(d.artworkUrl),
    releaseDate: domField(d.releaseDate),
    ...(d.uploadDate ? { uploadDate: domField(d.uploadDate) } : {}),
    ...(d.label ? { label: domField(d.label) } : {}),
    ...(d.submittedStores?.length ? { submittedStores: d.submittedStores } : {}),
    tracks,
  };
}

/**
 * Apply the esbuild `__name` shim so `page.evaluate(scrapeReleaseDetailInPage)` does not throw
 * "__name is not defined" in the bundled worker. MUST be called on the page BEFORE the extractor
 * navigates (init scripts run on every subsequent navigation). Idempotent.
 */
export async function prepareDistroKidAlbumPage(page: Page): Promise<void> {
  await page.addInitScript({ content: ESBUILD_NAME_SHIM }).catch(() => undefined);
  // SPEED: DistroKid's per-release metadata (UPC/ISRC/tracks, and the og:image cover URL) all live
  // in the SERVER HTML, so images/media/fonts/stylesheets are pure weight that make a heavy album
  // page take ~30s to load. Abort those resource types at the page level (fall back to the
  // read-only guard for everything else) so each page commits + renders in ~1-2s. Never blocks the
  // document, scripts, or data requests, and the DOM text the scraper reads is unaffected.
  await page
    .route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        return route.abort('blockedbyclient');
      }
      return route.fallback();
    })
    .catch(() => undefined);
}

/**
 * Force DistroKid's lazy-rendered tracklist + per-track feature cells (lyrics/ISRC/credits) into
 * the DOM by scrolling until the row/lyric-control count stabilises. Best-effort, bounded, and
 * never throws, a page without a lazy list simply reaches a stable count immediately.
 */
export async function revealFullTracklist(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      const controls = (): number => document.querySelectorAll('[id^="plain-lyrics-track-"]').length;
      // STEP-scroll top→bottom so each lazily-rendered row enters the viewport and its lyric control
      // mounts. A single jump to the bottom skips the middle rows' intersection triggers (that only
      // rendered ~1 control per release). We do NOT scroll back to the top afterwards, that can
      // un-mount virtualised rows before the reader runs. Hard-bounded so a large catalogue cannot
      // blow the wall-clock deadline.
      let prev = -1;
      let stagnant = 0;
      for (let pass = 0; pass < 3 && stagnant < 1; pass += 1) {
        const steps = 16;
        const height = document.documentElement.scrollHeight;
        for (let i = 1; i <= steps; i += 1) {
          window.scrollTo(0, Math.round((height * i) / steps));
          await sleep(70);
        }
        await sleep(180);
        const c = controls();
        if (c <= prev) stagnant += 1;
        else stagnant = 0;
        prev = c;
      }
    })
    .catch(() => undefined);
}

/**
 * Tier-5 DOM reader for a DistroKid album page. The page is already navigated to the release by
 * the extractor; here we wait (event-based, bounded) for the metadata to render, then scrape it.
 * Returns null when nothing usable rendered, so the extractor reports TIMEOUT rather than a
 * misleading empty result.
 */
export async function readDistroKidAlbumDomFromPage(page: Page): Promise<CanonicalDistributorRelease | null> {
  // Event-based wait for the release DATA (a UPC or an ISRC in the page text), never a fixed sleep.
  await page
    .waitForFunction(
      () => {
        const t = (document.body && document.body.innerText) || '';
        return /\b\d{12,13}\b/.test(t) || /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/.test(t);
      },
      undefined,
      { timeout: 8_000, polling: 400 },
    )
    .catch(() => undefined);
  // Lyric feature-cells are NOT read here: DistroKid lazy/virtual-renders them, and measurement
  // proved they will not mount inside this fast, parallel, deadline-bound metadata read (only ~1 of
  // N per release), attempting it only slowed the scrape and broke the deadline. Lyric state is
  // captured separately (see the dedicated lyric pass) or via the distributor export. This read
  // stays fast and reliable for the catalogue metadata (UPC/ISRC/tracks/artwork).
  const scraped = await page.evaluate(scrapeReleaseDetailInPage).catch(() => null);
  if (!scraped) return null;
  const release = scrapedReleaseToCanonical(scraped);
  if (release.tracks.length === 0 && release.upc.status !== 'PRESENT') return null;
  return release;
}

/**
 * DEDICATED LYRIC PASS reader for ONE album. Runs OUTSIDE the parallel metadata pool, on a freshly
 * and fully navigated page, with an unhurried incremental reveal, the only conditions under which
 * DistroKid's lazy/virtual-rendered lyric controls reliably mount (proven by the ground-truth
 * capture). Returns per-track-number plain/synced availability, or null if nothing usable rendered.
 * Read-only: it navigates and reads, never mutates.
 */
export async function readAlbumLyricsFromPage(page: Page, dashboardUrl: string): Promise<Map<number, { plain: LyricStatus; synced: LyricStatus }> | null> {
  await page.goto(dashboardUrl, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
  // Wait for either an ISRC (data rendered) or a lyric control to appear before revealing.
  await page
    .waitForFunction(
      () => {
        const t = (document.body && document.body.innerText) || '';
        return /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/.test(t) || document.querySelector('[id^="plain-lyrics-track-"]') != null;
      },
      undefined,
      { timeout: 8_000, polling: 400 },
    )
    .catch(() => undefined);
  await revealFullTracklist(page);
  const scraped = await page.evaluate(scrapeReleaseDetailInPage).catch(() => null);
  if (!scraped) return null;
  const byNumber = new Map<number, { plain: LyricStatus; synced: LyricStatus }>();
  scraped.tracks.forEach((t, i) => {
    if (!t.plainLyrics && !t.syncedLyrics) return; // nothing read for this track
    byNumber.set(t.trackNumber ?? i + 1, { plain: t.plainLyrics ?? 'unknown', synced: t.syncedLyrics ?? 'unknown' });
  });
  return byNumber.size ? byNumber : null;
}

/**
 * DIAGNOSTIC ONLY, gated by `DISTROKID_ALBUM_CAPTURE_DIR`, off by default.
 *
 * Writes, for one already-authorized album page, the ground truth needed to build/verify the DOM
 * reader against DistroKid's CURRENT markup:
 *   - the rendered HTML (`album-<label>.html`),
 *   - inline <script> contents so we can tell embedded-JSON from pure-DOM (`.scripts.json`),
 *   - a response manifest of sanitized URL + content-type + status, NEVER bodies, proving
 *     whether any JSON endpoint exists (`.manifest.json`).
 *
 * Compliance: album/release pages only (release data, never billing/tax/payment/banking/address/
 * account-security/profile pages); a local dev artifact on the operator's own machine; no external
 * egress; query values are stripped from manifest URLs. The caller must not point this at anything
 * but a release page, and must redact any token/personal fields before deriving a committed fixture.
 */
export async function captureDistroKidAlbumPage(page: Page, dir: string, label: string, url: string): Promise<void> {
  const finalize = beginDistroKidPageCapture(page, dir, `album-${label}`);
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
    await page
      .waitForFunction(
        () => {
          const t = (document.body && document.body.innerText) || '';
          return /\b\d{12,13}\b/.test(t) || /\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/.test(t);
        },
        undefined,
        { timeout: 8_000, polling: 400 },
      )
      .catch(() => undefined);
    // Reveal the whole lazy tracklist so the captured HTML is COMPLETE ground truth (every row + its
    // lyric feature-cells), not just the first few rows that render before the first ISRC appears.
    await revealFullTracklist(page);
  } finally {
    await finalize();
  }
}

/**
 * Start capturing an ALREADY-navigated DistroKid page (e.g. the /mymusic catalog index, whose
 * navigation + lazy-load happens inside the index scraper). Attaches a response listener up front
 * so pagination XHRs are recorded, and returns a `finalize()` that writes the rendered HTML, inline
 * scripts, and the sanitized response manifest, then detaches. Same compliance rules as
 * `captureDistroKidAlbumPage`: the operator's own catalog pages, a local dev artifact, no egress,
 * bodies never written, query values dropped.
 */
export function beginDistroKidPageCapture(page: Page, dir: string, label: string): () => Promise<void> {
  const manifest: Array<{ url: string; contentType: string; status: number }> = [];
  const onResponse = (res: Response): void => {
    try {
      const u = new URL(res.url());
      manifest.push({
        url: `${u.protocol}//${u.host}${u.pathname}`, // path only, query values deliberately dropped
        contentType: (res.headers()['content-type'] ?? '').split(';')[0]!.trim(),
        status: res.status(),
      });
    } catch { /* ignore unparseable response URLs */ }
  };
  page.on('response', onResponse);
  let finalized = false;
  return async () => {
    if (finalized) return;
    finalized = true;
    page.off('response', onResponse);
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const html = await page.content().catch(() => '');
    const scripts = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('script')).map((s) => ({
          type: s.getAttribute('type') ?? '',
          id: s.getAttribute('id') ?? '',
          src: s.getAttribute('src') ?? '',
          body: s.getAttribute('src') ? '' : (s.textContent ?? '').slice(0, 200_000),
        })),
      )
      .catch(() => [] as unknown[]);
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    await writeFile(join(dir, `${label}.html`), html, 'utf8').catch(() => undefined);
    await writeFile(join(dir, `${label}.scripts.json`), JSON.stringify(scripts, null, 2), 'utf8').catch(() => undefined);
    await writeFile(join(dir, `${label}.manifest.json`), JSON.stringify(manifest, null, 2), 'utf8').catch(() => undefined);
  };
}
