import { isProductionEnvironment } from '@sentinel/security';

/**
 * CORS origin resolution.
 *
 * `Access-Control-Allow-Origin: *` was the fallback whenever `APP_BASE_URL` was unset. With bearer
 * auth that is an invitation: any website could call this API from a logged-in user's browser and
 * read the response. It was also silent — nothing in the config said "we are wide open".
 *
 * Rules:
 *  - A configured, valid `APP_BASE_URL` → echo its ORIGIN (scheme+host+port; never a path).
 *  - Nothing configured → NO header. Same-origin deployments don't need one (Compose proxies
 *    `/api` through the web origin), and a missing header fails CLOSED rather than open.
 *  - `*` only outside production, and only if someone asks for it explicitly.
 */
export function resolveCorsOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.APP_BASE_URL ?? '').trim();
  const isProd = isProductionEnvironment(env);

  if (!raw) {
    // A dev convenience, never a production default, and never implicit.
    if (!isProd && (env.CORS_ALLOW_ANY_ORIGIN ?? '').toLowerCase() === 'true') return '*';
    return null;
  }

  if (raw === '*') {
    if (isProd) throw new Error('APP_BASE_URL="*" is not permitted in production: it lets any site call this API with the user\'s credentials. Set the real frontend origin.');
    return '*';
  }

  try {
    // Normalize to an origin. A trailing path in APP_BASE_URL would produce a header no browser
    // ever matches, so auth would fail with a CORS error that looks nothing like a config typo.
    return new URL(raw).origin;
  } catch {
    throw new Error(`APP_BASE_URL="${raw}" is not a valid absolute URL (expected e.g. https://app.example.com).`);
  }
}
