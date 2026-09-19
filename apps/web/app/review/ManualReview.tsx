'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { platformCode, NoAudit, Readout, humanizeToken, type ReadoutStat } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
const WINDOW = 120;

type Decision = 'CONFIRMED_PRESENT' | 'CONFIRMED_MISSING' | 'WRONG_PROFILE' | 'DISMISSED';
interface Item {
  id: string; scanId: string; platform: string; trackIndex: number; trackTitle: string; album: string | null;
  isrc: string | null; status: string; confidence: number; reason: string; query: string | null;
  candidateUrl: string | null; resolved: boolean; reviewDecision?: string; reviewedBy?: string;
}
interface Payload { scanId: string; artist: string; open: number; items: Item[] }

const DECISION_LABEL: Record<Decision, string> = { CONFIRMED_PRESENT: 'confirmed present', CONFIRMED_MISSING: 'confirmed missing', WRONG_PROFILE: 'wrong profile', DISMISSED: 'dismissed' };

// The decision statuses a resolved cell can carry, used as the resolved-view filter chips.
const DECISION_FILTERS: Array<{ value: 'all' | Decision; label: string; cls: string }> = [
  { value: 'all', label: 'All resolved', cls: '' },
  { value: 'CONFIRMED_PRESENT', label: 'Present', cls: 'ok' },
  { value: 'CONFIRMED_MISSING', label: 'Missing', cls: 'warn' },
  { value: 'WRONG_PROFILE', label: 'Wrong profile', cls: 'bad' },
  { value: 'DISMISSED', label: 'Dismiss', cls: 'ghost' },
];

