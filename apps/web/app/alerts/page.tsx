import { Suspense } from 'react';
import { AlertsClient } from './AlertsClient';

export const metadata = { title: 'Release Alerts, Catalog Sentinel' };
export const dynamic = 'force-dynamic';

export default function AlertsPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Release alerts</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>What changed</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            The difference between your last two scans, new releases and tracks, and anything that dropped
            off a store, flipped to a wrong profile, or recovered.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Comparing scans…</p>}>
        <AlertsClient />
      </Suspense>
    </>
  );
}
