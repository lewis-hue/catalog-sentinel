'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';

/**
 * Missing Lyrics module, store-side (LRCLIB) client layer.
 *
 * The store-side lyric verdict now lives in Postgres next to the DistroKid-side status and is served
 * on each catalogue track (`storeLyricStatus`/`storeHasPlain`/`storeHasSynced`). This hook is only the
 * lightweight PROGRESS poller + trigger for the on-demand check; it polls `GET /lyrics-check` (a tiny
 * progress row) and, when the check finishes, calls `onCompleted` so the caller refetches the
 * catalogue to pull the fresh per-track verdicts. It never reads the search record, so the lyric
 * check shares no state with the store-presence scan and the two run fully independently.
 */

export type LyricsScanStatus = 'unchecked' | 'idle' | 'queued' | 'running' | 'done' | 'error';
export interface LyricsScan { status: LyricsScanStatus; checked: number; total: number; error?: string | null; checkedAt?: string | null }

/** The per-track lyric fields served on every catalogue track (both sides). */
export interface TrackLyrics {
  /** DistroKid-side: present | processing | none | unknown */
  plainLyrics: string;
  syncedLyrics: string;
  /** Store-side (LRCLIB): found | not-found | instrumental | unverifiable | unknown */
  storeLyricStatus: string;
  storeHasPlain: boolean;
  storeHasSynced: boolean;
}

export interface LyricsCheck {
  loading: boolean;
  error: string;
  lyricsScan: LyricsScan | null;
  running: boolean;
  triggering: boolean;
  triggerError: string;
  trigger(): Promise<void>;
}

export function useLyricsCheck(searchId: string | null, opts?: { onCompleted?: () => void }): LyricsCheck {
  const [lyricsScan, setLyricsScan] = useState<LyricsScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const prevStatus = useRef<LyricsScanStatus | null>(null);
  const onCompleted = useRef(opts?.onCompleted);
  onCompleted.current = opts?.onCompleted;

  const load = useCallback(async () => {
    if (!searchId) { setLoading(false); return; }
    try {
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/lyrics-check`);
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not load lyric verification.'));
      const data = (await res.json()) as { lyricsScan: LyricsScan | null };
      if (cancelled.current) return;
      const scan = data?.lyricsScan ?? null;
      // 'idle' is the default/never-run state (a CTA), NOT an active run, only queued/running poll.
      const st = scan?.status ?? 'unchecked';
      // Fire onCompleted on the transition out of an active state so the caller refreshes the catalogue.
      const wasActive = prevStatus.current === 'queued' || prevStatus.current === 'running';
      if (wasActive && (st === 'done' || st === 'error')) onCompleted.current?.();
      prevStatus.current = st;
      setLyricsScan(scan);
      setError('');
      if (st === 'queued' || st === 'running') {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(), 4000);
      }
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : 'Could not load lyric verification.');
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
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/lyrics-check`, { method: 'POST' });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not start the lyric check.'));
      prevStatus.current = 'queued';
      await load();
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : 'Could not start the lyric check.');
    } finally {
      setTriggering(false);
    }
  }, [searchId, load]);

  const status = lyricsScan?.status ?? 'unchecked';
  return {
    loading, error, lyricsScan,
    running: status === 'queued' || status === 'running',
    triggering, triggerError, trigger,
  };
}

// --- Coverage + the DistroKid-vs-stores comparison ----------------------------------------------

export interface LyricsCoverage {
  total: number;
  /** Store-side buckets */
  found: number; plain: number; synced: number; notFound: number; instrumental: number; unverifiable: number; pending: number;
  /** The comparison the module exists for */
  missingOnStore: number;   // DistroKid has lyrics, the stores don't
  missingOnDistroKid: number; // the stores have lyrics, DistroKid shows none
}

const dkHasLyrics = (t: TrackLyrics): boolean => t.plainLyrics === 'present' || t.syncedLyrics === 'present';
const storeHasLyrics = (t: TrackLyrics): boolean => t.storeLyricStatus === 'found' && (t.storeHasPlain || t.storeHasSynced);

export type LyricCompareVerdict = 'ok' | 'missing-on-store' | 'missing-on-distrokid' | 'none' | 'pending' | 'unverified';

/** Per-track reconciliation of what DistroKid says it submitted vs. what the stores actually expose. */
export function compareLyrics(t: TrackLyrics): { verdict: LyricCompareVerdict; label: string; cls: string; detail: string } {
  if (t.storeLyricStatus === 'unknown') return { verdict: 'pending', label: 'Not checked', cls: 'unk', detail: 'Store-side lyrics not verified yet.' };
  if (t.storeLyricStatus === 'unverifiable') return { verdict: 'unverified', label: 'Not verified', cls: 'unk', detail: 'The lyrics source could not confirm this track.' };
  const dk = dkHasLyrics(t);
  const store = storeHasLyrics(t);
  if (dk && !store) return { verdict: 'missing-on-store', label: 'Missing on stores', cls: 'wrong', detail: 'Lyrics are on your DistroKid release but not live on the stores.' };
  if (!dk && store) return { verdict: 'missing-on-distrokid', label: 'Not on DistroKid', cls: 'gap', detail: 'The stores have lyrics for this track but your DistroKid release shows none.' };
  if (dk && store) return { verdict: 'ok', label: 'In sync', cls: 'live', detail: 'Lyrics present on DistroKid and the stores.' };
  return { verdict: 'none', label: 'No lyrics', cls: 'muted', detail: 'No lyrics on DistroKid or the stores.' };
}

