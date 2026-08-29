'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { NoAudit, Readout, platformCode } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';

interface PerStore { store: string; status: string; foundArtist: string | null; url: string | null; confidence: number; needsManualReview: boolean }
interface Track { title: string; primaryArtist?: string | null; isrc: string | null; perStore: PerStore[] }
interface Profile { store: string; name: string; url: string }
interface DeepScan { status: string; platformsPending: string[]; platformsDone: string[]; error?: string }
interface Rec {
  id: string;
  artist: string;
  deepScan?: DeepScan;
  result: { artist: string; stores: string[]; profiles: Profile[]; tracks: Track[] };
}

type Verdict = 'clean' | 'split' | 'wrong' | 'gap' | 'unknown';
const VERDICT: Record<Verdict, { cls: string; label: string }> = {
  clean: { cls: 'live', label: 'One identity' },
  split: { cls: 'wrong', label: 'Split discography' },
  wrong: { cls: 'wrong', label: 'Wrong profile' },
  gap: { cls: 'gap', label: 'Not found' },
  unknown: { cls: 'unk', label: 'Unverifiable' },
};

interface StoreIdentity {
  store: string;
  total: number;
  live: number;
  wrong: Array<{ title: string; foundArtist: string | null; url: string | null }>;
  namesakes: string[];
  verdict: Verdict;
  expected: Profile | undefined;
}

function aggregate(rec: Rec): StoreIdentity[] {
  const tracks = rec.result.tracks ?? [];
  const out: StoreIdentity[] = [];
  for (const store of rec.result.stores ?? []) {
    const cells = tracks
      .map((t) => ({ t, c: t.perStore.find((p) => p.store === store) }))
      .filter((x): x is { t: Track; c: PerStore } => Boolean(x.c));
    if (!cells.length) continue;
    const live = cells.filter((x) => x.c.status === 'live').length;
    const wrongCells = cells.filter((x) => x.c.status === 'wrong-profile');
    const allUnver = cells.every((x) => x.c.status === 'unverifiable');
    const verdict: Verdict = wrongCells.length
      ? (live > 0 ? 'split' : 'wrong')
      : allUnver ? 'unknown'
        : live > 0 ? 'clean'
          : 'gap';
    out.push({
      store,
      total: cells.length,
      live,
      wrong: wrongCells.map((x) => ({ title: x.t.title, foundArtist: x.c.foundArtist, url: x.c.url })),
      namesakes: Array.from(new Set(wrongCells.map((x) => x.c.foundArtist).filter((n): n is string => Boolean(n)))),
      verdict,
      expected: (rec.result.profiles ?? []).find((p) => p.store === store || store.startsWith(p.store) || p.store.startsWith(store)),
    });
  }
  // Issues first (wrong/split), then clean, then gap/unknown.
  const rank: Record<Verdict, number> = { wrong: 0, split: 1, clean: 2, gap: 3, unknown: 4 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.store.localeCompare(b.store));
}

