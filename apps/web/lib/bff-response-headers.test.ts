import { describe, expect, it } from 'vitest';
import { forwardedBffResponseHeaders } from './bff-response-headers';

describe('BFF response header allowlist', () => {
  it('forwards the history cursor but not credentials or arbitrary upstream headers', () => {
    const result = forwardedBffResponseHeaders(new Headers({
      'content-type': 'application/json',
      'set-cookie': 'upstream-secret=1',
      'x-internal-debug': 'private',
      'x-sentinel-next-cursor': 'opaque.next',
    }));
    expect(result.get('x-sentinel-next-cursor')).toBe('opaque.next');
    expect(result.get('content-type')).toBe('application/json');
    expect(result.has('set-cookie')).toBe(false);
    expect(result.has('x-internal-debug')).toBe(false);
  });
});
