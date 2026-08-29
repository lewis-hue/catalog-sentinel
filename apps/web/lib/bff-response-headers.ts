const RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-disposition',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'vary',
  // Opaque principal-bound cursor used by the audit-history Load more control.
  'x-sentinel-next-cursor',
  // Lets the browser discard a stale, non-authoritative organization selector. The value contains
  // no tenant identifier or authorization detail.
  'x-sentinel-organization-selection',
]);

/** Copy only explicitly safe upstream response metadata through the browser-facing gateway. */
export function forwardedBffResponseHeaders(upstream: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of upstream) {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) forwarded.set(name, value);
  }
  return forwarded;
}
