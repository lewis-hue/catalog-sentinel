/**
 * Classify requests before the UI authentication gate runs.
 *
 * Machine-facing endpoints must return their own HTTP status/body and must never be redirected
 * to an HTML sign-in page. Public pages and framework assets are reachable without a session;
 * every other UI route is protected.
 */

const PUBLIC_PAGES = new Set(['/sign-in']);
const PUBLIC_MACHINE_ROUTES = new Set([
  '/health',
  '/openapi.json',
  '/api-docs',
  '/favicon.ico',
  '/icon.svg',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
]);
const PUBLIC_MACHINE_PREFIXES = ['/auth', '/bff', '/api', '/health', '/_next'];

function isAtOrBelow(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}
export type FrontendRouteKind = 'public-page' | 'machine' | 'protected-ui';

export function frontendRouteKind(pathname: string): FrontendRouteKind {
  if (PUBLIC_PAGES.has(pathname)) return 'public-page';
  if (PUBLIC_MACHINE_ROUTES.has(pathname)) return 'machine';
  if (PUBLIC_MACHINE_PREFIXES.some((prefix) => isAtOrBelow(pathname, prefix))) return 'machine';
  return 'protected-ui';
}
