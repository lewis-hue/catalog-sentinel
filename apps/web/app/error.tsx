'use client';

import Link from 'next/link';

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert">
      <div className="eyebrow">Something went wrong</div>
      <h1 className="page-title" style={{ marginTop: 6 }}>This page could not be loaded</h1>
      <p className="page-sub">No catalog data was changed. Retry the request, or return to the tenant overview.</p>
      <div className="row">
        <button className="btn" type="button" onClick={reset}>Try again</button>
        <Link className="btn ghost" href="/">Return to overview</Link>
      </div>
    </div>
  );
}