export function IdentityClient() {
  const idParam = useSearchParams().get('id');
  const [rec, setRec] = useState<Rec | null>(null);
  const [searchId, setSearchId] = useState<string | null>(idParam);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState('');
  const [triggering, setTriggering] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      let id = idParam;
      if (!id) {
        const listRes = await apiFetch('/api/searches');
        if (listRes.ok) { const b = await listRes.json().catch(() => null); id = b?.searches?.[0]?.id ?? null; }
      }
      if (!id) { if (!cancelled.current) { setState('empty'); } return; }
      if (!cancelled.current) setSearchId(id);
      const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load the identity check.'));
      const data = (await res.json()) as Rec;
      if (cancelled.current) return;
      setRec(data);
      setState('ready');
      const st = data.deepScan?.status;
      if (st === 'queued' || st === 'running' || st === 'idle') {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 4000);
      }
    } catch (e) {
      if (!cancelled.current) { setError(e instanceof Error ? e.message : 'Could not load the identity check.'); setState('error'); }
    }
  }, [idParam]);

  useEffect(() => {
    cancelled.current = false;
    setState('loading');
    setError('');
    void load();
    return () => { cancelled.current = true; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  const trigger = useCallback(async () => {
    if (!searchId) return;
    setTriggering(true);
    setError('');
    try {
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/store-check`, { method: 'POST' });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not start the store check.'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the store check.');
    } finally {
      setTriggering(false);
    }
  }, [searchId, load]);

  const stores = useMemo(() => (rec ? aggregate(rec) : []), [rec]);
  const issues = stores.filter((s) => s.verdict === 'wrong' || s.verdict === 'split');
  const wrongTracks = stores.reduce((n, s) => n + s.wrong.length, 0);

  const detailHref = (base: string) => `${base}${searchId ? `?id=${encodeURIComponent(searchId)}` : ''}`;
  const scanStatus = rec?.deepScan?.status;
  const scanning = scanStatus === 'queued' || scanStatus === 'running' || scanStatus === 'idle';

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading identity check…</p>;
  if (state === 'error') return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (state === 'empty' || !rec) return <NoAudit message="No scan yet. Run a catalogue scan, then a store check, to inspect artist identity." cta="Scan catalogue" href="/connect" />;

  // The store check hasn't produced per-store data yet, offer to run it (identity reuses that scan).
  if (!stores.length && !scanning) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '28px 20px' }}>
        <div className="page-title" style={{ fontSize: 18, margin: '0 0 6px' }}>Identity hasn&apos;t been checked yet</div>
        <p className="page-sub" style={{ margin: '0 auto 16px', maxWidth: 520 }}>
          Identity guardian reads the store-presence results. Run a store check to detect tracks that resolve to a
          different artist profile (a namesake) on any store.
        </p>
        {error && <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginBottom: 12 }}>{error}</div>}
        <button className="btn" onClick={() => void trigger()} disabled={triggering}>{triggering ? 'Starting…' : 'Check stores'}</button>
      </div>
    );
  }

  return (
    <div>
      <Readout
        eyebrow={rec.result.artist || rec.artist}
        title="Identity across stores"
        stats={[
          { value: stores.length, label: 'stores checked' },
          { value: issues.length, label: 'with identity issues', tone: issues.length ? 'bad' : 'ok' },
          { value: wrongTracks, label: 'wrong-profile tracks', tone: wrongTracks ? 'warn' : undefined },
        ]}
      />

      {scanning && (
        <div className="notice-banner" role="status" aria-live="polite" style={{ marginTop: 14 }}>
          Store check running: {rec.deepScan?.platformsDone.length ?? 0} platform(s) done
          {rec.deepScan?.platformsPending.length ? `, ${rec.deepScan.platformsPending.length} to go` : ''}. Identity fills in as each store completes.
        </div>
      )}

      {!issues.length && !scanning && (
        <div className="notice-banner" role="status" style={{ marginTop: 14, background: 'var(--live-tint)', borderColor: 'var(--live-edge)', color: 'var(--live)' }}>
          No wrong-profile collisions detected across {stores.length} checked store{stores.length === 1 ? '' : 's'}. Your catalogue resolves to one identity.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {stores.map((s) => {
          const v = VERDICT[s.verdict];
          return (
            <div key={s.store} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="pip live" style={{ background: 'var(--rail-bg)' }}>{platformCode(s.store)}</span>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{s.store}</span>
                <span className={`status ${v.cls}`}>{v.label}</span>
                <span className="page-sub" style={{ margin: 0, marginLeft: 'auto' }}>
                  {s.live}/{s.total} on your profile{s.wrong.length ? ` · ${s.wrong.length} elsewhere` : ''}
                </span>
              </div>

              {s.expected && (
                <div className="page-sub" style={{ margin: '8px 0 0', fontSize: 12 }}>
                  Your profile: <a href={s.expected.url} target="_blank" rel="noreferrer" className="mono">{s.expected.name}</a>
                </div>
              )}

              {s.wrong.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="page-sub" style={{ margin: '0 0 6px', fontSize: 12 }}>
                    {s.wrong.length} track{s.wrong.length === 1 ? '' : 's'} credited to a different artist
                    {s.namesakes.length ? `: ${s.namesakes.map((n) => `"${n}"`).join(', ')}` : ''}.
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead><tr><th>Track</th><th>Shows under</th><th style={{ width: 90 }}>Link</th></tr></thead>
                      <tbody>
                        {s.wrong.map((w, i) => (
                          <tr key={i}>
                            <td>{w.title || 'Untitled'}</td>
                            <td className="mono" style={{ color: 'var(--wrong)' }}>{w.foundArtist || 'unknown artist'}</td>
                            <td>{w.url ? <a href={w.url} target="_blank" rel="noreferrer" className="mono">Open</a> : <span className="mono" style={{ color: 'var(--mist)' }}>-</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {issues.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Link className="btn" href={detailHref('/support')}>Prepare identity fixes in Support center →</Link>
        </div>
      )}
    </div>
  );
}
