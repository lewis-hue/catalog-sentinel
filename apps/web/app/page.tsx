import { isAuthenticated } from '@/lib/auth/is-authed';
import { Landing } from './_components/Landing';
import { Overview } from './Overview';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Signed-out visitors get the public landing; signed-in users get the dashboard (wrapped in the
  // app shell by AppShell, which is passed the same session flag).
  const authed = await isAuthenticated();
  return authed ? <Overview /> : <Landing />;
}