export function ManualReview() {
  const savedId = useSearchParams().get('id');
  const [data, setData] = useState<Payload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [platform, setPlatform] = useState('all');
  const [q, setQ] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const [decision, setDecision] = useState<'all' | Decision>('all');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [resolvedThisSession, setResolvedThisSession] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError('');
    void (async () => {
      try {
        let id = savedId;
        if (!id) {
          const response = await apiFetch('/api/searches');
          if (!response.ok) throw new Error(await apiErrorMessage(response, 'Audit history could not be loaded'));
          const list = (await response.json()) as { searches?: Array<{ id: string }> };
          id = list.searches?.[0]?.id ?? null;
        }
        if (!id) { if (!cancelled) setState('empty'); return; }
        const r = await apiFetch(`/api/searches/${encodeURIComponent(id)}/manual-review?resolved=true`);
        if (!r.ok) throw new Error(await apiErrorMessage(r, 'The review queue could not be loaded'));
        const payload = (await r.json()) as Payload;
        if (!cancelled) { setData(payload); setState('ready'); }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The review queue could not be loaded.');
          setState('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [savedId]);

  const platforms = useMemo(() => (data ? Array.from(new Set(data.items.map((i) => i.platform))).sort() : []), [data]);
  const openCount = data ? data.items.filter((i) => !i.resolved).length : 0;
  const resolvedCount = data ? data.items.filter((i) => i.resolved).length : 0;
  const pct = data && data.items.length ? Math.round((resolvedCount / data.items.length) * 100) : 0;

  const filtered = useMemo(() => {
    if (!data) return [];
    const n = q.trim().toLowerCase();
    return data.items.filter((i) => {
      // Resolved view shows ONLY resolved cells (each carries a Present/Missing/Wrong profile/Dismiss
      // decision), optionally narrowed to one decision; the open view shows only unresolved cells.
      if (showResolved) {
        if (!i.resolved) return false;
        if (decision !== 'all' && i.reviewDecision !== decision) return false;
      } else if (i.resolved) {
        return false;
      }
      if (platform !== 'all' && i.platform !== platform) return false;
      if (n && !i.trackTitle.toLowerCase().includes(n) && !(i.isrc ?? '').toLowerCase().includes(n)) return false;
      return true;
    });
  }, [data, q, platform, showResolved, decision]);

  async function decide(item: Item, decision: Decision) {
    if (!data || busy.has(item.id)) return;
    setError('');
    setBusy((s) => new Set(s).add(item.id));
    try {
      const r = await apiFetch(`/api/searches/${encodeURIComponent(data.scanId)}/manual-review/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) throw new Error(await apiErrorMessage(r, 'The review decision could not be saved'));
      setData((prev) => prev && ({ ...prev, items: prev.items.map((it) => (it.id === item.id ? { ...it, resolved: true, reviewDecision: decision } : it)) }));
      setResolvedThisSession((n) => n + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The review decision could not be saved.');
    } finally {
      setBusy((s) => { const next = new Set(s); next.delete(item.id); return next; });
    }
  }

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading review queue…</p>;
  if (state === 'error') return <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>;
  if (state !== 'ready' || !data) {
    return <NoAudit message="No audit has been run yet, so there's nothing to review. Run an audit and any unverifiable cells will land here." />;
  }

  if (openCount === 0 && !showResolved) {
    return (
      <>
        <ReviewHeader artist={data.artist} open={openCount} resolved={resolvedCount} pct={pct} session={resolvedThisSession} />
        <div className="cat-empty">
          <p><strong>Queue clear.</strong> Every flagged cell for {data.artist} has a human decision. Nothing is reported missing without one.</p>
          <button className="btn ghost" style={{ marginTop: 16 }} onClick={() => setShowResolved(true)}>Show resolved decisions</button>
        </div>
      </>
    );
  }

  return (
    <>
      {error && <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>}
      <ReviewHeader artist={data.artist} open={openCount} resolved={resolvedCount} pct={pct} session={resolvedThisSession} />

      <div className="cat-controls">
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <select className="filter" value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Filter by platform">
            <option value="all">All platforms ({data.items.filter((i) => !i.resolved).length} open)</option>
            {platforms.map((p) => (
              <option key={p} value={p}>{p} ({data.items.filter((i) => i.platform === p && !i.resolved).length} open)</option>
            ))}
          </select>
          <input className="filter" style={{ minWidth: 200 }} placeholder="Search title or ISRC…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search review queue" />
        </div>
        <label className="rv-query" style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      </div>

      {showResolved && (
        <div className="row" style={{ gap: 8, marginBottom: 18 }} role="group" aria-label="Filter resolved decisions">
          {DECISION_FILTERS.map((f) => {
            const count = f.value === 'all' ? resolvedCount : data.items.filter((i) => i.resolved && i.reviewDecision === f.value).length;
            return (
              <button key={f.value} type="button" className={`chip ${f.cls} ${decision === f.value ? 'on' : ''}`.trim()} onClick={() => setDecision(f.value)}>
                {f.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      <div className="rv-list">
        {filtered.slice(0, WINDOW).map((item) => (
          <div key={item.id} className={`rv-item ${item.resolved ? 'resolved' : ''}`}>
            <div className="rv-main">
              <span className="rv-title">{item.trackTitle}</span>
              <div className="rv-meta">
                <span className="pip unk" title={item.platform}>{platformCode(item.platform)}</span>
                <span style={{ fontSize: 12, color: 'var(--mist)' }}>{item.platform}</span>
                <span className="status unk">{item.status === 'unverifiable' ? 'Unverifiable' : 'Low confidence'}</span>
                <span className="rv-query">conf {item.confidence.toFixed(2)}</span>
                {item.isrc && <span className="rv-query">· {item.isrc}</span>}
                {item.resolved && item.reviewDecision && <span className="status live">✓ {DECISION_LABEL[item.reviewDecision as Decision] ?? humanizeToken(item.reviewDecision)}</span>}
              </div>
              <div className="rv-reason">
                {item.reason}
                {item.candidateUrl && <> <a href={item.candidateUrl} target="_blank" rel="noreferrer">Open candidate ↗</a></>}
              </div>
            </div>
            {!item.resolved && (
              <div className="rv-actions">
                <button className="rv-act present" disabled={busy.has(item.id)} onClick={() => decide(item, 'CONFIRMED_PRESENT')}>Present</button>
                <button className="rv-act missing" disabled={busy.has(item.id)} onClick={() => decide(item, 'CONFIRMED_MISSING')}>Missing</button>
                <button className="rv-act wrong" disabled={busy.has(item.id)} onClick={() => decide(item, 'WRONG_PROFILE')}>Wrong profile</button>
                <button className="rv-act dismiss" disabled={busy.has(item.id)} onClick={() => decide(item, 'DISMISSED')}>Dismiss</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {filtered.length > WINDOW && <p className="cat-note">Showing the first {WINDOW} of {filtered.length} items. Resolve these or narrow by platform to see more, the queue reveals the rest as you clear it.</p>}
      <p className="cat-note">Each decision is written back to the presence matrix as authoritative (confidence 1.0) and recomputes the catalog summary. Decisions are reversible from the record.</p>
    </>
  );
}

function ReviewHeader({ artist, open, resolved, pct, session }: { artist: string; open: number; resolved: number; pct: number; session: number }) {
  const stats: ReadoutStat[] = [
    { value: open, label: 'open', tone: open ? 'warn' : 'ok' },
    { value: resolved, label: 'resolved', tone: 'ok' },
    ...(session > 0 ? [{ value: session, label: 'this session' } as ReadoutStat] : []),
  ];
  return (
    <>
      <Readout eyebrow="Manual review" title={artist} stats={stats} style={{ marginBottom: 14 }} />
      <div className="meter" role="img" aria-label={`${pct}% reviewed`} style={{ marginBottom: 20 }}>
        <div className="seg found" style={{ width: `${pct}%` }}>{pct > 8 ? `${resolved} resolved` : ''}</div>
        <div className="seg missing" style={{ width: `${100 - pct}%` }}>{100 - pct > 8 ? `${open} open` : ''}</div>
      </div>
    </>
  );
}
