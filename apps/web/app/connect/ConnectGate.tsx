'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { RealConnect } from './RealConnect';

interface SteelStatus {
  status: string;
  loginMode: string;
  liveLoginAvailable: boolean;
  connectionPolicyReady?: boolean;
  message?: string;
}

export function ConnectGate({ viewerOrigins }: { viewerOrigins: string[] }) {
  const [status, setStatus] = useState<SteelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/integrations/steel/status');
      if (!response.ok) throw new Error(`Steel readiness check returned HTTP ${response.status}.`);
      setStatus((await response.json()) as SteelStatus);
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : 'Steel readiness could not be checked.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="cat-empty"><p><span className="spinner" style={{ marginRight: 8 }} />Checking Steel readiness…</p></div>;
  }

  const ready = status?.status === 'READY'
    && status.loginMode === 'steel'
    && status.liveLoginAvailable === true
    && status.connectionPolicyReady !== false;
  if (!ready) {
    const policyBlocked = status?.status === 'READY' && status.connectionPolicyReady === false;
    return (
      <div className="card" role="alert" style={{ maxWidth: 680, borderColor: 'var(--wrong-edge)' }}>
        <div className="eyebrow" style={{ color: 'var(--wrong)', marginBottom: 8 }}>Connection unavailable</div>
        <h2 style={{ margin: '0 0 8px' }}>{policyBlocked ? 'DistroKid connection is disabled' : 'Steel is not ready'}</h2>
        <p className="rail-sub" style={{ marginTop: 0 }}>
          DistroKid sign-in can&rsquo;t start until the API reports an available Steel session. No alternate browser provider is used.
        </p>
        <p className="hint">
          {error || status?.message || 'The required Steel readiness checks did not pass.'}
        </p>
        <button className="btn ghost" type="button" onClick={() => void load()}>Check again</button>
      </div>
    );
  }

  return (
    <>
      <div className="notice-banner" role="status" style={{ borderColor: 'var(--live-edge)', background: 'var(--live-tint)', color: 'var(--live)' }}>
        <strong>Steel ready.</strong>
      </div>
      <RealConnect viewerOrigins={viewerOrigins} />
    </>
  );
}
