'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { platformCode, statusClass } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';

/** Normalize a DistroKid "Submitted to X" store name to the store name the grid + platformCode use.
 *  DistroKid uses slightly different labels (Tidal→TIDAL, Saavn→JioSaavn, Amazon→Amazon Music, etc.)
 *  and adds suffixes like "(beta)" / "& other ByteDance stores". */
export function normalizeStoreName(raw: string): string {
  const n = raw.toLowerCase().replace(/\(beta\)/g, '').replace(/&.*$/, '').replace(/\s+/g, ' ').trim();
  if (n === 'itunes' || n.includes('apple')) return 'Apple Music / iTunes';
  if (n.includes('amazon')) return 'Amazon Music';
  if (n.includes('tidal')) return 'TIDAL';
  if (n.includes('saavn')) return 'JioSaavn';
  if (n.includes('joox')) return 'JOOX';
  if (n === 'flo') return 'FLO';
  if (n.includes('claro')) return 'Claro Música';
  if (n.includes('tiktok')) return 'TikTok';
  if (n.includes('youtube')) return 'YouTube Music';
  if (n.includes('netease')) return 'NetEase';
  if (n.includes('tencent')) return 'Tencent';
  if (n.includes('instagram') || n.includes('facebook')) return 'Instagram/Facebook';
  if (n.includes('iheart')) return 'iHeartRadio';
  if (n.includes('touchtunes')) return 'TouchTunes';
  if (n.includes('kuack')) return 'Kuack Media';
  if (n.includes('medianet')) return 'MediaNet';
  // Spotify, Deezer, Pandora, Boomplay, Anghami, Qobuz, Snapchat, Adaptr, Audiomack, KKBox, Yandex
  // already match (title-cased), strip any suffix and title-case the first letter.
  const clean = raw.replace(/\s*\(beta\)\s*/i, '').replace(/\s*&.*$/, '').trim();
  return clean;
}

/** Build a normalized store→deep-link map from a release's DistroKid submittedStores. */
export function deliveredMapFrom(submitted: Array<{ store: string; url: string | null }> | undefined): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const s of submitted ?? []) {
    const key = normalizeStoreName(s.store);
    if (!m.has(key) || (s.url && !m.get(key))) m.set(key, s.url);
  }
  return m;
}

/**
 * Missing Songs module, client layer.
 *
 * Store-presence verification is a SEPARATE product surface from the scraped catalogue (the scrape
 * is decoupled from the store check on the backend). This hook reads the search record, where the
 * background presence worker writes `result.tracks[].perStore`, and joins it back to the catalogue
 * by ISRC (falling back to title), so each release/track can show a live/missing grid. It also
 * exposes the on-demand trigger (`POST /store-check`) and polls while a check is running.
 */

export interface PerStore {
  store: string;
  status: string; // 'live' | 'not-live' | 'wrong-profile' | 'unverifiable'
  foundArtist: string | null;
  url: string | null;
  confidence: number;
  needsManualReview: boolean;
  reviewQuery: string | null;
}
interface PresenceTrack { title: string | null; isrc: string | null; perStore: PerStore[] }
export type DeepScanStatus = 'unchecked' | 'idle' | 'queued' | 'running' | 'done' | 'error';
export interface DeepScan {
  status: DeepScanStatus;
  platformsPending: string[];
  platformsDone: string[];
  tracksScanned?: number;
  error?: string;
}
interface SearchRecord {
  id: string;
  deepScan?: DeepScan;
  result: { stores: string[]; tracks: PresenceTrack[] };
}

const isrcKey = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();
const titleKey = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

export type Worst = 'live' | 'gap' | 'wrong' | 'unk' | 'pending';

/** Worst per-store verdict for one track: a single red store makes the whole track "missing". */
export function worstOf(cells: PerStore[]): Worst {
  if (!cells.length) return 'pending';
  const has = (st: string) => cells.some((c) => c.status === st);
  return has('wrong-profile') ? 'wrong' : has('not-live') ? 'gap' : has('unverifiable') ? 'unk' : 'live';
}

const statusLabel = (status: string): string =>
  status === 'live' ? 'live'
    : status === 'not-live' ? 'missing'
      : status === 'wrong-profile' ? 'wrong profile'
        : 'unverifiable';

export interface Coverage { total: number; live: number; missing: number; wrong: number; review: number; pending: number }

