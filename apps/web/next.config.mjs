import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_SECURITY_HEADERS = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Origin-Agent-Cluster', value: '?1' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce Next's supported, file-traced production server. The trace root is
  // the monorepo root because server components import workspace packages.
  output: 'standalone',
  outputFileTracingRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  // The application renders only ordinary, already-hosted artwork URLs and never uses
  // `next/image`. Disable the optimizer endpoint so untrusted image bytes are not decoded by
  // the web process (and the optional native Sharp path is unreachable at runtime).
  images: { unoptimized: true },
  // Compile the workspace TS packages (they export raw src, no build step).
  transpilePackages: ['@sentinel/shared-ui'],
  async headers() {
    return [
      { source: '/:path*', headers: BASE_SECURITY_HEADERS },
      {
        source: '/auth/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
        ],
      },
      {
        source: '/bff/:path*',
        headers: [{ key: 'Cache-Control', value: 'private, no-store, max-age=0' }],
      },
    ];
  },
  // Browser API traffic goes through /bff so bearer tokens remain in HttpOnly cookies. Only
  // non-credentialed probes and explicitly published API documentation use static rewrites.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET || 'http://localhost:4000';
    return [
      // Health probes: the gateway forwards /health/* to the API (k8s can also probe the
      // API service directly). Keeps liveness/readiness reachable through the web origin.
      { source: '/health/:path*', destination: `${target}/health/:path*` },
      { source: '/openapi.json', destination: `${target}/openapi.json` },
      { source: '/api-docs', destination: `${target}/docs` },
    ];
  },
};

export default nextConfig;
