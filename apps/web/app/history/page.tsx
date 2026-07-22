import { HistoryList } from './HistoryList';

export const metadata = { title: 'Audit history — Catalog Sentinel' };

export default function HistoryPage() {
  return (
    <>
      <div className="eyebrow">History</div>
      <h1 className="page-title">Your audit history</h1>
      <p className="page-sub">Open, rename, delete, or recheck a saved audit. A platform recheck uses the saved distributor snapshot; refresh through DistroKid when you need current release metadata.</p>
      <HistoryList />
    </>
  );
}
