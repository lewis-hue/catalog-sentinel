'use client';
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { Cover, Pill, artistLine } from '../CatalogueView';
import { useStorePresence, StorePips, LyricFindPill, VerdictPill, StoreCheckBar, worstOf, deliveredMapFrom, type Worst } from '../store-presence';
import { useLyricsCheck, LyricsCheckBar, LyricsStoreCell, LyricCompareCell, computeLyricsCoverage } from '../lyrics-check';

interface CatTrack {
  title: string | null; isrc: string | null; isrcStatus: string; trackNumber: number | null; trackIndex: number;
  featuredArtists: string[]; plainLyrics: string; syncedLyrics: string;
  storeLyricStatus: string; storeHasPlain: boolean; storeHasSynced: boolean;
  storeLyricsPerStore?: Record<string, string>; lyricfindDistributed?: boolean | null; lyricfindUrl?: string | null;
}

/** DistroKid lyric-availability status → design-system status pill. */
const LYRIC_PILL: Record<string, { cls: string; label: string }> = {
  present: { cls: 'live', label: 'Yes' },
  processing: { cls: 'info', label: 'Processing' },
  none: { cls: 'gap', label: 'None' },
  unknown: { cls: 'unk', label: 'Not read' },
};
function LyricValue({ status }: { status: string }) {
  const s = LYRIC_PILL[status] ?? LYRIC_PILL.unknown;
  return <span className={`status ${s.cls}`}>{s.label}</span>;
}
interface CatRelease {
  releaseId: string; distributorReleaseId: string; title: string | null; version: string | null; releaseType: string | null;
  primaryArtist: string | null; featuredArtists: string[]; label: string | null;
  releaseDate: string | null; uploadDate: string | null; artworkUrl: string | null;
  upc: string | null; upcStatus: string; artworkStatus: string;
  submittedStores?: Array<{ store: string; url: string | null }>; tracks: CatTrack[];
}
interface Catalogue { snapshotId: string; releases: CatRelease[] }

const dtStyle: CSSProperties = { color: 'var(--mist)', fontFamily: 'var(--font-mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em', paddingTop: 2 };

