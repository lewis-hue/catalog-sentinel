import { NextRequest, NextResponse } from 'next/server';
import { beginAuthorization } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Create an account through the configured Google Keycloak broker.
 *
 * The broker alias is fixed inside the server authorization helper; query
 * parameters cannot select an arbitrary identity provider.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return beginAuthorization(request, 'google-sign-up');
  } catch {
    return NextResponse.json(
      { error: 'Account creation is unavailable because the server configuration is incomplete.' },
      { status: 503 },
    );
  }
}
