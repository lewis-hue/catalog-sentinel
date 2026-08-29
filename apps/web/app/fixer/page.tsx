import { Suspense } from 'react';
import { FixerClient } from './FixerClient';

export const metadata = { title: 'One-Click Fixer, Catalog Sentinel' };
export const dynamic = 'force-dynamic';

export default function FixerPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">One-click fixer</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Fix it</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Every gap the health checks found, wrong artist profiles, missing store deliveries, metadata,
            lyrics, turned into a prepared, one-click action. You review and confirm; nothing is changed automatically.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading fixes…</p>}>
        <FixerClient />
      </Suspense>
    </>
  );
}