export function ReleaseDetail() {
  const routeParams = useParams<{ releaseId: string }>();
  const releaseId = decodeURIComponent(String(routeParams?.releaseId ?? ''));
  const sp = useSearchParams();
  const searchIdParam = sp.get('id');
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [searchId, setSearchId] = useState<string | null>(searchIdParam);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const presence = useStorePresence(searchId);

  const reloadCatalogue = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
    if (res.ok) setCat((await res.json()) as Catalogue);
  }, []);
  // When the store-lyrics check finishes, the per-track verdicts land in the catalogue, refetch it.
  const lyrics = useLyricsCheck(searchId, { onCompleted: () => { if (searchId) void reloadCatalogue(searchId); } });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError('');
      try {
        let id = searchIdParam;
        if (!id) {
          const listRes = await apiFetch('/api/searches');
          if (listRes.ok) { const b = await listRes.json().catch(() => null); id = b?.searches?.[0]?.id ?? null; }
        }
        if (!id) { if (!cancelled) setLoading(false); return; }
        if (!cancelled) setSearchId(id);
        const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
        if (!res.ok) { if (!cancelled) setError(await apiErrorMessage(res, 'Could not load the release.')); }
        else { const b = (await res.json()) as Catalogue; if (!cancelled) setCat(b); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the release.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [searchIdParam, releaseId]);

  const release = useMemo(() => cat?.releases.find((r) => r.releaseId === releaseId) ?? null, [cat, releaseId]);
  const deliveredMap = useMemo(() => deliveredMapFrom(release?.submittedStores), [release]);
  const backHref = `/catalogue${searchIdParam ? `?id=${encodeURIComponent(searchIdParam)}` : ''}`;
  const ctxHref = (base: string) => `${base}${searchIdParam ? `?id=${encodeURIComponent(searchIdParam)}` : ''}`;

  if (loading) return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading release…</p>;
  if (error) return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (!release) {
    return (
      <div>
        <Link className="btn ghost" href={backHref}>← Back to catalogue</Link>
        <div className="notice-banner" style={{ marginTop: 14 }}>Release not found in this catalogue.</div>
      </div>
    );
  }

  const isrcCount = release.tracks.filter((t) => t.isrc).length;
  const releaseWorst: Worst = (() => {
    const perTrack = release.tracks.map((t) => worstOf(presence.cellsForTrack(t)));
    if (perTrack.some((w) => w === 'wrong')) return 'wrong';
    if (perTrack.some((w) => w === 'gap')) return 'gap';
    if (perTrack.some((w) => w === 'unk')) return 'unk';
    if (perTrack.length && perTrack.every((w) => w === 'live')) return 'live';
    return 'pending';
  })();

  return (
    <div>
      <Link className="btn ghost" href={backHref} style={{ marginBottom: 16, display: 'inline-flex' }}>← Back to catalogue</Link>

      <div className="card" style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: 180, height: 180, flex: 'none', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: 'var(--shadow-sm)' }}>
          <Cover art={release.artworkUrl} title={release.title} />
        </div>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 4px' }}>
            <h1 className="page-title" style={{ margin: 0, fontSize: 24 }}>{release.title || 'Untitled'}</h1>
            {release.releaseType && <Pill>{release.releaseType}</Pill>}
            {release.version && <Pill tone="info">{release.version}</Pill>}
          </div>
          <p className="page-sub" style={{ margin: '0 0 14px' }}>{artistLine(release)}</p>
          <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 14px', margin: 0, fontSize: 14 }}>
            <dt style={dtStyle}>UPC</dt><dd className="mono" style={{ margin: 0 }}>{release.upc || ''}</dd>
            <dt style={dtStyle}>Released</dt><dd style={{ margin: 0 }}>{release.releaseDate || ''}</dd>
            <dt style={dtStyle}>Uploaded</dt><dd style={{ margin: 0 }}>{release.uploadDate || ''}</dd>
            <dt style={dtStyle}>Label</dt><dd style={{ margin: 0 }}>{release.label || ''}</dd>
            <dt style={dtStyle}>Tracks</dt><dd style={{ margin: 0 }}>{release.tracks.length} · {isrcCount} with ISRC</dd>
          </dl>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <Link className="btn" href={ctxHref('/review')}>Manual review</Link>
            <Link className="btn" href={ctxHref('/support')}>Support center</Link>
            <Link className="btn ghost" href={ctxHref('/catalog')}>Store health</Link>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="k" style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Missing songs, store presence</div>
          {presence.deepScan?.status === 'done' && <VerdictPill worst={releaseWorst} />}
        </div>
        <StoreCheckBar presence={presence} compact />
        {deliveredMap.size > 0 && (
          <div style={{ margin: '0 0 12px' }}>
            <div className="page-sub" style={{ fontSize: 12, margin: '0 0 6px' }}>
              <strong>Delivered by DistroKid</strong> to {deliveredMap.size} store{deliveredMap.size === 1 ? '' : 's'}, DistroKid&apos;s own record, authoritative for delivery. Stores we can&apos;t independently confirm show as <span className="status delivered">Delivered</span> (blue) rather than unverified.
            </div>
            <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
              {[...deliveredMap.entries()].map(([store, url]) => (
                url
                  ? <a key={store} className="status delivered" href={url} target="_blank" rel="noreferrer" title={`Open ${store}`} style={{ textDecoration: 'none' }}>{store} ↗</a>
                  : <span key={store} className="status delivered" title={`Delivered to ${store}`}>{store}</span>
              ))}
            </div>
          </div>
        )}
        {presence.error && (
          <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginBottom: 12 }}>{presence.error}</div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th style={{ width: 44 }}>#</th><th>Title</th><th style={{ width: 150 }}>ISRC</th><th>Stores</th><th style={{ width: 150 }}>Verdict</th></tr></thead>
            <tbody>
              {release.tracks.map((t, i) => {
                const cells = presence.cellsForTrack(t);
                return (
                  <tr key={i}>
                    <td className="mono">{t.trackNumber ?? i + 1}</td>
                    <td>{t.title || 'Untitled'}{t.lyricfindDistributed ? <> <LyricFindPill url={t.lyricfindUrl} /></> : null}</td>
                    <td className="mono" style={{ color: t.isrc ? 'var(--paper)' : 'var(--mist)' }}>{t.isrc || 'no ISRC'}</td>
                    <td><StorePips cells={cells} stores={presence.stores} delivered={deliveredMap} lyrics={t.storeLyricsPerStore} /></td>
                    <td><VerdictPill worst={worstOf(cells)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="k" style={{ color: 'var(--mist)', fontFamily: 'var(--font-mono)', fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 4 }}>Missing lyrics</div>
        <p className="page-sub" style={{ marginTop: 0, marginBottom: 12 }}>Plain and time-synced (LRC) lyrics on DistroKid, reconciled against what the stores actually show. <strong>Missing on stores</strong> means DistroKid has the lyrics but they haven&apos;t propagated; <strong>Not on DistroKid</strong> means the stores show lyrics your release doesn&apos;t.</p>
        <LyricsCheckBar check={lyrics} coverage={computeLyricsCoverage(release.tracks)} compact />
        {lyrics.error && (
          <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)', marginBottom: 12 }}>{lyrics.error}</div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th style={{ width: 44 }}>#</th><th>Title</th><th style={{ width: 100 }}>DK plain</th><th style={{ width: 100 }}>DK synced</th><th style={{ width: 190 }}>Stores</th><th style={{ width: 150 }}>Reconciliation</th></tr></thead>
            <tbody>
              {release.tracks.map((t, i) => (
                <tr key={i}>
                  <td className="mono">{t.trackNumber ?? i + 1}</td>
                  <td>{t.title || 'Untitled'}</td>
                  <td><LyricValue status={t.plainLyrics} /></td>
                  <td><LyricValue status={t.syncedLyrics} /></td>
                  <td><LyricsStoreCell track={t} /></td>
                  <td><LyricCompareCell track={t} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
