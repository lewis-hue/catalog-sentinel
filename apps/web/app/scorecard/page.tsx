import { Suspense } from 'react';
import { HealthClient } from './HealthClient';

export const metadata = { title: 'Health Score, Catalog Sentinel' };
export const dynamic = 'force-dynamic';

export default function HealthPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Label health</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Catalogue health score</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            One number for how healthy your catalogue is, metadata, store presence, artist identity and
            lyric coverage, with a transparent breakdown of what&apos;s driving it.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading health score…</p>}>
        <HealthClient />
      </Suspense>
    </>
  );
}
