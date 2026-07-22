import { NextResponse } from 'next/server';

/** Public gateway health: the web process and its private API dependency must both answer. */
export async function GET(): Promise<NextResponse> {
  const target = process.env.API_PROXY_TARGET?.trim();
  if (!target) {
    return NextResponse.json(
      { status: 'unavailable', service: 'artist-catalog-sentinel-web' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  try {
    const response = await fetch(new URL('/health/ready', target), {
      cache: 'no-store',
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('API readiness failed');
    return NextResponse.json(
      { status: 'ok', service: 'artist-catalog-sentinel-web' },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'unavailable', service: 'artist-catalog-sentinel-web' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
