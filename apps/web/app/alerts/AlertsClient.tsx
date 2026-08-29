'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { NoAudit, Readout } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { diffScans, type Scan, type Alert, type AlertKind } from './diff';

const KIND: Record<AlertKind, { cls: string; label: string }> = {
  'store-lost': { cls: 'wrong', label: 'Dropped off store' },
  'wrong-profile': { cls: 'wrong', label: 'Wrong profile' },
  'metadata-lost': { cls: 'gap', label: 'Metadata lost' },
  'new-release': { cls: 'info', label: 'New release' },
  'new-track': { cls: 'info', label: 'New track' },
  'store-recovered': { cls: 'live', label: 'Recovered' },
};

interface SearchListItem { id: string; createdAt?: string; name?: string }

async function loadScan(id: string): Promise<Scan> {
  const catRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
  if (!catRes.ok) throw new Error(await apiErrorMessage(catRes, 'Could not load a scan for comparison.'));
  const catalogue = await catRes.json();
  const recRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}`);
  const record = recRes.ok ? await recRes.json() : null;
  return { catalogue, record };
}

export function AlertsClient() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [priorAt, setPriorAt] = useState<string | null>(null);
  const [latestId, setLatestId] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'only-one' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState('loading');
      setError('');
      try {
        const listRes = await apiFetch('/api/searches');
        if (!listRes.ok) throw new Error(await apiErrorMessage(listRes, 'Could not load scan history.'));
        const list = ((await listRes.json())?.searches ?? []) as SearchListItem[];
        if (list.length === 0) { if (!cancelled) setState('empty'); return; }
        if (list.length === 1) { if (!cancelled) setState('only-one'); return; }
        const [latest, prior] = [list[0]!, list[1]!];
        const [latestScan, priorScan] = await Promise.all([loadScan(latest.id), loadScan(prior.id)]);
        if (cancelled) return;
        setAlerts(diffScans(priorScan, latestScan));
        setPriorAt(prior.createdAt ?? null);
        setLatestId(latest.id);
        setState('ready');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not compute alerts.'); setState('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const counts = useMemo(() => ({
    regressions: alerts.filter((a) => a.severity === 'high').length,
    additions: alerts.filter((a) => a.kind === 'new-release' || a.kind === 'new-track').length,
    recoveries: alerts.filter((a) => a.kind === 'store-recovered').length,
  }), [alerts]);

  const ctx = (base: string) => `${base}${latestId ? `?id=${encodeURIComponent(latestId)}` : ''}`;
  const since = priorAt ? new Date(priorAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'the previous scan';

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Comparing scans…</p>;
  if (state === 'error') return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (state === 'empty') return <NoAudit message="No scans yet. Run a catalogue scan; alerts appear once there's a previous scan to compare against." cta="Scan catalogue" href="/connect" />;
  if (state === 'only-one') {
    return (
      <div className="notice-banner" role="status">
        Only one scan so far, there&apos;s nothing to compare yet. Run another scan later and this page will show what changed since {since}.
      </div>
    );
  }

  return (
    <div>
      <Readout
        eyebrow={`Changes since ${since}`}
        title={`${alerts.length} change${alerts.length === 1 ? '' : 's'}`}
        stats={[
          { value: counts.regressions, label: 'regressions', tone: counts.regressions ? 'bad' : 'ok' },
          { value: counts.additions, label: 'new releases/tracks' },
          { value: counts.recoveries, label: 'recoveries', tone: counts.recoveries ? 'ok' : undefined },
        ]}
      />

      {alerts.length === 0 ? (
        <div className="notice-banner" role="status" style={{ marginTop: 16, background: 'var(--live-tint)', borderColor: 'var(--live-edge)', color: 'var(--live)' }}>
          Nothing changed since {since}. Your catalogue is stable.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
          {alerts.map((a, i) => {
            const k = KIND[a.kind];
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
                <span className={`status ${k.cls}`} style={{ flex: 'none' }}>{k.label}</span>
                <div style={{ flex: '1 1 280px', minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    <Link href={`/catalogue/${encodeURIComponent(a.releaseId)}${latestId ? `?id=${encodeURIComponent(latestId)}` : ''}`}>{a.releaseTitle}</Link>
                    {a.trackTitle ? <span className="page-sub" style={{ margin: 0 }}> · {a.trackTitle}</span> : null}
                  </div>
                  <div className="page-sub" style={{ margin: '2px 0 0', fontSize: 12 }}>{a.detail}</div>
                </div>
                {a.severity === 'high' && <Link className="btn ghost" href={ctx('/fixer')} style={{ flex: 'none' }}>Fix</Link>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
