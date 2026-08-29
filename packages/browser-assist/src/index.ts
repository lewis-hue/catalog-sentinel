/**
 * @sentinel/browser-assist, attended, read-only browser automation (Playwright).
 * The user logs into their distributor themselves; the app never handles
 * passwords and never mutates the catalog. Also provides public Audiomack profile
 * reads and HTML→PDF rendering.
 */
export * from './read-only-guard';
export {
  DISTROKID_CATALOG_INDEX_ERROR_CODES,
  DistroKidCatalogIndexError,
  distroKidCatalogIndexErrorCodeFromMessage,
  readDistroKidCatalogIndexFromPage,
  readDistroKidCatalogFromPage,
  scrapeReleaseDetailInPage,
} from './distrokid-attended';
export type {
  DistroKidCatalogIndexErrorCode,
  ScrapedReleaseDetail,
  DistroKidCatalogIndexEntry,
} from './distrokid-attended';
export * from './distrokid';
