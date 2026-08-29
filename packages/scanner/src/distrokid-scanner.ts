import type { Page } from 'playwright';
import {
  PageShapeError,
  type CreditsStatusSnapshot,
  type CreditsStatusValue,
  type DistributorReleaseSnapshot,
  type DistributorScanner,
  type DistributorTrackSnapshot,
  type LoginValidationResult,
  type LyricsStatusSnapshot,
  type LyricsStatusValue,
  type Provenance,
  type ReleaseIndexItem,
  type ScanContext,
  type StoreStatus,
  type StoreStatusSnapshot,
  type TrackIndexItem,
} from './types';

const STORE_STATUS_SET = new Set<StoreStatus>([
  'SELECTED', 'NOT_SELECTED', 'UNKNOWN', 'DELIVERED', 'PROCESSING', 'FAILED', 'REMOVED', 'TAKEDOWN', 'NEEDS_ACTION', 'CURATED_OR_NOT_GUARANTEED',
]);

function toStoreStatus(raw: string): StoreStatus {
  const v = raw.trim().toUpperCase().replace(/\s+/g, '_');
  return STORE_STATUS_SET.has(v as StoreStatus) ? (v as StoreStatus) : 'UNKNOWN';
}

function toLyrics(text: string): LyricsStatusValue {
  const v = text.trim().toLowerCase();
  if (v === '' || v === 'missing' || v === 'none') return 'MISSING';
  if (v.includes('reject')) return 'REJECTED';
  if (v.includes('approv')) return 'APPROVED';
  if (v.includes('submit')) return 'SUBMITTED';
  return 'UNKNOWN';
}

function toSynced(text: string): LyricsStatusValue {
  const v = text.trim().toLowerCase();
  if (v === '' || v === 'missing' || v === 'none') return 'SYNCED_MISSING';
  if (v.includes('submit') || v.includes('approv')) return 'SYNCED_SUBMITTED';
  return 'UNKNOWN';
}

function toCredits(text: string): CreditsStatusValue {
  const v = text.trim().toLowerCase();
  if (v === '' || v === 'missing' || v === 'none') return 'MISSING';
  if (v.includes('display')) return 'DISPLAYED';
  if (v.includes('submit')) return 'SUBMITTED';
  return 'UNKNOWN';
}

interface RawRelease {
  title: string | null;
  artist: string | null;
  upc: string | null;
  releaseDate: string | null;
  releaseId: string | null;
  stores: Array<{ store: string; status: string }>;
  tracks: Array<{ trackId: string | null; num: string; title: string; isrc: string; lyrics: string; synced: string; credits: string; trackUrl: string | null }>;
}

/**
 * DistroKid deep-scan adapter. Owns DistroKid-specific, resilient locators
 * (semantic data-fields / roles) and extracts ONLY catalog-management metadata -
 * never payment/tax/bank/personal data. When a field is absent it records the
 * value as null/UNKNOWN with lower confidence rather than guessing. Unknown page
 * shapes raise PageShapeError so the worker files a maintenance issue.
 *
 * The selectors here match the DistroKid fixture pages. TODO(prod): tune the
 * locators to DistroKid's live "My Music" / release pages behind a legal review.
 */
export class DistroKidDistributorAdapter implements DistributorScanner {
  readonly distributor = 'distrokid' as const;

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  private prov(category: string, confidence: number): Provenance {
    return { sourceUrlCategory: category, scannedAt: this.nowIso(), confidence };
  }

  async validateLoggedIn(page: Page): Promise<LoginValidationResult> {
    // A password field means the login page is showing → not authenticated.
    const hasPasswordField = await page.locator('input[type="password"]').count();
    if (hasPasswordField > 0) return { loggedIn: false, reason: 'Login form present.' };
    // Account navigation (Sign out / My Music) means authenticated.
    const hasAccountNav = await page
      .locator('#signOut, nav[aria-label="Account"] a[href*="catalog-index"], a:has-text("My Music")')
      .count();
    if (hasAccountNav > 0) return { loggedIn: true };
    return { loggedIn: false, reason: 'No authenticated account surface detected.' };
  }

  async discoverCatalogIndex(page: Page, ctx: ScanContext): Promise<ReleaseIndexItem[]> {
    await page.goto(`${ctx.baseUrl}/catalog-index.html`, { waitUntil: 'domcontentloaded' });
    const rows = page.locator('.release-row');
    if ((await rows.count()) === 0) throw new PageShapeError('catalog-index', 'No release rows found on the catalog index.');
    const items = await rows.evaluateAll((els) =>
      els.map((el) => {
        const link = el.querySelector('a.release-link') as HTMLAnchorElement | null;
        return {
          releaseId: el.getAttribute('data-release-id'),
          title: (link?.textContent || '').trim(),
          artist: (el.querySelector('.release-artist')?.textContent || '').trim() || null,
          href: link?.getAttribute('href') || '',
        };
      }),
    );
    return items
      .filter((i) => i.href)
      .map((i) => ({ releaseId: i.releaseId, title: i.title, artist: i.artist, url: new URL(i.href, `${ctx.baseUrl}/`).href }));
  }

