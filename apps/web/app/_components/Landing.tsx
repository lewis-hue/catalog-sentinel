import Link from 'next/link';

const FEATURES = [
  { k: 'Stores', title: 'Store presence, verified', body: 'Every track checked across 25+ platforms, so you catch the releases that quietly never went live.' },
  { k: 'Lyrics', title: 'Missing lyrics, found', body: 'See which songs are missing lyrics on the stores that display them, before your listeners do.' },
  { k: 'Identity', title: 'Wrong-profile detection', body: 'Catch releases delivered to a namesake or the wrong artist profile, with the ISRC evidence to fix it.' },
];

const STEPS = [
  { title: 'Connect your distributor', body: 'Link your catalog through a secure, attended session. Read-only, and we never store your password.' },
  { title: 'We scan the stores', body: 'Sentinel reconciles your releases against each store catalog and flags every gap with a confidence score.' },
  { title: 'You get the evidence', body: 'Export distributor-ready proof for missing or misfiled releases, then close the gaps.' },
];

export function Landing() {
  return (
    <div className="lp">
      <header className="lp-header">
        <Link href="/" className="lp-brand">
          <span className="lp-brand-mark" aria-hidden>CS</span>
          <span>Catalog Sentinel</span>
        </Link>
        <nav className="lp-nav" aria-label="Account">
          <Link href="/sign-in" className="lp-link">Sign in</Link>
          <Link href="/sign-up" className="lp-cta">Get started</Link>
        </nav>
      </header>

      <main id="main-content">
        <section className="lp-hero">
          <p className="eyebrow lp-eyebrow">Catalog integrity for independent artists</p>
          <h1 className="lp-title">Know where every release is <em>actually</em> live.</h1>
          <p className="lp-sub">
            Catalog Sentinel checks your distributed catalog across the stores, finds the releases that
            never went live, the missing lyrics, and the wrong-profile placements, then hands you the
            evidence to get them fixed.
          </p>
          <div className="lp-cta-row">
            <Link href="/sign-up" className="lp-cta lp-cta-lg">Get started</Link>
            <Link href="/sign-in" className="lp-ghost lp-cta-lg">Sign in</Link>
          </div>
          <p className="lp-note">Read-only and confidence-scored. Connects through your distributor; we never see your password.</p>
        </section>

        <section className="lp-features" aria-label="What it does">
          {FEATURES.map((f) => (
            <article className="lp-feature" key={f.title}>
              <span className="lp-feature-k">{f.k}</span>
              <h2>{f.title}</h2>
              <p>{f.body}</p>
            </article>
          ))}
        </section>

        <section className="lp-steps" aria-label="How it works">
          <p className="eyebrow lp-eyebrow">How it works</p>
          <div className="lp-steps-grid">
            {STEPS.map((s, i) => (
              <div className="lp-step" key={s.title}>
                <span className="lp-step-n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="lp-closer">
          <h2>See your catalog the way the stores do.</h2>
          <Link href="/sign-up" className="lp-cta lp-cta-lg">Create your account</Link>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-foot-inner">
          <span>Catalog Sentinel</span>
          <span className="lp-footer-links">
            <Link href="/sign-in">Sign in</Link>
            <Link href="/sign-up">Get started</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
