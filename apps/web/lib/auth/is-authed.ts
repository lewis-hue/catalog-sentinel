import { cookies } from 'next/headers';
import { AUTH_COOKIES } from './config';

/**
 * Server-side session presence check for public/hybrid routes (the `/` landing vs dashboard split).
 * Mirrors the middleware's rule: a session exists when an access or refresh cookie is present. This
 * only gates which UI is shown; the API still validates the token on every request.
 */
export async function isAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  return Boolean(jar.get(AUTH_COOKIES.access)?.value || jar.get(AUTH_COOKIES.refresh)?.value);
}
