import { Suspense } from 'react';
import { SupportPackets } from './SupportPackets';

export const metadata = { title: 'Support center, Catalog Sentinel' };
// Reads the latest audit at request time to assemble evidence packets.
export const dynamic = 'force-dynamic';

export default function SupportCenterPage() {
  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Operate</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Support center</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Distributor-ready evidence for the gaps worth escalating, grouped by platform, with a ready-to-send ticket
            draft and CSV. Only official-API-backed gaps and reviewer-confirmed results are included.
          </p>
        </div>
      </div>
      <Suspense fallback={<p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading evidence…</p>}>
        <SupportPackets />
      </Suspense>
    </>
  );
}
