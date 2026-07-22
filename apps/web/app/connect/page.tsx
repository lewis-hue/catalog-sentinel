import { ConnectGate } from './ConnectGate';
import { steelViewerOrigins } from '@/lib/security-headers';

export const metadata = {
  title: 'Connect distributor — Catalog Sentinel',
};

// Viewer origins are deployment runtime configuration. Do not bake them into a
// reusable image or evaluate them during `next build`.
export const dynamic = 'force-dynamic';

export default function ConnectPage() {
  return (
    <>
      <div className="eyebrow">Secure distributor link</div>
      <h1 className="page-title">Connect DistroKid &amp; scan your catalog</h1>
      <p className="page-sub">
        You sign in to DistroKid inside an isolated Steel session; Catalog Sentinel never collects your password or bypasses
        2FA. After explicit consent for Catalog Sentinel&rsquo;s read-only automation, you can start the catalog import,
        cancel the full-authority attended session, or let its short, server-issued access window expire.
      </p>
      <ConnectGate viewerOrigins={steelViewerOrigins()} />
    </>
  );
}
