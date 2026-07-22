'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { downloadCsv, NoAudit, Readout } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';

interface PerStore { store: string; status: string; foundArtist: string | null; url: string | null; confidence: number; reviewDecision?: string }
interface Track { title: string; album: string | null; isrc: string | null; perStore: PerStore[] }
interface ScanResult { artist: string; stores: string[]; tracks: Track[]; summary: { tracks: number; live: number; notLive: number; wrongProfile: number; needsReview: number } }
interface SearchRecord { id: string; artist: string; createdAt: string; result: ScanResult }

interface Row { platform: string; issue: 'not-live' | 'wrong-profile'; title: string; release: string | null; isrc: string | null; foundArtist: string | null; confidence: number; reviewed: boolean }
interface Group { platform: string; rows: Row[] }

const methodOf = (r: Row) => (r.reviewed ? 'Reviewer-confirmed' : r.confidence >= 0.8 ? 'Official API' : 'Web verification');

function ticketText(artist: string, scanId: string, auditedOn: string, g: Group): string {
  const notLive = g.rows.filter((r) => r.issue === 'not-live');
  const wrong = g.rows.filter((r) => r.issue === 'wrong-profile');
  const ref = (r: Row) => `• ${r.title}${r.release ? ` — ${r.release}` : ''}${r.isrc ? ` (ISRC ${r.isrc})` : ' (no ISRC)'}`;
  const lines: string[] = [];
  lines.push(`Subject: Delivery confirmation — ${artist} on ${g.platform}`, '', 'Hello,', '');
  if (notLive.length) {
    lines.push(
      `The following ${artist} releases were distributed but are not appearing in the artist's ${g.platform} catalog when checked via ${g.platform}'s official API on ${auditedOn}. Please confirm delivery status and expected go-live date:`,
      '',
      ...notLive.map(ref),
      '',
    );
  }
  if (wrong.length) {
    lines.push(
      `The following resolve to a different artist profile on ${g.platform} (possible mis-delivery) — please correct the artist mapping:`,
      '',
      ...wrong.map((r) => `${ref(r)}${r.foundArtist ? ` — currently shows under "${r.foundArtist}"` : ''}`),
      '',
    );
  }
  lines.push(`Audit reference: ${scanId}`, `Method: read-only official-API catalog check (Catalog Sentinel) · audited ${auditedOn}`);
  return lines.join('\n');
}