export interface StorePresence {
  loading: boolean;
  error: string;
  stores: string[];
  deepScan: DeepScan | null;
  coverage: Coverage;
  /** Per-store cells for a catalogue track, matched by ISRC then title. Empty = not checked. */
  cellsForTrack(track: { isrc: string | null; title: string | null }): PerStore[];
  triggering: boolean;
  triggerError: string;
  trigger(): Promise<void>;
}

export function useStorePresence(searchId: string | null): StorePresence {
  const [record, setRecord] = useState<SearchRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    if (!searchId) { setLoading(false); return; }
    try {
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}`);
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load store presence.'));
      const data = (await res.json()) as SearchRecord;
      if (cancelled.current) return;
      setRecord(data);
      setError('');
      const st = data?.deepScan?.status;
      // Poll only while a job is genuinely in flight, `unchecked`/`done`/`error` are terminal.
      if (st === 'queued' || st === 'running' || st === 'idle') {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 4000);
      }
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Could not load store presence.');
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [searchId]);

  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    setError('');
    void load();
    return () => { cancelled.current = true; if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  const trigger = useCallback(async () => {
    if (!searchId) return;
    setTriggering(true);
    setTriggerError('');
    try {
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/store-check`, { method: 'POST' });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not start the store check.'));
      await load(); // reflect the queued state and begin polling
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : 'Could not start the store check.');
    } finally {
      setTriggering(false);
    }
  }, [searchId, load]);

  const { byIsrc, byTitle } = useMemo(() => {
    const bi = new Map<string, PerStore[]>();
    const bt = new Map<string, PerStore[]>();
    for (const t of record?.result.tracks ?? []) {
      const cells = t.perStore ?? [];
      const ik = isrcKey(t.isrc);
      if (ik) bi.set(ik, cells);
      const tk = titleKey(t.title);
      if (tk && !bt.has(tk)) bt.set(tk, cells);
    }
    return { byIsrc: bi, byTitle: bt };
  }, [record]);

  const coverage = useMemo<Coverage>(() => {
    const cov: Coverage = { total: 0, live: 0, missing: 0, wrong: 0, review: 0, pending: 0 };
    for (const t of record?.result.tracks ?? []) {
      cov.total += 1;
      const w = worstOf(t.perStore ?? []);
      if (w === 'live') cov.live += 1;
      else if (w === 'gap') cov.missing += 1;
      else if (w === 'wrong') cov.wrong += 1;
      else if (w === 'unk') cov.review += 1;
      else cov.pending += 1;
    }
    return cov;
  }, [record]);

  const cellsForTrack = useCallback((track: { isrc: string | null; title: string | null }): PerStore[] => {
    const ik = isrcKey(track.isrc);
    if (ik && byIsrc.has(ik)) return byIsrc.get(ik)!;
    const tk = titleKey(track.title);
    if (tk && byTitle.has(tk)) return byTitle.get(tk)!;
    return [];
  }, [byIsrc, byTitle]);

  return {
    loading,
    error,
    stores: record?.result.stores ?? [],
    deepScan: record?.deepScan ?? null,
    coverage,
    cellsForTrack,
    triggering,
    triggerError,
    trigger,
  };
}

/** One pip per verified store; a store with no cell for this track shows as an unchecked pip. A `♪`
 *  superscript marks a store confirmed (via Serper) to actually DISPLAY this song's lyrics. */
export function StorePips({ cells, stores, delivered, lyrics }: { cells: PerStore[]; stores: string[]; delivered?: Map<string, string | null>; lyrics?: Record<string, string> }) {
  if (!stores.length) return <span className="status unk">Not checked</span>;
  const byStore = new Map(cells.map((c) => [c.store, c] as const));
  return (
    <div style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap' }}>
      {stores.map((s) => {
        const c = byStore.get(s);
        // An unchecked/unverifiable store that DistroKid reports it delivered → "Delivered".
        const isDelivered = (!c || c.status === 'unverifiable') && !!delivered?.has(s);
        const cls = isDelivered ? 'delivered' : c ? statusClass(c.status) : 'unk';
        const url = isDelivered ? (delivered!.get(s) || undefined) : (c?.url || undefined);
        const showsLyrics = lyrics?.[s] === 'shown';
        const title = (isDelivered
          ? `${s}: Delivered by DistroKid (not independently verified)`
          : c
            ? `${s}: ${statusLabel(c.status)}${c.foundArtist ? ` (${c.foundArtist})` : ''}`
            : `${s}: not checked`) + (showsLyrics ? ' · shows lyrics' : '');
        const body = <>{platformCode(s)}{showsLyrics ? <sup style={{ fontSize: 8, marginLeft: 1, opacity: 0.9 }}>♪</sup> : null}</>;
        return url
          ? <a key={s} className={`pip ${cls}`} href={url} target="_blank" rel="noreferrer" title={title} style={{ textDecoration: 'none' }}>{body}</a>
          : <span key={s} className={`pip ${cls}`} title={title}>{body}</span>;
      })}
    </div>
  );
}