export function computeLyricsCoverage(tracks: TrackLyrics[]): LyricsCoverage {
  const cov: LyricsCoverage = { total: 0, found: 0, plain: 0, synced: 0, notFound: 0, instrumental: 0, unverifiable: 0, pending: 0, missingOnStore: 0, missingOnDistroKid: 0 };
  for (const t of tracks) {
    cov.total += 1;
    switch (t.storeLyricStatus) {
      case 'found': cov.found += 1; if (t.storeHasPlain) cov.plain += 1; if (t.storeHasSynced) cov.synced += 1; break;
      case 'not-found': cov.notFound += 1; break;
      case 'instrumental': cov.instrumental += 1; break;
      case 'unverifiable': cov.unverifiable += 1; break;
      default: cov.pending += 1; break;
    }
    const v = compareLyrics(t).verdict;
    if (v === 'missing-on-store') cov.missingOnStore += 1;
    else if (v === 'missing-on-distrokid') cov.missingOnDistroKid += 1;
  }
  return cov;
}

/** Store-side lyric availability for one track (LRCLIB), as compact status pills. */
export function LyricsStoreCell({ track }: { track: TrackLyrics }) {
  const s = track.storeLyricStatus;
  if (s === 'unknown') return <span className="status unk">Not checked</span>;
  if (s === 'unverifiable') return <span className="status unk">Not verified</span>;
  if (s === 'not-found') return <span className="status gap">Not on stores</span>;
  if (s === 'instrumental') return <span className="status info">Instrumental</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 5, flexWrap: 'wrap' }}>
      <span className={`status ${track.storeHasPlain ? 'live' : 'gap'}`}>Plain {track.storeHasPlain ? '✓' : '✗'}</span>
      <span className={`status ${track.storeHasSynced ? 'live' : 'gap'}`}>Synced {track.storeHasSynced ? '✓' : '✗'}</span>
    </span>
  );
}

/** The DistroKid-vs-stores reconciliation verdict for one track. */
export function LyricCompareCell({ track }: { track: TrackLyrics }) {
  const c = compareLyrics(track);
  return <span className={`status ${c.cls}`} title={c.detail}>{c.label}</span>;
}

/** Status + trigger control for the store-side lyric check. Mirrors StoreCheckBar in shape and tone. */
export function LyricsCheckBar({ check, coverage, compact = false }: { check: LyricsCheck; coverage: LyricsCoverage; compact?: boolean }) {
  const status = check.lyricsScan?.status ?? 'unchecked';
  const running = check.running;
  const busy = running || check.triggering;
  const cov = coverage;
  const checked = check.lyricsScan?.checked ?? 0;
  const total = check.lyricsScan?.total ?? cov.total;

  const message = (() => {
    if (check.triggering && !running) return 'Starting the lyric check…';
    if (status === 'queued') return 'Lyric check queued, verifying plain and synced availability across the stores.';
    if (status === 'running') return `Checking lyrics, ${checked} of ${total} track${total === 1 ? '' : 's'} resolved.`;
    if (status === 'error') return check.lyricsScan?.error ?? 'The lyric check could not finish. You can retry it.';
    if (status === 'done') {
      const parts: string[] = [];
      if (cov.missingOnStore) parts.push(`${cov.missingOnStore} missing on stores`);
      if (cov.missingOnDistroKid) parts.push(`${cov.missingOnDistroKid} not on DistroKid`);
      parts.push(`${cov.plain} plain`, `${cov.synced} synced`);
      if (cov.unverifiable) parts.push(`${cov.unverifiable} not verified`);
      return `${cov.total} track${cov.total === 1 ? '' : 's'} reconciled, ${parts.join(' · ')}.`;
    }
    return 'Store-side lyric availability has not been checked yet. Run a check (LRCLIB) to compare against your DistroKid lyrics.';
  })();

  const tone = status === 'error'
    ? { bg: 'var(--wrong-tint)', bd: 'var(--wrong-edge)' }
    : status === 'done'
      ? (cov.missingOnStore ? { bg: 'var(--wrong-tint)', bd: 'var(--wrong-edge)' } : { bg: 'var(--live-tint)', bd: 'var(--live-edge)' })
      : { bg: 'var(--info-tint)', bd: 'var(--info-edge)' };

  const label = check.triggering ? 'Starting…'
    : running ? 'Checking…'
      : status === 'done' ? 'Re-check lyrics'
        : status === 'error' ? 'Retry lyric check'
          : 'Check lyrics on stores';

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: compact ? '10px 12px' : '12px 14px', borderRadius: 10,
        border: `1px solid ${tone.bd}`, background: tone.bg, color: 'var(--paper)',
        margin: compact ? '0 0 12px' : '0 0 16px',
      }}
    >
      {busy && <span className="spinner" aria-hidden />}
      <span style={{ flex: '1 1 240px', fontSize: 13, fontWeight: 500 }}>{message}</span>
      {check.triggerError && <span style={{ fontSize: 12, color: 'var(--wrong)' }}>{check.triggerError}</span>}
      <button className="btn" onClick={() => void check.trigger()} disabled={busy}>{label}</button>
    </div>
  );
}
