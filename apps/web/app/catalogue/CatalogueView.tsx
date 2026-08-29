'use client';
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { downloadCsv, NoAudit } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { useStorePresence, StoreCheckBar, worstOf, type Worst } from './store-presence';
import { useLyricsCheck, LyricsCheckBar, computeLyricsCoverage, type TrackLyrics } from './lyrics-check';

interface CatTrack {
  title: string | null; isrc: string | null; isrcStatus: string; trackNumber: number | null; featuredArtists: string[];
  plainLyrics: string; syncedLyrics: string; storeLyricStatus: string; storeHasPlain: boolean; storeHasSynced: boolean;
}
interface CatRelease {
  releaseId: string; distributorReleaseId: string; title: string | null; version: string | null; releaseType: string | null;
  primaryArtist: string | null; featuredArtists: string[]; label: string | null;
  releaseDate: string | null; uploadDate: string | null; artworkUrl: string | null;
  upc: string | null; upcStatus: string; artworkStatus: string; tracks: CatTrack[];
}

/** All credited artists as one line: "Lewis KE, Boeyylee". */
export const artistLine = (r: { primaryArtist: string | null; featuredArtists: string[] }): string =>
  [r.primaryArtist, ...(r.featuredArtists ?? [])].filter(Boolean).join(', ');

/** Small tag pill (release type / version). */
export function Pill({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'info' }) {
  const c = tone === 'info'
    ? { bg: 'var(--info-tint)', fg: 'var(--info)', bd: 'var(--info-edge)' }
    : { bg: 'var(--brand-tint)', fg: 'var(--brand-dim)', bd: 'var(--line)' };
  return <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, whiteSpace: 'nowrap' }}>{children}</span>;
}
interface Catalogue {
  snapshotId: string; status: string; finalizedAt: string | null;
  releaseCount: number; trackCount: number; upcPresent: number; artworkPresent: number; isrcPresent: number;
  releases: CatRelease[];
}

/** Cover art that sizes itself (works anywhere, not only inside .art-tile) with a graceful
 *  initial-letter fallback. Fills its parent box; the parent controls the aspect ratio. */
