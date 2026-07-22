import type { Metadata } from 'next';
import { safeReturnTo } from '@/lib/auth/config';

export const metadata: Metadata = {
  title: 'Sign in — Catalog Sentinel',
  description: 'Sign in to your private Catalog Sentinel workspace.',
};

interface SignInPageProps {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const rawReturnTo = (await searchParams).returnTo;
  const returnTo = safeReturnTo(Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo);
  const loginHref = `/auth/login?${new URLSearchParams({ returnTo }).toString()}`;

  return (
    <main className="auth-entry" id="main-content">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-brand" aria-label="Catalog Sentinel">
          <span className="auth-mark" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="8.5" opacity="0.5" />
              <circle cx="12" cy="12" r="4" />
              <path d="M12 12 18 6" />
            </svg>
          </span>
          <span>Catalog Sentinel</span>
        </div>

        <p className="eyebrow auth-eyebrow">Private catalog workspace</p>
        <h1 id="sign-in-title">Sign in to manage your catalog</h1>
        <p className="auth-copy">
          Review imports, track catalog history, and manage distribution evidence in your organization&rsquo;s isolated workspace.
        </p>

        <a className="btn auth-submit" href={loginHref}>Continue to secure sign-in</a>

        <div className="auth-assurance" aria-label="Sign-in protections">
          <div>
            <strong>Organization access</strong>
            <span>Authentication is handled by your configured identity provider.</span>
          </div>
          <div>
            <strong>Protected session</strong>
            <span>Session tokens stay in HttpOnly cookies and are not exposed to page scripts.</span>
          </div>
          <div>
            <strong>Read-only imports</strong>
            <span>Catalog Sentinel does not collect your distributor password.</span>
          </div>
        </div>

        <p className="auth-help">Need access? Contact your workspace administrator.</p>
      </section>
    </main>
  );
}
