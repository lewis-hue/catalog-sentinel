'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { NoAudit, Readout } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { planFixes, groupByRelease, type Catalogue, type RecordView, type Fix, type FixKind } from './plan';

const KIND: Record<FixKind, { cls: string; label: string }> = {
  'wrong-profile': { cls: 'wrong', label: 'Wrong profile' },
  'missing-store': { cls: 'gap', label: 'Missing on store' },
  'missing-metadata': { cls: 'info', label: 'Metadata' },
  'missing-lyrics': { cls: 'unk', label: 'Lyrics' },
};

const doneKey = (searchId: string) => `sentinel.fixer.done.${searchId}`;

export function FixerClient() {
  const idParam = useSearchParams().get('id');
  const [searchId, setSearchId] = useState<string | null>(idParam);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [rec, setRec] = useState<(RecordView & { deepScan?: { status: string }; lyricsScan?: { status: string } }) | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState('');
  const [done, setDone] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState('loading');
      setError('');
      try {
        let id = idParam;
        if (!id) {
          const list = await apiFetch('/api/searches');
          if (list.ok) { const b = await list.json().catch(() => null); id = b?.searches?.[0]?.id ?? null; }
        }
        if (!id) { if (!cancelled) setState('empty'); return; }
        if (!cancelled) setSearchId(id);
        // Catalogue is the source of truth; the record (store presence + lyrics) is best-effort.
        const catRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
        if (!catRes.ok) throw new Error(await apiErrorMessage(catRes, 'Could not load the catalogue.'));
        const catalogue = (await catRes.json()) as Catalogue;
        const recRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}`);
        const record = recRes.ok ? ((await recRes.json()) as RecordView & { deepScan?: { status: string }; lyricsScan?: { status: string } }) : null;
        if (cancelled) return;
        setCat(catalogue);
        setRec(record);
        try { setDone(new Set(JSON.parse(localStorage.getItem(doneKey(id)) || '[]') as string[])); } catch { /* ignore */ }
        setState('ready');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load the fixer.'); setState('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [idParam]);

  const toggleDone = useCallback((fixId: string) => {
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(fixId)) next.delete(fixId); else next.add(fixId);
      if (searchId) { try { localStorage.setItem(doneKey(searchId), JSON.stringify([...next])); } catch { /* ignore */ } }
      return next;
    });
  }, [searchId]);

  const fixes = useMemo(() => (cat ? planFixes(cat, rec) : []), [cat, rec]);
  const open = fixes.filter((f) => !done.has(f.id));
  const groups = useMemo(() => groupByRelease(open), [open]);
  const counts = useMemo(() => {
    const c: Record<FixKind, number> = { 'wrong-profile': 0, 'missing-store': 0, 'missing-metadata': 0, 'missing-lyrics': 0 };
    for (const f of open) c[f.kind] += 1;
    return c;
  }, [open]);

  const ctx = (base: string) => `${base}${searchId ? `?id=${encodeURIComponent(searchId)}` : ''}`;
  const storeChecked = rec?.deepScan?.status === 'done';
  const lyricsChecked = rec?.lyricsScan?.status === 'done';

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading fixes…</p>;
  if (state === 'error') return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (state === 'empty' || !cat) return <NoAudit message="No scan yet. Run a catalogue scan, then the store and lyric checks, and every fixable gap collects here." cta="Scan catalogue" href="/connect" />;

  return (
    <div>
      <Readout
        eyebrow="One-click fixer"
        title={`${open.length} open fix${open.length === 1 ? '' : 'es'}`}
        stats={[
          { value: counts['wrong-profile'], label: 'wrong profile', tone: counts['wrong-profile'] ? 'bad' : 'ok' },
          { value: counts['missing-store'], label: 'missing on store', tone: counts['missing-store'] ? 'warn' : 'ok' },
          { value: counts['missing-metadata'], label: 'metadata', tone: counts['missing-metadata'] ? 'warn' : undefined },
          { value: counts['missing-lyrics'], label: 'lyrics', tone: counts['missing-lyrics'] ? 'warn' : undefined },
        ]}
      />

      {(!storeChecked || !lyricsChecked) && (
        <div className="notice-banner" style={{ marginTop: 14 }}>
          Run the checks to surface every fix:{' '}
          {!storeChecked && <Link href={ctx('/catalog')}>store presence</Link>}
          {!storeChecked && !lyricsChecked && ' · '}
          {!lyricsChecked && <Link href={ctx('/catalogue')}>lyrics</Link>}
          {'. '}Metadata fixes are shown already.
        </div>
      )}

      {open.length === 0 ? (
        <div className="notice-banner" role="status" style={{ marginTop: 16, background: 'var(--live-tint)', borderColor: 'var(--live-edge)', color: 'var(--live)' }}>
          Nothing to fix{done.size ? `, ${done.size} marked done` : ''}. Every checked track is clean.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
          {groups.map((g) => (
            <div key={g.releaseId} className="card">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                <Link href={`/catalogue/${encodeURIComponent(g.releaseId)}${searchId ? `?id=${encodeURIComponent(searchId)}` : ''}`} style={{ fontWeight: 600, fontSize: 15 }}>{g.releaseTitle}</Link>
                <span className="page-sub" style={{ margin: 0 }}>{g.fixes.length} fix{g.fixes.length === 1 ? '' : 'es'}</span>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                {g.fixes.map((f) => (
                  <FixRow key={f.id} fix={f} onDone={() => toggleDone(f.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {done.size > 0 && (
        <div style={{ marginTop: 14 }}>
          <button className="btn ghost" onClick={() => { setDone(new Set()); if (searchId) try { localStorage.removeItem(doneKey(searchId)); } catch { /* ignore */ } }}>
            Reset {done.size} marked done
          </button>
        </div>
      )}
    </div>
  );
}

function FixRow({ fix, onDone }: { fix: Fix; onDone: () => void }) {
  const k = KIND[fix.kind];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--panel)' }}>
      <span className={`status ${k.cls}`} style={{ flex: 'none' }}>{k.label}</span>
      <div style={{ flex: '1 1 280px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          {fix.trackTitle ? <span>{fix.trackTitle}{fix.store ? ` · ${fix.store}` : ''}, </span> : null}
          {fix.diagnosis}
        </div>
        <div className="page-sub" style={{ margin: '2px 0 0', fontSize: 12 }}>{fix.action}</div>
        {fix.prepared && <div className="mono" style={{ fontSize: 11, color: 'var(--mist)', marginTop: 3 }}>{fix.prepared}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
        {fix.link && <a className="btn ok" href={fix.link.href} target="_blank" rel="noreferrer">Fix →</a>}
        <button className="btn ghost" onClick={onDone} title="Mark this fix done">Done</button>
      </div>
    </div>
  );
}
