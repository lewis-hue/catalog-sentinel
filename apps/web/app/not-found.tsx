import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="cat-empty">
      <div className="eyebrow">Not found</div>
      <h1 className="page-title" style={{ marginTop: 8 }}>That page is unavailable</h1>
      <p>The route may have moved, or the audit is not available in this tenant workspace.</p>
      <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
        <Link className="btn" href="/">Open overview</Link>
        <Link className="btn ghost" href="/catalog">Open latest catalog</Link>
      </div>
    </div>
  );
}
