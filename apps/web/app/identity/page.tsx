import { Suspense } from 'react';
import { IdentityClient } from './IdentityClient';

export const metadata = { title: 'Identity Guardian, Catalog Sentinel' };
// Data-driven, render at request time so it reflects the latest store check.
export const dynamic = 'force-dynamic';

export default function IdentityPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Identity guardian</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Artist identity</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Detects tracks that landed on the wrong artist profile, a namesake or a split discography -
            on each store, so your catalogue stays under one identity.
          </p>
        </div>
        <a className="btn ghost" href="/support">Prepare fixes</a>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading identity check…</p>}>
        <IdentityClient />
      </Suspense>
    </>
  );
}