export function SupportPackets() {
  const savedId = useSearchParams().get('id');
  const [rec, setRec] = useState<SearchRecord | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [copied, setCopied] = useState<string | null>(null);
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
        const r = await apiFetch(`/api/searches/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(await apiErrorMessage(r, 'The support evidence could not be loaded'));
        const record = (await r.json()) as SearchRecord;
        if (!cancelled) { setRec(record); setState('ready'); }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'The support evidence could not be loaded.');
          setState('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [savedId]);

  const groups: Group[] = useMemo(() => {
    if (!rec) return [];
    const byPlatform = new Map<string, Row[]>();
    for (const t of rec.result.tracks) {
      for (const p of t.perStore) {
        if (p.status !== 'not-live' && p.status !== 'wrong-profile') continue;
        const row: Row = { platform: p.store, issue: p.status, title: t.title, release: t.album, isrc: t.isrc, foundArtist: p.foundArtist, confidence: p.confidence, reviewed: Boolean(p.reviewDecision) };
        (byPlatform.get(p.store) ?? byPlatform.set(p.store, []).get(p.store)!).push(row);
      }
    }
    return Array.from(byPlatform.entries()).map(([platform, rows]) => ({ platform, rows })).sort((a, b) => b.rows.length - a.rows.length);
  }, [rec]);

  const auditedOn = rec ? new Date(rec.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  async function copyTicket(g: Group) {
    if (!rec) return;
    setError('');
    const text = ticketText(rec.artist, rec.id, auditedOn, g);
    try { await navigator.clipboard.writeText(text); setCopied(g.platform); setTimeout(() => setCopied(null), 2000); } catch { setError('The ticket could not be copied. Select the text and copy it manually.'); }
  }

  function exportCsv(rows: Row[], suffix: string) {
    if (!rec) return;
    const head = ['Platform', 'Issue', 'Track', 'Release', 'ISRC', 'Found artist', 'Confidence', 'Method', 'Suggested action'];
    const body = rows.map((r) => [r.platform, r.issue === 'not-live' ? 'Not confirmed live' : 'Wrong profile', r.title, r.release ?? '', r.isrc ?? '', r.foundArtist ?? '', r.confidence.toFixed(2), methodOf(r), r.issue === 'not-live' ? 'Confirm delivery / re-deliver' : 'Correct artist mapping']);
    downloadCsv(`support-evidence-${rec.artist.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${suffix}.csv`, [head, ...body]);
  }

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading evidence…</p>;
  if (state === 'error') return <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>;
  if (state !== 'ready' || !rec) {
    return <NoAudit message="No audit has been run yet. Run an audit and any distributor-actionable gaps will become ready-to-send support packets here." />;
  }

  return (
    <>
      {error && <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{error}</div>}
      <Readout
        eyebrow={`Support evidence · ${auditedOn}`}
        title={rec.artist}
        stats={[
          { value: total, label: 'actionable', tone: total ? 'warn' : 'ok' },
          { value: groups.length, label: 'platforms' },
        ]}
      />

      {total === 0 ? (
        <div className="cat-empty">
          <p><strong>Nothing to escalate.</strong> Every distributed track for {rec.artist} is either confirmed live or awaiting manual review — there are no official-API-backed gaps to send to a distributor.</p>
          <a className="btn ghost" href="/review" style={{ marginTop: 16 }}>Open manual review</a>
        </div>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 18, alignItems: 'center', gap: 12 }}>
            <button className="btn" onClick={() => exportCsv(groups.flatMap((g) => g.rows), '')}>Download full evidence CSV</button>
            <span className="cat-note" style={{ margin: 0 }}>Only official-API-backed gaps and reviewer-confirmed results are included. Unverifiable cells stay in <a href="/review">manual review</a> — never asserted as missing.</span>
          </div>

          {groups.map((g) => (
            <div className="card" key={g.platform} style={{ marginBottom: 18 }}>
              <div className="report-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <div className="eyebrow">{g.platform}</div>
                  <h3 style={{ margin: '2px 0 0' }}>
                    {g.rows.filter((r) => r.issue === 'not-live').length} not confirmed live
                    {g.rows.some((r) => r.issue === 'wrong-profile') ? ` · ${g.rows.filter((r) => r.issue === 'wrong-profile').length} wrong profile` : ''}
                  </h3>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" onClick={() => copyTicket(g)}>{copied === g.platform ? 'Copied ✓' : 'Copy ticket'}</button>
                  <button className="btn ghost" onClick={() => exportCsv(g.rows, `-${g.platform.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)}>CSV</button>
                </div>
              </div>

              <div className="rv-meta" style={{ margin: '10px 0 12px' }}>
                {g.rows.slice(0, 12).map((r, i) => (
                  <span key={i} className={`status ${r.issue === 'not-live' ? 'gap' : 'wrong'}`} title={`${r.title}${r.isrc ? ` · ${r.isrc}` : ''}`}>{r.title}</span>
                ))}
                {g.rows.length > 12 && <span className="cat-note" style={{ margin: 0 }}>+{g.rows.length - 12} more</span>}
              </div>

              <h4 style={{ fontSize: 12.5, margin: '0 0 8px', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--mist)' }}>Ticket draft</h4>
              <pre className="draft">{ticketText(rec.artist, rec.id, auditedOn, g)}</pre>
            </div>
          ))}
        </>
      )}
    </>
  );
}
