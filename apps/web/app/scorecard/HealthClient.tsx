'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { NoAudit } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { computeHealth, type ScoreCatalogue, type ScoreRecord } from './score';

const colorFor = (score: number | null): string =>
  score == null ? 'var(--line)' : score >= 80 ? 'var(--live)' : score >= 60 ? 'var(--gap)' : 'var(--wrong)';

export function HealthClient() {
  const idParam = useSearchParams().get('id');
  const [searchId, setSearchId] = useState<string | null>(idParam);
  const [cat, setCat] = useState<ScoreCatalogue | null>(null);
  const [rec, setRec] = useState<ScoreRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [error, setError] = useState('');

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
        const catRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
        if (!catRes.ok) throw new Error(await apiErrorMessage(catRes, 'Could not load the catalogue.'));
        const catalogue = (await catRes.json()) as ScoreCatalogue;
        const recRes = await apiFetch(`/api/searches/${encodeURIComponent(id)}`);
        const record = recRes.ok ? ((await recRes.json()) as ScoreRecord) : null;
        if (cancelled) return;
        setCat(catalogue);
        setRec(record);
        setState('ready');
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load the health score.'); setState('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, [idParam]);

  const health = useMemo(() => (cat ? computeHealth(cat, rec) : null), [cat, rec]);
  const ctx = (base: string) => `${base}${searchId ? `?id=${encodeURIComponent(searchId)}` : ''}`;

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading health score…</p>;
  if (state === 'error') return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (state === 'empty' || !cat || !health) return <NoAudit message="No scan yet. Run a catalogue scan, then the store and lyric checks, for a full health score." cta="Scan catalogue" href="/connect" />;

  const ring = colorFor(health.overall);
  const pending = health.components.filter((c) => c.score == null);

  return (
    <div>
      <div className="card" style={{ display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap' }}>
        <div
          style={{
            width: 184, height: 184, borderRadius: '50%', flex: 'none',
            background: `conic-gradient(${ring} ${(health.overall ?? 0) * 3.6}deg, var(--panel-2) 0)`,
            display: 'grid', placeItems: 'center',
          }}
          aria-label={`Catalogue health ${health.overall ?? 'not scored'} out of 100`}
        >
          <div style={{ width: 150, height: 150, borderRadius: '50%', background: 'var(--panel)', display: 'grid', placeItems: 'center', boxShadow: 'inset 0 0 0 1px var(--line)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontOpticalSizing: 'auto', fontWeight: 700, fontSize: 58, lineHeight: 0.92, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: ring }}>{health.overall ?? '-'}</div>
            <div className="eyebrow" style={{ margin: '6px 0 0' }}>Grade {health.grade}</div>
          </div>
        </div>
        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <div className="eyebrow">Catalogue health</div>
          <h2 className="page-title" style={{ margin: '4px 0 8px', fontSize: 24 }}>
            {health.overall == null ? 'Not scored yet'
              : health.overall >= 80 ? 'Healthy catalogue'
                : health.overall >= 60 ? 'Some gaps to close'
                  : 'Needs attention'}
          </h2>
          <p className="page-sub" style={{ margin: 0 }}>
            A weighted score across metadata, store presence, artist identity and lyric coverage.
            {pending.length ? ` ${pending.length} area${pending.length === 1 ? '' : 's'} not yet assessed, the score covers what has been checked.` : ''}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Link className="btn" href={ctx('/fixer')}>Open the fixer</Link>
            <Link className="btn ghost" href={ctx('/catalog')}>Store health</Link>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="k" style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 12 }}>Score breakdown</div>
        <div style={{ display: 'grid', gap: 16 }}>
          {health.components.map((c) => (
            <div key={c.key}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 5 }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.label} <span className="page-sub" style={{ margin: 0, fontWeight: 400 }}>· {c.weight}%</span></span>
                <span className="mono" style={{ fontWeight: 600, color: colorFor(c.score) }}>{c.score == null ? 'not assessed' : c.score}</span>
              </div>
              <div style={{ background: 'var(--panel-2)', borderRadius: 5, height: 9, overflow: 'hidden' }}>
                <div style={{ width: `${c.score ?? 0}%`, background: colorFor(c.score), height: 9, borderRadius: 5, transition: 'width .3s' }} />
              </div>
              <div className="page-sub" style={{ margin: '4px 0 0', fontSize: 12 }}>
                {c.detail}
                {c.score == null && c.key === 'store' && <> · <Link href={ctx('/catalog')}>run it</Link></>}
                {c.score == null && c.key === 'identity' && <> · <Link href={ctx('/catalog')}>run it</Link></>}
                {c.score == null && c.key === 'lyrics' && <> · <Link href={ctx('/catalogue')}>run it</Link></>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
