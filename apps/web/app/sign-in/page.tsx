import type { Metadata } from 'next';
import Link from 'next/link';
import { safeReturnTo } from '@/lib/auth/config';
import { GoogleG } from '../_components/GoogleG';

export const metadata: Metadata = {
  title: 'Sign in · Catalog Sentinel',
  description: 'Sign in to your private Catalog Sentinel workspace.',
};

interface SignInPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const rawReturnTo = (await searchParams).returnTo;
  const returnTo = safeReturnTo(Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo);
  const loginHref = `/auth/login?${new URLSearchParams({ returnTo }).toString()}`;
  const signUpHref = returnTo && returnTo !== '/'
    ? `/sign-up?${new URLSearchParams({ returnTo }).toString()}`
    : '/sign-up';

  return (
    <main className="auth-entry" id="main-content">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <Link href="/" className="auth-brand" aria-label="Catalog Sentinel home">
          <span className="auth-brand-mark" aria-hidden>CS</span>
          <span>Catalog Sentinel</span>
        </Link>

        <p className="eyebrow auth-eyebrow">Private catalog workspace</p>
        <h1 id="sign-in-title">Welcome back</h1>
        <p className="auth-copy">
          Sign in to review imports, track catalog history, and manage distribution evidence in your isolated workspace.
        </p>

        <a className="google-btn" href={loginHref}>
          <GoogleG />
          <span>Continue with Google</span>
        </a>

        <p className="auth-alt">
          New to Catalog Sentinel? <Link href={signUpHref}>Create an account</Link>
        </p>

        <p className="auth-help">Sign-in is handled securely through Google and Keycloak. We never see your password.</p>
      </section>
    </main>
  );
}
