'use client';

import { useCallback, useEffect, useState } from 'react';
import { humanizeToken } from '@sentinel/shared-ui';
import { apiFetch } from '@/lib/api-client';
import { mergeHistoryRows, SEARCH_HISTORY_NEXT_CURSOR_HEADER } from './history-pagination';

interface SearchSummary {
  id: string;
  name?: string;
  sourceSearchId?: string;
  createdAt: string;
  artist: string;
  distributor: string;
  platforms: string[];
  song: { title?: string; isrc?: string } | null;
  summary: { tracks: number; live: number; notLive: number; wrongProfile: number };
  stores: string[];
  deepScan?: { status: 'idle' | 'queued' | 'running' | 'done' | 'error'; platformsDone: string[]; platformsPending: string[] };
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
}

export function HistoryList() {
  const [rows, setRows] = useState<SearchSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (cursor?: string) => {
    const path = cursor ? `/api/searches?cursor=${encodeURIComponent(cursor)}` : '/api/searches';
    const response = await apiFetch(path);
    if (!response.ok) throw new Error(await errorMessage(response, 'Could not load audit history.'));
    const data = (await response.json()) as { searches?: SearchSummary[] };
    const page = data.searches ?? [];
    setRows((current) => cursor ? mergeHistoryRows(current ?? [], page) : page);
    setNextCursor(response.headers.get(SEARCH_HISTORY_NEXT_CURSOR_HEADER));
  }, []);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load audit history.'));
  }, [load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      await load(nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load more audit history.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function rename(row: SearchSummary) {
    const name = draftName.trim();
    if (!name) { setError('Enter a name for this audit.'); return; }
    setBusy(`rename:${row.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/searches/${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, 'The audit could not be renamed.'));
      setRows((current) => current?.map((item) => item.id === row.id ? { ...item, name } : item) ?? current);
      setEditingId(null);
      setNotice(`Renamed audit to “${name}”.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The audit could not be renamed.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: SearchSummary) {
    const label = row.name || row.artist;
    if (!window.confirm(`Delete “${label}” from your audit history? This cannot be undone.`)) return;
    setBusy(`delete:${row.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/searches/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(await errorMessage(response, 'The audit could not be deleted.'));
      setRows((current) => current?.filter((item) => item.id !== row.id) ?? current);
      setNotice(`Deleted “${label}”.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The audit could not be deleted.');
    } finally {
      setBusy(null);
    }
  }

  async function recheck(row: SearchSummary) {
    setBusy(`recheck:${row.id}`);
    setError(null);
    setNotice(null);
    try {
      const response = await apiFetch(`/api/searches/${encodeURIComponent(row.id)}/rescan`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(await errorMessage(response, 'The platform recheck could not be started.'));
      const created = (await response.json()) as { id?: unknown };
      if (typeof created.id !== 'string' || !created.id) throw new Error('The server did not return the new audit id.');
      window.location.assign(`/catalog?id=${encodeURIComponent(created.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The platform recheck could not be started.');
      setBusy(null);
    }
  }

  if (error && !rows) return <div className="notice-banner" role="alert" style={{ borderColor: 'var(--danger)' }}>{error}</div>;
  if (!rows) return <div className="cat-empty"><span className="spinner" /> Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="cat-empty">
        <div className="cat-empty-art" aria-hidden>◷ ◶ ◵ ◴</div>
        <p>No audits yet. <a href="/connect">Connect DistroKid and run your first audit</a>; it will appear here.</p>
      </div>
    );
  }

  return (
    <>
      {error && <div className="notice-banner" role="alert" style={{ borderColor: 'var(--danger)' }}>{error}</div>}
      {notice && <div className="notice-banner" role="status">{notice}</div>}
      <div className="history" id="audit-history-list">
        {rows.map((row) => {
          const active = row.deepScan?.status === 'idle' || row.deepScan?.status === 'queued' || row.deepScan?.status === 'running';
          const rowBusy = busy?.endsWith(`:${row.id}`) ?? false;
          return (
            <article key={row.id} className="history-row">
              <div className="history-main">
                {editingId === row.id ? (
                  <form className="history-rename" onSubmit={(event) => { event.preventDefault(); void rename(row); }}>
                    <label htmlFor={`scan-name-${row.id}`}>Audit name</label>
                    <input
                      id={`scan-name-${row.id}`}
                      className="filter"
                      value={draftName}
                      maxLength={120}
                      autoFocus
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                    <button className="btn" type="submit" disabled={rowBusy}>Save</button>
                    <button className="btn ghost" type="button" onClick={() => setEditingId(null)} disabled={rowBusy}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <a className="history-artist" href={`/catalog?id=${encodeURIComponent(row.id)}`}>{row.name || row.artist}</a>
                    {row.name && <div className="history-owner">{row.artist}</div>}
                  </>
                )}
                <div className="history-meta">
                  {cap(row.distributor)} · {row.stores.length} stores{row.song?.title ? ` · song: ${row.song.title}` : ''} · {when(row.createdAt)}
                  {row.sourceSearchId ? ' · saved-snapshot recheck' : ''}
                  {active && row.deepScan?.status ? ` · ${humanizeToken(row.deepScan.status)}` : ''}
                </div>
              </div>
              <div className="history-stats" aria-label="Audit summary">
                <span className="hstat"><b>{row.summary.tracks}</b> tracks</span>
                <span className="hstat warn"><b>{row.summary.notLive}</b> not confirmed</span>
                {row.summary.wrongProfile > 0 && <span className="hstat bad"><b>{row.summary.wrongProfile}</b> wrong profile</span>}
              </div>
              <div className="history-actions" aria-label={`Manage ${row.name || row.artist}`}>
                <a className="btn ghost" href={`/catalog?id=${encodeURIComponent(row.id)}`}>Open</a>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={rowBusy}
                  onClick={() => { setEditingId(row.id); setDraftName(row.name || `${row.artist} audit`); setError(null); }}
                >Rename</button>
                <button className="btn ghost" type="button" disabled={rowBusy || active} onClick={() => void recheck(row)}>Recheck platforms</button>
                <a className="btn ghost" href="/connect">Refresh from DistroKid</a>
                <button className="btn ghost history-delete" type="button" disabled={rowBusy || active} onClick={() => void remove(row)}>Delete</button>
              </div>
            </article>
          );
        })}
      </div>
      {nextCursor && (
        <div className="history-load-more">
          <button
            className="btn ghost"
            type="button"
            aria-controls="audit-history-list"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading older audits…' : 'Load more audit history'}
          </button>
        </div>
      )}
    </>
  );
}

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
