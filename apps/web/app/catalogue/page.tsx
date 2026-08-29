import { Suspense } from 'react';
import { CatalogueView } from './CatalogueView';

export const metadata = { title: 'Catalogue, Catalog Sentinel' };
// Data-driven, render at request time so it reflects the latest saved scrape.
export const dynamic = 'force-dynamic';

export default function CataloguePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Catalogue</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Your Catalogue</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Every release scraped from your distributor, cover art, UPC, tracks and ISRCs. This is your verified
            source of truth. Export it, then run the health checks against it.
          </p>
        </div>
        <a className="btn" href="/connect">Scan catalogue</a>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading catalogue…</p>}>
        <CatalogueView />
      </Suspense>
    </>
  );
}