export function Cover({ art, title }: { art: string | null; title: string | null }) {
  const [failed, setFailed] = useState(false);
  const initial = ((title || '?').trim().charAt(0).toUpperCase()) || '♪';
  const box: CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block' };
  if (!art || failed) {
    return (
      <div aria-hidden style={{ ...box, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(20px, 22%, 56px)', color: '#fff', background: 'linear-gradient(135deg, var(--brand), var(--wrong))' }}>
        {initial}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={art} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} style={box} />;
}

const pct = (n: number, d: number): number => (d ? Math.round((n / d) * 100) : 0);

export function CatalogueView() {
  const params = useSearchParams();
  const idParam = params.get('id');
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const presence = useStorePresence(searchId);
  const reloadCatalogue = useCallback(async (id: string) => {
    const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
    if (res.ok) setCat((await res.json()) as Catalogue);
  }, []);
  // Refresh the catalogue (and its lyric verdicts) when a lyric check finishes.
  const lyricsCheck = useLyricsCheck(searchId, { onCompleted: () => { if (searchId) void reloadCatalogue(searchId); } });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError('');
      try {
        let id = idParam;
        if (!id) {
          const listRes = await apiFetch('/api/searches');
          if (listRes.ok) {
            const body = await listRes.json().catch(() => null);
            id = body?.searches?.[0]?.id ?? null;
          }
        }
        if (!id) {
          if (!cancelled) { setCat(null); setLoading(false); }
          return;
        }
        if (!cancelled) setSearchId(id);
        const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
        if (!res.ok) {
          if (!cancelled) setError(await apiErrorMessage(res, 'Could not load the catalogue.'));
        } else {
          const body = (await res.json()) as Catalogue;
          if (!cancelled) setCat(body);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the catalogue.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [idParam]);

  const releases = useMemo(() => {
    if (!cat) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return cat.releases;
    return cat.releases.filter((r) =>
      (r.title || '').toLowerCase().includes(needle)
      || artistLine(r).toLowerCase().includes(needle)
      || (r.version || '').toLowerCase().includes(needle)
      || (r.releaseType || '').toLowerCase().includes(needle)
      || (r.upc || '').includes(needle)
      || r.tracks.some((t) => (t.title || '').toLowerCase().includes(needle) || (t.isrc || '').toLowerCase().includes(needle)),
    );
  }, [cat, q]);

  const lyrics = useMemo(() => {
    let total = 0, plain = 0, synced = 0;
    for (const r of cat?.releases ?? []) for (const t of r.tracks) {
      total += 1;
      if (t.plainLyrics === 'present') plain += 1;
      if (t.syncedLyrics === 'present') synced += 1;
    }
    return { total, plain, synced };
  }, [cat]);

  const exportCsv = () => {
    if (!cat) return;
    const rows: Array<Array<string | number>> = [['Title', 'Version', 'Type', 'Artist', 'Featured', 'UPC', 'Artwork', 'Track #', 'Track', 'ISRC', 'Plain lyrics', 'Synced lyrics']];
    for (const r of cat.releases) {
      const tracks: CatTrack[] = r.tracks.length ? r.tracks : [{ title: '', isrc: '', isrcStatus: '', trackNumber: null, featuredArtists: [], plainLyrics: 'unknown', syncedLyrics: 'unknown', storeLyricStatus: 'unknown', storeHasPlain: false, storeHasSynced: false }];
      for (const t of tracks) rows.push([r.title || '', r.version || '', r.releaseType || '', r.primaryArtist || '', (r.featuredArtists || []).join('; '), r.upc || '', r.artworkUrl || '', t.trackNumber ?? '', t.title || '', t.isrc || '', t.plainLyrics || '', t.syncedLyrics || '']);
    }
    downloadCsv(`catalogue-${cat.snapshotId}.csv`, rows);
  };

  const exportJson = () => {
    if (!cat) return;
    const blob = new Blob([JSON.stringify(cat, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `catalogue-${cat.snapshotId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const detailHref = (releaseId: string) => `/catalogue/${encodeURIComponent(releaseId)}${searchId ? `?id=${encodeURIComponent(searchId)}` : ''}`;

  // Worst store verdict across a release's tracks, drives the at-a-glance health dot on each tile.
  const releaseWorst = (r: CatRelease): Worst => {
    const per = r.tracks.map((t) => worstOf(presence.cellsForTrack({ isrc: t.isrc, title: t.title })));
    if (per.some((w) => w === 'wrong')) return 'wrong';
    if (per.some((w) => w === 'gap')) return 'gap';
    if (per.some((w) => w === 'unk')) return 'unk';
    if (per.length && per.every((w) => w === 'live')) return 'live';
    return 'pending';
  };
  const worstTitle: Record<Worst, string> = {
    live: 'On every store', gap: 'Missing on a store', wrong: 'Wrong profile', unk: 'To review', pending: 'Not checked',
  };

  if (loading) return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading catalogue…</p>;
  if (error) return <div className="notice-banner" style={{ background: 'var(--wrong-tint)', borderColor: 'var(--wrong-edge)', color: 'var(--wrong)' }}>{error}</div>;
  if (!cat || cat.releaseCount === 0) return <NoAudit message="No scraped catalogue yet. Run a catalogue scan to build it." cta="Scan catalogue" href="/connect" />;

  return (
    <div className="cat">
      <div className="stat-grid">
        <div className="stat"><div className="n">{cat.releaseCount}</div><div className="k">Releases</div></div>
        <div className="stat"><div className="n">{cat.trackCount}</div><div className="k">Tracks</div></div>
        <div className="stat"><div className={`n ${pct(cat.upcPresent, cat.releaseCount) === 100 ? 'ok' : 'warn'}`}>{pct(cat.upcPresent, cat.releaseCount)}%</div><div className="k">UPC coverage</div></div>
        <div className="stat"><div className={`n ${pct(cat.artworkPresent, cat.releaseCount) === 100 ? 'ok' : 'warn'}`}>{pct(cat.artworkPresent, cat.releaseCount)}%</div><div className="k">Artwork</div></div>
        <div className="stat"><div className={`n ${pct(cat.isrcPresent, cat.trackCount) === 100 ? 'ok' : 'warn'}`}>{pct(cat.isrcPresent, cat.trackCount)}%</div><div className="k">ISRC coverage</div></div>
        <div className="stat"><div className={`n ${pct(lyrics.plain, lyrics.total) === 100 ? 'ok' : 'warn'}`}>{pct(lyrics.plain, lyrics.total)}%</div><div className="k">Plain lyrics</div></div>
        <div className="stat"><div className={`n ${pct(lyrics.synced, lyrics.total) === 100 ? 'ok' : 'warn'}`}>{pct(lyrics.synced, lyrics.total)}%</div><div className="k">Synced lyrics</div></div>
      </div>

      <StoreCheckBar presence={presence} />
      <LyricsCheckBar check={lyricsCheck} coverage={computeLyricsCoverage((cat?.releases.flatMap((r) => r.tracks) ?? []) as TrackLyrics[])} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '4px 0 18px', flexWrap: 'wrap' }}>
        <input
          className="mono"
          placeholder="Search title, artist, UPC or ISRC…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: '1 1 260px', padding: '9px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--paper)' }}
        />
        <span className="page-sub" style={{ margin: 0 }}>{releases.length} of {cat.releaseCount}</span>
        <button className="btn ok" onClick={exportCsv}>Export CSV</button>
        <button className="btn" onClick={exportJson}>Export JSON</button>
        <button className="btn" onClick={() => window.print()}>Export PDF</button>
      </div>

      <div className="art-wall">
        {releases.map((r) => (
          <Link
            key={r.releaseId}
            href={detailHref(r.releaseId)}
            style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--panel)', boxShadow: 'var(--shadow-xs)', textDecoration: 'none', color: 'inherit' }}
          >
            <div style={{ aspectRatio: '1 / 1', width: '100%', background: 'var(--panel-2)', position: 'relative' }}>
              <Cover art={r.artworkUrl} title={r.title} />
              {(() => {
                const w = releaseWorst(r);
                return presence.stores.length > 0 && w !== 'pending' ? (
                  <span
                    className={`pip sm ${w}`}
                    title={worstTitle[w]}
                    aria-label={worstTitle[w]}
                    style={{ position: 'absolute', top: 7, right: 7, width: 14, height: 14, borderRadius: '50%', boxShadow: '0 0 0 2px var(--panel)' }}
                  />
                ) : null;
              })()}
            </div>
            <div style={{ padding: '10px 11px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={r.title || ''}>{r.title || 'Untitled'}</div>
              {artistLine(r) && <div style={{ fontSize: 12, color: 'var(--mist)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{artistLine(r)}</div>}
              {(r.releaseType || r.version) && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 1 }}>
                  {r.releaseType && <Pill>{r.releaseType}</Pill>}
                  {r.version && <Pill tone="info">{r.version}</Pill>}
                </div>
              )}
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--mist-2)', marginTop: 4 }}>{r.tracks.length} track{r.tracks.length === 1 ? '' : 's'}{r.upc ? ` · UPC ${r.upc}` : ''}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
