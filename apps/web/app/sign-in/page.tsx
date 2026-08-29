import type { Metadata } from 'next';
import { safeReturnTo } from '@/lib/auth/config';

export const metadata: Metadata = {
  title: 'Sign in, Catalog Sentinel',
  description: 'Sign in to your private Catalog Sentinel workspace.',
};

interface SignInPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const rawReturnTo = (await searchParams).returnTo;
  const returnTo = safeReturnTo(Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo);
  const loginHref = `/auth/login?${new URLSearchParams({ returnTo }).toString()}`;
  const registerHref = `/auth/register?${new URLSearchParams({ returnTo }).toString()}`;

  return (
    <main className="auth-entry" id="main-content">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-brand" aria-label="Catalog Sentinel">
          <span>Catalog Sentinel</span>
        </div>

        <p className="eyebrow auth-eyebrow">Private catalog workspace</p>
        <h1 id="sign-in-title">Sign in to manage your catalog</h1>
        <p className="auth-copy">
          Review imports, track catalog history, and manage distribution evidence in your private, isolated workspace.
        </p>

        <a className="btn auth-submit" href={loginHref}>Continue to secure sign-in</a>
        <a className="btn ghost auth-submit" style={{ marginTop: 10 }} href={registerHref}>
          Create an account with Google
        </a>

        <p className="auth-help">Account creation and sign-in are handled through Google and Keycloak.</p>
      </section>
    </main>
  );
}
