import { ConnectGate } from './ConnectGate';
import { steelViewerOrigins } from '@/lib/security-headers';

export const metadata = {
  title: 'Connect distributor, Catalog Sentinel',
};

// Viewer origins are deployment runtime configuration. Do not bake them into a
// reusable image or evaluate them during `next build`.
export const dynamic = 'force-dynamic';

export default function ConnectPage() {
  return (
    <>
      <div className="eyebrow">Distributor link</div>
      <h1 className="page-title">Connect DistroKid &amp; scan your catalog</h1>
      <p className="page-sub">
        Sign in to DistroKid in an isolated Steel browser session and import your catalog for a read-only audit.
      </p>
      <ConnectGate viewerOrigins={steelViewerOrigins()} />
    </>
  );
}
