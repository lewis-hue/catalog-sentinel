import { Suspense } from 'react';
import { CatalogOps } from './CatalogOps';

export const metadata = { title: 'Catalog — Catalog Sentinel' };
// Data-driven — render at request time so the table reflects the latest saved audit.
export const dynamic = 'force-dynamic';

export default function CatalogPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Operate</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Catalog</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Every distributed track with its live status on each platform. Filter to what needs attention, then export
            or open a support packet — nothing is reported missing without evidence.
          </p>
        </div>
        <a className="btn" href="/connect">Run new audit</a>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading catalog…</p>}>
        <CatalogOps />
      </Suspense>
    </>
  );
}
