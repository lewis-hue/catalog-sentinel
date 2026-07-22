import { createHmac, randomBytes } from 'node:crypto';

/**
 * Minimal OAuth 1.0a (RFC 5849) HMAC-SHA1 request signer — no dependency.
 * Used for APIs that require signed requests (e.g. the Audiomack Data API).
 * Supports 2-legged (consumer key/secret only) and 3-legged (with a user token).
 */
export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
}

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
export function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** The OAuth 1.0a signature base string — the canonical artifact that is HMAC'd. */
export function oauth1BaseString(method: string, baseUrl: string, allParams: Record<string, string>): string {
  const paramString = Object.keys(allParams)
    .map((k) => [rfc3986(k), rfc3986(allParams[k] ?? '')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join('&');
}

/**
 * Build the OAuth `Authorization` header for a request. `queryParams` must include
 * every query-string parameter that is actually sent on the URL — they participate
 * in the signature base string.
 */
export function oauth1Header(
  method: string,
  baseUrl: string,
  queryParams: Record<string, string>,
  creds: OAuth1Credentials,
  nonceFn: () => string = () => randomBytes(16).toString('hex'),
  timestampFn: () => number = () => Math.floor(Date.now() / 1000),
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonceFn(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestampFn()),
    oauth_version: '1.0',
  };
  if (creds.token) oauthParams.oauth_token = creds.token;

  const baseString = oauth1BaseString(method, baseUrl, { ...queryParams, ...oauthParams });
  const signingKey = `${rfc3986(creds.consumerSecret)}&${rfc3986(creds.tokenSecret ?? '')}`;
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map((k) => `${rfc3986(k)}="${rfc3986(headerParams[k] ?? '')}"`)
    .join(', ');
}
