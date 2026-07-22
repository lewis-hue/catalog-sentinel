import { describe, expect, it } from 'vitest';
import { runtimeSecurityHeaders, steelViewerOrigins } from './security-headers';

describe('Steel viewer origin policy', () => {
  it('requires an exact HTTPS viewer origin in production', () => {
    expect(() => steelViewerOrigins({ NODE_ENV: 'production' })).toThrow(/STEEL_VIEWER_ORIGINS/);
    expect(() => steelViewerOrigins({
      NODE_ENV: 'production',
      STEEL_VIEWER_ORIGINS: 'https://*.steel.dev',
    })).toThrow(/wildcards/i);
    expect(() => steelViewerOrigins({
      NODE_ENV: 'production',
      STEEL_VIEWER_ORIGINS: 'http://app.steel.dev',
    })).toThrow(/HTTPS/i);
  });

  it('uses the same reviewed origins in frame and clipboard policies', () => {
    const headers = runtimeSecurityHeaders({
      NODE_ENV: 'production',
      STEEL_VIEWER_ORIGINS: 'https://app.steel.dev https://viewer.example',
    });
    expect(headers['content-security-policy']).toContain('frame-src \'self\' https://app.steel.dev https://viewer.example');
    expect(headers['permissions-policy']).toContain('"https://app.steel.dev"');
    expect(headers['permissions-policy']).toContain('"https://viewer.example"');
  });
});
