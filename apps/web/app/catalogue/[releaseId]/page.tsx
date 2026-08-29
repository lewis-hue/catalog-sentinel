import { Suspense } from 'react';
import { ReleaseDetail } from './ReleaseDetail';

export const metadata = { title: 'Release, Catalog Sentinel' };
export const dynamic = 'force-dynamic';

export default function ReleasePage() {
  return (
    <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading release…</p>}>
      <ReleaseDetail />
    </Suspense>
  );
}
