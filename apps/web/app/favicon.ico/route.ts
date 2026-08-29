import { NextResponse } from 'next/server';

export const dynamic = 'force-static';

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0a0e17"/>
  <circle cx="16" cy="16" r="7" fill="none" stroke="#7c8cff" stroke-width="2.5"/>
  <circle cx="16" cy="16" r="2.6" fill="#2fd8b6"/>
</svg>`;

/** Serve a concrete app-owned favicon response for clients that request the legacy path. */
export function GET(): NextResponse {
  return new NextResponse(ICON, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      'x-content-type-options': 'nosniff',
    },
  });
}
