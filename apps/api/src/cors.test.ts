import { describe, it, expect } from 'vitest';
import { resolveCorsOrigin } from './cors';

/**
 * The defect: `Access-Control-Allow-Origin: *` whenever APP_BASE_URL was unset. With bearer auth
 * that lets any website call this API from a logged-in user's browser and read the response -
 * and nothing in the config announced it.
 */
describe('resolveCorsOrigin', () => {
  it('echoes the configured frontend ORIGIN, dropping any path', () => {
    // A trailing path produces a header no browser ever matches, so auth fails with a CORS error
    // that looks nothing like the config typo it is.
    expect(resolveCorsOrigin({ APP_BASE_URL: 'https://app.example.com/dashboard' })).toBe('https://app.example.com');
    expect(resolveCorsOrigin({ APP_BASE_URL: 'https://app.example.com' })).toBe('https://app.example.com');
  });

  it('sends NO header when nothing is configured, fails closed, not open', () => {
    expect(resolveCorsOrigin({})).toBeNull();
    expect(resolveCorsOrigin({ NODE_ENV: 'production' })).toBeNull();
  });

  it('REFUSES a wildcard in production', () => {
    expect(() => resolveCorsOrigin({ NODE_ENV: 'production', APP_BASE_URL: '*' })).toThrow(/not permitted in production/i);
    expect(() => resolveCorsOrigin({ DEPLOYMENT_ENV: 'production', NODE_ENV: 'development', APP_BASE_URL: '*' })).toThrow(/not permitted in production/i);
  });

  it('allows a wildcard in dev only when explicitly requested', () => {
    expect(resolveCorsOrigin({ CORS_ALLOW_ANY_ORIGIN: 'true' })).toBe('*');
    expect(resolveCorsOrigin({ APP_BASE_URL: '*' })).toBe('*');
  });

  it('rejects a malformed APP_BASE_URL loudly rather than emitting a broken header', () => {
    expect(() => resolveCorsOrigin({ APP_BASE_URL: 'app.example.com' })).toThrow(/not a valid absolute URL/i);
  });
});
