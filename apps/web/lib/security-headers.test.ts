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

  it('uses explicit APP_ENV for a locally served production build', () => {
    const headers = runtimeSecurityHeaders({
      NODE_ENV: 'production',
      APP_ENV: 'development',
      KEYCLOAK_PUBLIC_BASE_URL: 'http://localhost:8080',
    });
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['content-security-policy']).toContain('http://localhost:8080');
    expect(headers['content-security-policy']).toContain("img-src 'self' data: blob: https:");
  });

  it('keeps explicit production posture authoritative over NODE_ENV', () => {
    expect(() => steelViewerOrigins({
      NODE_ENV: 'development',
      APP_ENV: 'production',
    })).toThrow(/STEEL_VIEWER_ORIGINS/);
  });

  it('allows only configured artwork origins in production', () => {
    const headers = runtimeSecurityHeaders({
      APP_ENV: 'production',
      STEEL_VIEWER_ORIGINS: 'https://app.steel.dev',
      WEB_CSP_IMAGE_ORIGINS: 'https://artwork.example',
    });
    const csp = headers['content-security-policy'];
    expect(csp).toContain("img-src 'self' data: blob: https://artwork.example");
    expect(csp).not.toContain('blob: https:;');
  });
});
