/**
 * @sentinel/search-store — scan/search persistence, shared by the API and the workers.
 *
 * It lives in a package because BOTH applications legitimately need it: the API serves scan
 * records to users, the workers write results into them. Previously it lived in `apps/worker`, so
 * the API imported the worker application to reach it — dragging Playwright, BullMQ and the whole
 * browser runtime into an HTTP server that needs none of them, and making "which app owns this?"
 * unanswerable.
 *
 * Dependency rule: this package knows about storage and nothing else. No queue driver, no browser,
 * no HTTP framework, and never an app.
 */
export * from './search-store';
export * from './manual-review';
export * from './postgres-search-store';
export * from './tiered-search-store';
export * from './build-search-store';
export * from './pg-client';
export * from './redis-client';
