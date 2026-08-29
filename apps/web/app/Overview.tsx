'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '@sentinel/shared-ui';
import { apiFetch } from '@/lib/api-client';
import { computeHealth, type HealthScore, type ScoreCatalogue, type ScoreRecord } from './scorecard/score';

const READING_SENTINEL = '__reading_in_progress__';
const ACTIVE_REFRESH_MS = 4_000;

interface ScanSummary {
  tracks: number;
  live: number;
  notLive: number;
  wrongProfile: number;
  needsReview: number;
}

interface DeepScanState {
  status: 'idle' | 'queued' | 'running' | 'done' | 'error';
  platformsPending: string[];
  platformsDone: string[];
  error?: string;
}

interface SearchRecord {
  id: string;
  createdAt: string;
  artist: string;
  distributor: string;
  result: {
    stores: string[];
    tracks: unknown[];
    summary: ScanSummary;
    warnings: string[];
    note: string;
  };
  deepScan?: DeepScanState;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; record: SearchRecord; recentAuditCount: number; health: HealthScore | null };

type AuditPhase = 'reading' | 'scanning' | 'complete' | 'failed';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDeepScanState(value: unknown): value is DeepScanState {
  if (!isObject(value)) return false;
  return (
    ['idle', 'queued', 'running', 'done', 'error'].includes(String(value.status)) &&
    Array.isArray(value.platformsPending) && value.platformsPending.every((platform) => typeof platform === 'string') &&
    Array.isArray(value.platformsDone) && value.platformsDone.every((platform) => typeof platform === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isSearchRecord(value: unknown): value is SearchRecord {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.artist !== 'string' ||
    typeof value.distributor !== 'string' ||
    (value.deepScan !== undefined && !isDeepScanState(value.deepScan))
  ) return false;
  if (!isObject(value.result) || !isObject(value.result.summary)) return false;
  const summary = value.result.summary;
  return (
    Array.isArray(value.result.stores) && value.result.stores.every((store) => typeof store === 'string') &&
    Array.isArray(value.result.tracks) &&
    Array.isArray(value.result.warnings) && value.result.warnings.every((warning) => typeof warning === 'string') &&
    typeof value.result.note === 'string' &&
    ['tracks', 'live', 'notLive', 'wrongProfile', 'needsReview'].every((key) => typeof summary[key] === 'number')
  );
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return body && typeof body.error === 'string' ? body.error : `${fallback} (${response.status})`;
}

function phaseOf(record: SearchRecord): AuditPhase {
  if (record.result.warnings.includes(READING_SENTINEL)) return 'reading';
  if (record.deepScan?.status === 'idle' || record.deepScan?.status === 'queued' || record.deepScan?.status === 'running') return 'scanning';
  if (record.deepScan?.status === 'error') return 'failed';
  if (record.result.tracks.length === 0 && record.result.warnings.some((warning) => /could not read|failed/i.test(warning))) return 'failed';
  return 'complete';
}

function phaseCopy(record: SearchRecord, phase: AuditPhase): { label: string; detail: string; tone: string } {
  if (phase === 'reading') {
    return { label: 'Reading catalog', detail: `Securely reading the ${record.distributor} catalog in the attended Steel session.`, tone: 'info' };
  }
  if (phase === 'scanning') {
    const done = record.deepScan?.platformsDone.length ?? 0;
    const pending = record.deepScan?.platformsPending.length ?? 0;
    const progress = done + pending > 0 ? ` ${done} of ${done + pending} platforms are complete.` : '';
    return { label: 'Audit in progress', detail: `The catalog snapshot is ready while store-presence verification continues.${progress}`, tone: 'info' };
  }
  if (phase === 'failed') {
    return { label: 'Needs attention', detail: record.result.note || 'The latest audit did not finish. Start a new secure connection to retry.', tone: 'wrong' };
  }
  return { label: 'Audit complete', detail: 'The latest saved catalog and its available platform evidence are ready to review.', tone: 'live' };
}

function formattedDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function OverviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading catalog overview">
      <div className="page-header">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Catalog operations</h1>
          <p className="page-sub" style={{ margin: 0 }}>Loading your latest tenant-scoped audit…</p>
        </div>
      </div>
      <section className="card">
        <span className="skel" style={{ width: 180, height: 18 }} />
        <span className="skel" style={{ width: '70%', height: 13, marginTop: 14 }} />
      </section>
      <div className="row">
        {Array.from({ length: 5 }).map((_, index) => (
          <div className="stat" key={index} aria-hidden>
            <span className="skel" style={{ width: 46, height: 28 }} />
            <span className="skel" style={{ width: 86, height: 11, marginTop: 8 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function Overview() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async (initial: boolean) => {
      if (initial) setState({ kind: 'loading' });
      try {
        const listResponse = await apiFetch('/api/searches', { signal: controller.signal, cache: 'no-store' });
        if (!listResponse.ok) throw new Error(await responseError(listResponse, 'Could not load saved audits'));
        const listBody = (await listResponse.json()) as unknown;
        if (!isObject(listBody) || !Array.isArray(listBody.searches)) throw new Error('The audit list response was invalid.');
        const searches = listBody.searches.filter((item): item is { id: string } => isObject(item) && typeof item.id === 'string');
        const latest = searches[0];
        if (!latest) {
          setState({ kind: 'empty' });
          return;
        }

        const recordResponse = await apiFetch(`/api/searches/${encodeURIComponent(latest.id)}`, { signal: controller.signal, cache: 'no-store' });
        if (!recordResponse.ok) throw new Error(await responseError(recordResponse, 'Could not load the latest audit'));
        const record = (await recordResponse.json()) as unknown;
        if (!isSearchRecord(record)) throw new Error('The latest audit response was invalid.');
        // Health score (best-effort): the catalogue endpoint provides the metadata-completeness
        // counts; the record provides store/identity/lyric results.
        let health: HealthScore | null = null;
        try {
          const catRes = await apiFetch(`/api/searches/${encodeURIComponent(latest.id)}/catalogue`, { signal: controller.signal, cache: 'no-store' });
          if (catRes.ok) health = computeHealth((await catRes.json()) as ScoreCatalogue, record as unknown as ScoreRecord);
        } catch { /* best-effort, the overview still renders without a score */ }
        setState({ kind: 'ready', record, recentAuditCount: searches.length, health });

        const phase = phaseOf(record);
        if (phase === 'reading' || phase === 'scanning') timer = setTimeout(() => void load(false), ACTIVE_REFRESH_MS);
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load the catalog overview.' });
      }
    };

    void load(true);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  const ready = state.kind === 'ready' ? state : null;
  const phase = useMemo(() => ready ? phaseOf(ready.record) : null, [ready]);

  if (state.kind === 'loading') return <OverviewLoading />;

  if (state.kind === 'empty') {
    return (
      <>
        <div className="page-header">
          <div>
            <div className="eyebrow">Overview</div>
            <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Catalog operations</h1>
            <p className="page-sub" style={{ margin: 0 }}>This workspace has no saved catalog audit yet.</p>
          </div>
        </div>
        <div className="cat-empty">
          <p>Connect DistroKid through an attended Steel session to import the catalog and begin store-presence verification.</p>
          <Link className="btn" href="/connect" style={{ marginTop: 16 }}>Connect DistroKid</Link>
        </div>
      </>
    );
  }

  if (state.kind === 'error') {
    return (
      <>
        <div className="page-header">
          <div>
            <div className="eyebrow">Overview</div>
            <h1 className="page-title" style={{ margin: '6px 0 4px' }}>Catalog operations</h1>
            <p className="page-sub" style={{ margin: 0 }}>Your catalog could not be loaded.</p>
          </div>
        </div>
        <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>
          <span>{state.message}</span>
        </div>
        <button className="btn" type="button" onClick={() => setReload((value) => value + 1)}>Try again</button>
      </>
    );
  }

  const { record, recentAuditCount, health } = state;
  const currentPhase = phase ?? phaseOf(record);
  const phaseText = phaseCopy(record, currentPhase);
  const summary = record.result.summary;
  const idQuery = `?id=${encodeURIComponent(record.id)}`;
  const publicWarnings = record.result.warnings.filter((warning) => warning !== READING_SENTINEL);
  const ringColor = (n: number | null): string => (n == null ? 'var(--line)' : n >= 80 ? 'var(--live)' : n >= 60 ? 'var(--gap)' : 'var(--wrong)');
  const MODULES: Array<{ href: string; label: string; desc: string }> = [
    { href: `/scorecard${idQuery}`, label: 'Health score', desc: 'Your catalogue health at a glance' },
    { href: `/catalogue${idQuery}`, label: 'Catalogue', desc: 'Every release, metadata & art' },
    { href: `/catalog${idQuery}`, label: 'Store health', desc: 'Live / missing across every store' },
    { href: `/identity${idQuery}`, label: 'Identity guardian', desc: 'Wrong-profile & namesake checks' },
    { href: `/fixer${idQuery}`, label: 'One-click fixer', desc: 'Prepared fixes for every gap' },
    { href: '/alerts', label: 'Release alerts', desc: 'What changed since last scan' },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="eyebrow">Overview</div>
          <h1 className="page-title" style={{ margin: '6px 0 4px' }}>{record.artist}</h1>
          <p className="page-sub" style={{ margin: 0 }}>Latest audit started {formattedDate(record.createdAt)}</p>
        </div>
        <Link className="btn" href="/connect">Run new audit</Link>
      </div>

      <section className="card" aria-live="polite" aria-atomic="true">
        <div className="section-header">
          <div>
            <div className="eyebrow">Latest audit</div>
            <h2 style={{ margin: '6px 0 0' }}>Catalog and platform verification</h2>
          </div>
          <span className={`status ${phaseText.tone}`}>{phaseText.label}</span>
        </div>
        <p className="page-sub" style={{ marginBottom: 0 }}>{phaseText.detail}</p>
        {record.result.note && currentPhase !== 'failed' && <p className="cat-note" style={{ marginTop: 10 }}>{record.result.note}</p>}
      </section>

      {health && health.overall != null && (
        <section className="card health-hero" aria-label={`Catalogue health ${health.overall} of 100, grade ${health.grade}`}>
          <div>
            <div className="eyebrow">Catalogue health</div>
            <div className="hh-score-row">
              <div className="hero-num" style={{ color: ringColor(health.overall) }}>{health.overall}</div>
              <div className="hh-grade">Grade {health.grade} <small>/ 100</small></div>
            </div>
            <p className="hh-verdict">
              {health.overall >= 80
                ? <>A <em>healthy</em> catalogue, a few store gaps left to close.</>
                : health.overall >= 60
                  ? <>Solid overall, with <em>some gaps</em> worth closing.</>
                  : <>Your catalogue <em>needs attention</em> across a few areas.</>}
            </p>
          </div>
          <div className="hh-breakdown">
            {health.components.map((c) => (
              <div className="brk" key={c.key}>
                <span className="brk-k">{c.label}</span>
                <span className="brk-bar"><i style={{ width: `${c.score ?? 0}%`, background: c.score == null ? 'var(--line)' : c.score >= 80 ? 'var(--live)' : c.score >= 60 ? 'var(--gap)' : 'var(--wrong)' }} /></span>
                <span className="brk-v">{c.score == null ? '-' : c.score}</span>
              </div>
            ))}
          </div>
          <Link className="btn" href={`/scorecard${idQuery}`}>View breakdown</Link>
        </section>
      )}

      <div className="row" style={{ marginBottom: 22 }}>
        <StatCard label="Catalog tracks" value={summary.tracks} />
        <StatCard label="Confirmed cells" value={summary.live} tone="good" />
        <StatCard label="Not confirmed" value={summary.notLive} tone={summary.notLive ? 'warn' : 'neutral'} />
        <StatCard label="Wrong profile" value={summary.wrongProfile} tone={summary.wrongProfile ? 'bad' : 'neutral'} />
        <StatCard label="Needs review" value={summary.needsReview} tone={summary.needsReview ? 'warn' : 'neutral'} />
        <StatCard label="Platforms checked" value={record.result.stores.length} />
        <StatCard label="Recent audits" value={recentAuditCount} />
      </div>

      {publicWarnings.length > 0 && (
        <section className="card">
          <div className="section-header"><h2 style={{ margin: 0 }}>Audit notes</h2><span className="status gap">{publicWarnings.length} warning{publicWarnings.length === 1 ? '' : 's'}</span></div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {publicWarnings.slice(0, 4).map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="section-header"><h2 style={{ margin: 0 }}>Catalogue toolkit</h2></div>
        <div className="mod-grid">
          {MODULES.map((m) => (
            <Link key={m.href} href={m.href} className="mod-card">
              <h3>{m.label}</h3>
              <p>{m.desc}</p>
              <span className="mod-go">Open →</span>
            </Link>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Link className="btn ghost" href={`/review${idQuery}`}>Manual review</Link>
          <Link className="btn ghost" href={`/support${idQuery}`}>Support center</Link>
          <Link className="btn ghost" href="/history">Audit history</Link>
        </div>
      </section>
    </>
  );
}
