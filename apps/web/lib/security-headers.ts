type Environment = Record<string, string | undefined>;

function productionTransport(env: Environment): boolean {
  const explicit = (env.DEPLOYMENT_ENV ?? env.APP_ENV)?.trim().toLowerCase();
  return explicit ? explicit === 'production' : env.NODE_ENV?.trim().toLowerCase() === 'production';
}

function configuredOrigins(name: string, env: Environment, defaults: string[] = [], httpsOnly = false): string[] {
  const configured = (env[name] ?? '').split(/[\s,]+/).filter(Boolean);
  return [...new Set([...defaults, ...configured].map((value) => {
    if (value.includes('*')) throw new Error(`${name} must contain explicit origins, not wildcards.`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} contains an invalid origin.`);
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      throw new Error(`${name} entries must be http(s) origins without paths, credentials, queries, or fragments.`);
    }
    if (httpsOnly && url.protocol !== 'https:') throw new Error(`${name} entries must use HTTPS in production.`);
    return url.origin;
  }))];
}

function originOf(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
  } catch {
    return [];
  }
}

export function steelViewerOrigins(env: Environment = process.env): string[] {
  const production = productionTransport(env);
  const origins = configuredOrigins('STEEL_VIEWER_ORIGINS', env, [], production);
  if (production && origins.length === 0) {
    throw new Error('STEEL_VIEWER_ORIGINS must list at least one exact approved HTTPS origin in production.');
  }
  return origins;
}

/** Runtime CSP: deployment-provided Steel/Keycloak origins are never baked into the image. */
export function runtimeSecurityHeaders(env: Environment = process.env): Record<string, string> {
  const production = productionTransport(env);
  const keycloakOrigins = originOf(env.KEYCLOAK_PUBLIC_BASE_URL || env.KEYCLOAK_BASE_URL);
  const frameOrigins = steelViewerOrigins(env);
  const connectOrigins = configuredOrigins('WEB_CSP_CONNECT_ORIGINS', env, keycloakOrigins, production);
  const formOrigins = configuredOrigins('WEB_CSP_FORM_ACTION_ORIGINS', env, keycloakOrigins, production);
  const imageOrigins = configuredOrigins('WEB_CSP_IMAGE_ORIGINS', env, [], production);
  // Local manual testing must render the exact HTTPS distributor CDN URL captured for each
  // release even though its host is not knowable before the attended scan. Production remains
  // exact-origin-only through WEB_CSP_IMAGE_ORIGINS and never receives this scheme allowance.
  const localImageScheme = production ? '' : ' https:';
  const scriptPolicy = production ? "'self' 'unsafe-inline'" : "'self' 'unsafe-inline' 'unsafe-eval'";
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${scriptPolicy}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob:${localImageScheme}${imageOrigins.length ? ` ${imageOrigins.join(' ')}` : ''}`,
    `connect-src 'self'${connectOrigins.length ? ` ${connectOrigins.join(' ')}` : ''}`,
    `frame-src 'self'${frameOrigins.length ? ` ${frameOrigins.join(' ')}` : ''}`,
    `form-action 'self'${formOrigins.length ? ` ${formOrigins.join(' ')}` : ''}`,
    "worker-src 'self' blob:",
    "media-src 'none'",
    "manifest-src 'self'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  const clipboardOrigins = frameOrigins.map((origin) => `\"${origin}\"`).join(' ');
  const clipboardPolicy = clipboardOrigins ? `self ${clipboardOrigins}` : 'self';
  return {
    'content-security-policy': csp,
    'permissions-policy': `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), clipboard-read=(${clipboardPolicy}), clipboard-write=(${clipboardPolicy})`,
    ...(production ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
}
