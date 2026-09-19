import type { Metadata } from 'next';
import Link from 'next/link';
import { safeReturnTo } from '@/lib/auth/config';
import { GoogleG } from '../_components/GoogleG';

export const metadata: Metadata = {
  title: 'Create your account · Catalog Sentinel',
  description: 'Create your private Catalog Sentinel workspace with Google.',
};

interface SignUpPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}
export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const rawReturnTo = (await searchParams).returnTo;
  const returnTo = safeReturnTo(Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo);
  const registerHref = `/auth/register?${new URLSearchParams({ returnTo }).toString()}`;
  const signInHref = returnTo && returnTo !== '/'
    ? `/sign-in?${new URLSearchParams({ returnTo }).toString()}`
    : '/sign-in';

  return (
    <main className="auth-entry" id="main-content">
      <section className="auth-card" aria-labelledby="sign-up-title">
        <Link href="/" className="auth-brand" aria-label="Catalog Sentinel home">
          <span className="auth-brand-mark" aria-hidden>CS</span>
          <span>Catalog Sentinel</span>
        </Link>

        <p className="eyebrow auth-eyebrow">Start in a minute</p>
        <h1 id="sign-up-title">Create your account</h1>
        <p className="auth-copy">
          Connect your catalog and see where every release is live across the stores, with distributor-ready evidence for the gaps.
        </p>

        <a className="google-btn" href={registerHref}>
          <GoogleG />
          <span>Sign up with Google</span>
        </a>

        <ul className="auth-points" aria-label="What you get">
          <li>Store-presence checks across 25+ platforms</li>
          <li>Missing-lyrics and wrong-profile detection</li>
          <li>A private, isolated workspace</li>
        </ul>

        <p className="auth-alt">
          Already have an account? <Link href={signInHref}>Sign in</Link>
        </p>

        <p className="auth-help">Account creation is handled securely through Google and Keycloak. We never see your password.</p>
      </section>
    </main>
  );
}
