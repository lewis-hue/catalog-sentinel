import { NextRequest, NextResponse } from 'next/server';
import { beginAuthorization } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    return beginAuthorization(request, 'sign-in');
  } catch {
    return NextResponse.json({ error: 'Authentication is unavailable because the server configuration is incomplete.' }, { status: 503 });
  }
}