/** Per-song signal that DistroKid distributed the lyrics to stores (a LyricFind page confirms it). */
export function LyricFindPill({ url }: { url?: string | null }) {
  const title = 'LyricFind confirms DistroKid distributed this song’s lyrics to stores';
  return url
    ? <a className="status live" href={url} target="_blank" rel="noreferrer" title={title} style={{ textDecoration: 'none' }}>Lyrics distributed</a>
    : <span className="status live" title={title}>Lyrics distributed</span>;
}

/** Compact verdict for a track's worst per-store outcome. */
export function VerdictPill({ worst }: { worst: Worst }) {
  if (worst === 'live') return <span className="status live">On every store</span>;
  if (worst === 'wrong') return <span className="status wrong">Wrong profile</span>;
  if (worst === 'gap') return <span className="status gap">Missing on a store</span>;
  if (worst === 'unk') return <span className="status unk">To review</span>;
  return <span className="status unk">Not checked</span>;
}

/**
 * Status + trigger control for the Missing Songs module. Renders the current state of the store
 * check for a whole catalogue and the button to run (or re-run) it on demand.
 */
export function StoreCheckBar({ presence, compact = false }: { presence: StorePresence; compact?: boolean }) {
  const status = presence.deepScan?.status ?? 'unchecked';
  const done = presence.deepScan?.platformsDone.length ?? 0;
  const pending = presence.deepScan?.platformsPending.length ?? 0;
  const running = status === 'queued' || status === 'running' || status === 'idle';
  const busy = running || presence.triggering;
  const cov = presence.coverage;

  const message = (() => {
    if (presence.triggering && !running) return 'Starting the store check…';
    if (status === 'queued') return 'Store check queued, verifying availability across every store.';
    if (status === 'running') return `Checking stores, ${done} of ${done + pending} platform${done + pending === 1 ? '' : 's'} done.`;
    if (status === 'idle') return 'Store check starting…';
    if (status === 'error') return presence.deepScan?.error ?? 'The store check could not finish. You can retry it.';
    if (status === 'done') {
      const parts = [`${cov.live} live everywhere`];
      if (cov.missing) parts.push(`${cov.missing} missing on a store`);
      if (cov.wrong) parts.push(`${cov.wrong} wrong profile`);
      if (cov.review) parts.push(`${cov.review} to review`);
      return `${cov.total} track${cov.total === 1 ? '' : 's'} checked, ${parts.join(' · ')}.`;
    }
    return 'Store presence has not been checked yet. Run a check to verify each track across the stores.';
  })();

  const tone = status === 'error'
    ? { bg: 'var(--wrong-tint)', bd: 'var(--wrong-edge)', fg: 'var(--wrong)' }
    : status === 'done' && (cov.missing || cov.wrong)
      ? { bg: 'var(--gap-tint)', bd: 'var(--gap-edge)', fg: 'var(--gap)' }
      : status === 'done'
        ? { bg: 'var(--live-tint)', bd: 'var(--live-edge)', fg: 'var(--live)' }
        : { bg: 'var(--info-tint)', bd: 'var(--info-edge)', fg: 'var(--info)' };

  const label = presence.triggering ? 'Starting…'
    : running ? 'Checking…'
      : status === 'done' ? 'Re-check stores'
        : status === 'error' ? 'Retry store check'
          : 'Check stores';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: compact ? '10px 12px' : '12px 14px', borderRadius: 10,
        border: `1px solid ${tone.bd}`, background: tone.bg, color: tone.fg,
        margin: compact ? '0 0 12px' : '0 0 16px',
      }}
    >
      {busy && <span className="spinner" aria-hidden />}
      <span style={{ flex: '1 1 240px', fontSize: 13, fontWeight: 500, color: 'var(--paper)' }}>{message}</span>
      {presence.triggerError && <span style={{ fontSize: 12, color: 'var(--wrong)' }}>{presence.triggerError}</span>}
      <button
        className={`btn ${status === 'done' && !cov.missing && !cov.wrong ? 'ok' : ''}`}
        onClick={() => void presence.trigger()}
        disabled={busy}
      >
        {label}
      </button>
    </div>
  );
}
