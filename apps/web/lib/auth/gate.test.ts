import { describe, expect, it } from 'vitest';
import { frontendRouteKind } from './gate';

describe('frontend authentication route gate', () => {
  it('keeps the deliberate sign-in entry public', () => {
    expect(frontendRouteKind('/sign-in')).toBe('public-page');
  });

  it.each([
    '/auth/login',
    '/auth/callback',
    '/auth/logout',
    '/auth/session',
    '/bff/searches',
    '/api/status',
    '/health',
    '/health/ready',
    '/_next/static/chunks/app.js',
    '/icon.svg',
  ])('keeps machine or framework route %s out of HTML redirects', (pathname) => {
    expect(frontendRouteKind(pathname)).toBe('machine');
  });

  it.each(['/', '/catalog', '/history/scan-1', '/connect', '/review'])(
    'protects UI route %s',
    (pathname) => {
      expect(frontendRouteKind(pathname)).toBe('protected-ui');
    },
  );

  it('uses path-segment boundaries instead of trusting deceptive prefixes', () => {
    expect(frontendRouteKind('/apiary')).toBe('protected-ui');
    expect(frontendRouteKind('/authentication')).toBe('protected-ui');
    expect(frontendRouteKind('/healthcare')).toBe('protected-ui');
  });
});