  async scanRelease(page: Page, release: ReleaseIndexItem, ctx: ScanContext): Promise<DistributorReleaseSnapshot> {
    // Rate limit, never hammer the distributor.
    if (ctx.minDelayMs > 0) await page.waitForTimeout(ctx.minDelayMs);
    await page.goto(release.url, { waitUntil: 'domcontentloaded' });
    if ((await page.locator('[data-page="release-detail"]').count()) === 0) {
      throw new PageShapeError('release-detail', `Unrecognized release page shape at ${release.url}`);
    }

    const raw = (await page.evaluate(() => {
      const text = (sel: string) => (document.querySelector(sel)?.textContent || '').trim() || null;
      const stores = Array.from(document.querySelectorAll('[data-field="stores"] li[data-store]')).map((li) => ({
        store: li.getAttribute('data-store') || '',
        status: li.getAttribute('data-status') || '',
      }));
      const tracks = Array.from(document.querySelectorAll('table[data-field="tracks"] tbody tr')).map((tr) => {
        const cell = (col: string) => (tr.querySelector(`[data-col="${col}"]`)?.textContent || '').trim();
        const link = tr.querySelector('[data-col="title"] a') as HTMLAnchorElement | null;
        return {
          trackId: tr.getAttribute('data-track-id'),
          num: cell('num'),
          title: cell('title'),
          isrc: cell('isrc'),
          lyrics: cell('lyrics'),
          synced: cell('synced'),
          credits: cell('credits'),
          trackUrl: link?.getAttribute('href') || null,
        };
      });
      return {
        title: text('[data-field="release-title"]'),
        artist: text('[data-field="release-artist"]'),
        upc: text('[data-field="upc"]'),
        releaseDate: text('[data-field="release-date"]'),
        releaseId: text('[data-field="release-id"]'),
        stores,
        tracks,
      };
    })) as RawRelease;

    const warnings: string[] = [];
    if (!raw.upc) warnings.push('UPC not visible on the release page.');

    const stores: StoreStatusSnapshot[] = raw.stores.map((s) => ({
      store: s.store,
      status: toStoreStatus(s.status),
      provenance: this.prov('distrokid:release-detail#stores', s.status ? 0.97 : 0.5),
    }));

    const tracks: DistributorTrackSnapshot[] = raw.tracks.map((t) => {
      const trackNumber = Number.isFinite(Number(t.num)) ? Number(t.num) : null;
      const lyrics: LyricsStatusSnapshot = {
        plain: toLyrics(t.lyrics),
        synced: toSynced(t.synced),
        provenance: this.prov('distrokid:release-detail#track-lyrics', t.lyrics || t.synced ? 0.95 : 0.5),
      };
      const credits: CreditsStatusSnapshot = {
        status: toCredits(t.credits),
        provenance: this.prov('distrokid:release-detail#track-credits', t.credits ? 0.95 : 0.5),
      };
      return {
        trackId: t.trackId,
        trackUrl: t.trackUrl ? new URL(t.trackUrl, release.url).href : null,
        title: t.title,
        trackNumber,
        isrc: t.isrc || null,
        lyrics,
        credits,
        provenance: this.prov('distrokid:release-detail#track', t.title ? 0.98 : 0.5),
        rawSource: { ...t },
      };
    });

    ctx.onEvent?.({ type: 'release_found', at: this.nowIso(), releaseTitle: raw.title ?? release.title });
    for (const t of tracks) ctx.onEvent?.({ type: 'track_found', at: this.nowIso(), trackTitle: t.title });

    return {
      releaseId: raw.releaseId ?? release.releaseId,
      releaseUrl: release.url,
      title: raw.title ?? release.title,
      artist: raw.artist ?? release.artist,
      upc: raw.upc,
      releaseDate: raw.releaseDate,
      stores,
      tracks,
      warnings,
      provenance: this.prov('distrokid:release-detail', 0.98),
    };
  }

  async scanStoreStatus(page: Page, release: ReleaseIndexItem, ctx: ScanContext): Promise<StoreStatusSnapshot[]> {
    const snap = await this.scanRelease(page, release, ctx);
    return snap.stores;
  }

  async scanLyricsStatus(page: Page, track: TrackIndexItem, _ctx: ScanContext): Promise<LyricsStatusSnapshot> {
    const row = page.locator(`tr[data-track-id="${track.trackId ?? ''}"]`);
    if ((await row.count()) === 0) {
      return { plain: 'UNKNOWN', synced: 'UNKNOWN', provenance: this.prov('distrokid:track-lyrics', 0.3) };
    }
    const lyrics = (await row.locator('[data-col="lyrics"]').textContent()) ?? '';
    const synced = (await row.locator('[data-col="synced"]').textContent()) ?? '';
    return { plain: toLyrics(lyrics), synced: toSynced(synced), provenance: this.prov('distrokid:track-lyrics', 0.95) };
  }

  async scanCreditsStatus(page: Page, track: TrackIndexItem, _ctx: ScanContext): Promise<CreditsStatusSnapshot> {
    const row = page.locator(`tr[data-track-id="${track.trackId ?? ''}"]`);
    if ((await row.count()) === 0) return { status: 'UNKNOWN', provenance: this.prov('distrokid:track-credits', 0.3) };
    const credits = (await row.locator('[data-col="credits"]').textContent()) ?? '';
    return { status: toCredits(credits), provenance: this.prov('distrokid:track-credits', 0.95) };
  }
}
