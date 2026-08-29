import { Suspense } from 'react';
import { ManualReview } from './ManualReview';

export const metadata = { title: 'Manual review, Catalog Sentinel' };
// Reads the live review queue at request time.
export const dynamic = 'force-dynamic';

export default function ReviewPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Operate</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Manual review</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Cells a web check couldn&apos;t confirm are never called present or missing on their own, they wait here for a
            human decision. Each decision becomes authoritative and updates the catalog.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading review queue…</p>}>
        <ManualReview />
      </Suspense>
    </>
  );
}
