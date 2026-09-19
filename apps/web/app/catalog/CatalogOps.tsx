'use client';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { platformCode, statusClass, downloadCsv, NoAudit, Readout } from '@sentinel/shared-ui';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { failureReasonSummary } from './failure-reasons';
import { useStorePresence, StoreCheckBar, deliveredMapFrom } from '../catalogue/store-presence';
import { useLyricsCheck, LyricsCheckBar, computeLyricsCoverage, type TrackLyrics } from '../catalogue/lyrics-check';
import { CoverageLegend } from '../_components/CoverageLegend';

// Matches READING_SENTINEL in apps/api/src/distributor-connect.ts, marks a record whose
// catalogue is still being read in the background so the page polls until it fills in.
const READING_SENTINEL = '__reading_in_progress__';

// Max track rows rendered at once (a 1000+ song / multi-artist label catalogue stays
// responsive; the rest is reachable via search/filters, and CSV export covers everything).
const RENDER_CAP = 2000;

interface PerStore { store: string; status: string; foundArtist: string | null; url: string | null; confidence: number; needsManualReview: boolean; reviewDecision?: string }
type MetadataFieldStatus = 'PRESENT' | 'ABSENT_AT_SOURCE' | 'NOT_CAPTURED' | 'PARSE_FAILED' | 'REQUEST_FAILED' | 'TIMEOUT' | 'REAUTH_REQUIRED' | 'NOT_AUTHORIZED' | 'UNKNOWN';
interface MetadataField { value?: string; status: MetadataFieldStatus; source: string; capturedAt: string; parserVersion: string }
interface TrackMetadata { isrc?: MetadataField; upc?: MetadataField; artworkUrl?: MetadataField; label?: MetadataField; releaseDate?: MetadataField; uploadDate?: MetadataField }
interface Track { title: string; primaryArtist?: string | null; featuredArtists?: string[]; album: string | null; isrc: string | null; artworkUrl?: string | null; perStore: PerStore[]; label?: string | null; upc?: string | null; releaseDate?: string | null; uploadDate?: string | null; metadata?: TrackMetadata }
interface ExtractionCompleteness {
  expectedReleases: number; attemptedReleases: number; completedReleases: number; failedReleases: number; skippedReleases: number;
  expectedTracksKnown: boolean; expectedTracks: number; extractedTracks: number;
  releasesWithUpc: number; releasesWithArtwork: number; tracksWithIsrc: number; tracksWithDistributorId: number;
  releasesUpcAbsentAtSource: number; tracksIsrcAbsentAtSource: number; releasesUpcNotCaptured: number; tracksIsrcNotCaptured: number;
  unresolvedReleaseIds: string[]; failureReasons: Record<string, number>;
}
interface DistributorExtraction { engine: string; status: string; finalizedAt: string; completeness: ExtractionCompleteness }
interface ScanResult { artist: string; stores: string[]; tracks: Track[]; summary: { tracks: number; live: number; notLive: number; wrongProfile: number; needsReview: number }; warnings?: string[]; note?: string; distributorExtraction?: DistributorExtraction }
interface DeepScanState { status: 'idle' | 'queued' | 'running' | 'done' | 'error'; platformsPending: string[]; platformsDone: string[]; error?: string }
interface SearchRecord { id: string; artist: string; distributor?: string; createdAt: string; result: ScanResult; deepScan?: DeepScanState }

interface Row { title: string; artist: string | null; featuredArtists: string[]; isrc: string | null; album: string | null; art: string | null; label: string | null; upc: string | null; releaseDate: string | null; uploadDate: string | null; metadata?: TrackMetadata; cells: PerStore[]; worst: 'wrong' | 'gap' | 'unk' | 'pending' | 'live'; live: number; issues: number; mark: string | null; markRef: { releaseId: string; trackIndex: number } | null }
interface Group { key: string; title: string; artist: string | null; art: string | null; label: string | null; upc: string | null; releaseDate: string | null; uploadDate: string | null; metadata?: TrackMetadata; rows: Row[] }

// A manual track mark is stored per (releaseId, trackIndex) in Postgres and served on catalogue
// tracks. This grid is record-based, so we join to the catalogue by ISRC (reliable) then by
// release+title (fallback) to attach each row's mark + its write key.
interface MarkInfo { releaseId: string; trackIndex: number; mark: string | null }
const isrcMarkKey = (isrc: string | null | undefined): string | null => (isrc && isrc.trim() ? `i:${isrc.trim().toUpperCase()}` : null);
const contentMarkKey = (album: string | null | undefined, title: string | null | undefined): string => `c:${(album ?? '').trim().toLowerCase()}::${(title ?? '').trim().toLowerCase()}`;
const selId = (ref: { releaseId: string; trackIndex: number }): string => `${ref.releaseId}:${ref.trackIndex}`;

// DistroKid rows read as "Title Single Artist"; strip the trailing release-type word and the
// artist so the title reads cleanly (mirrors the scraper's cleanup for older saved records).
function cleanTitle(raw: string | null | undefined, artist: string | null | undefined): string {
  let t = (raw ?? '').trim();
  if (!t) return t;
  if (artist && artist.trim()) {
    const a = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp('[\\s\\-–—·|,]*' + a + '\\s*$', 'i'), '').trim();
  }
  t = t.replace(/[\s\-–—·|,]*(single|album|ep|lp|deluxe|mixtape)\s*$/i, '').trim();
  return t || (raw ?? '').trim();
}
const isRealTitle = (t: string | null | undefined): boolean => !!t && !/^untitled/i.test(t.trim()) && !/^track\s*\d+$/i.test(t.trim());

/** Cover art with a graceful initial-tile fallback (missing art, or a src that won't load). */
function Cover({ art, title, size = 48 }: { art: string | null; title: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const initial = (title || '?').trim().charAt(0).toUpperCase() || '♪';
  if (!art || failed) return <div className="rel-cover ph" style={{ width: size, height: size }} aria-hidden>{initial}</div>;
  // A plain <img>, deliberately. Artwork URLs come from whatever CDN the user's distributor
  // happens to serve, which we cannot know ahead of time, `next/image` requires every remote
  // host to be pre-declared in `remotePatterns`, so it would silently fail to render art from
  // any host we hadn't listed. Optimizing someone else's CDN image also buys little here: these
  // are already-small square thumbnails, and they are lazy-loaded.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="rel-cover" src={art} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

const FILTERS: Array<{ key: string; label: string; cls?: string; test: (r: Row) => boolean }> = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'marked-missing', label: 'Marked missing', cls: 'bad', test: (r) => r.mark === 'missing' },
  { key: 'not-confirmed', label: 'Not confirmed', cls: 'warn', test: (r) => r.cells.some((c) => c.status === 'not-live') },
  { key: 'unverifiable', label: 'Unverifiable', cls: 'ghost', test: (r) => r.cells.some((c) => c.status === 'unverifiable') },
  { key: 'wrong', label: 'Wrong profile', cls: 'bad', test: (r) => r.cells.some((c) => c.status === 'wrong-profile') },
  { key: 'review', label: 'Needs review', cls: 'warn', test: (r) => r.cells.some((c) => c.needsManualReview) },
  { key: 'isrc-source-absent', label: 'No ISRC at source', cls: 'ghost', test: (r) => !r.isrc && r.metadata?.isrc?.status === 'ABSENT_AT_SOURCE' },
  { key: 'isrc-not-captured', label: 'ISRC not captured', cls: 'warn', test: (r) => !r.isrc && !!r.metadata?.isrc && r.metadata.isrc.status !== 'ABSENT_AT_SOURCE' },
  { key: 'isrc-legacy-unknown', label: 'ISRC status unknown', cls: 'ghost', test: (r) => !r.isrc && !r.metadata?.isrc },
];

const fmtDate = (d?: string | null): string => {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

const CAPTURE_REASON: Record<Exclude<MetadataFieldStatus, 'PRESENT' | 'ABSENT_AT_SOURCE'>, string> = {
  NOT_CAPTURED: 'capture did not complete',
  PARSE_FAILED: 'parser could not read the value',
  REQUEST_FAILED: 'request failed',
  TIMEOUT: 'request timed out',
  REAUTH_REQUIRED: 'reconnection required',
  NOT_AUTHORIZED: 'account did not authorize access',
  UNKNOWN: 'reason unknown',
};

function evidenceText(value: string | null | undefined, evidence?: MetadataField, format: (value: string) => string = (item) => item): string {
  if (!evidence) return value ? format(value) : 'Capture status unknown';
  if (evidence.status === 'ABSENT_AT_SOURCE') return 'Not provided by distributor';
  if (evidence.status !== 'PRESENT') return `Not captured, ${CAPTURE_REASON[evidence.status]}`;
  const capturedValue = evidence.value ?? value;
  return capturedValue ? format(capturedValue) : 'Not captured, recorded value unavailable';
}

function evidenceTitle(evidence?: MetadataField): string | undefined {
  if (!evidence) return 'Field-level capture evidence was not retained for this record.';
  return `${evidence.status} · ${evidence.source} · parser ${evidence.parserVersion} · ${evidence.capturedAt}`;
}

function MetadataValue({ value, evidence, format }: { value?: string | null; evidence?: MetadataField; format?: (value: string) => string }) {
  return <span title={evidenceTitle(evidence)}>{evidenceText(value, evidence, format)}</span>;
}

function csvEvidence(value: string | null, evidence?: MetadataField): string[] {
  // Once evidence exists, only a PRESENT canonical value belongs in the distributor field.
  // A scalar may have been enriched later from a DSP (notably cover art); exporting it beside a
  // distributor TIMEOUT would silently turn fallback presentation data into source-of-truth data.
  const canonicalValue = evidence
    ? (evidence.status === 'PRESENT' ? (evidence.value ?? value ?? '') : '')
    : (value ?? '');
  return [
    canonicalValue,
    evidence?.status ?? 'LEGACY_UNKNOWN',
    evidence?.source ?? '',
    evidence?.capturedAt ?? '',
    evidence?.parserVersion ?? '',
  ];
}

function ExtractionBanner({ extraction }: { extraction?: DistributorExtraction }) {
  if (!extraction) {
    return (
      <div className="notice-banner" role="status">
        Extraction completeness and field provenance are unavailable for this scan. Blank metadata is reported as “Capture status unknown,” not as missing at the distributor.
      </div>
    );
  }
  const c = extraction.completeness;
  const releases = `${c.completedReleases}/${c.expectedReleases} releases verified`;
  const tracks = c.expectedTracksKnown
    ? `${c.extractedTracks}/${c.expectedTracks} tracks verified`
    : `${c.extractedTracks} tracks observed; the distributor did not expose an independent track total, so this does not prove every track was listed`;
  const failures = failureReasonSummary(c.failureReasons);
  const complete = extraction.status === 'COMPLETE' || extraction.status === 'COMPLETE_WITH_SOURCE_GAPS';
  const indexNotEstablished = extraction.status === 'FAILED'
    && c.expectedReleases === 0
    && c.completedReleases === 0;
  return (
    <div
      className="notice-banner"
      role={complete ? 'status' : 'alert'}
      style={complete ? undefined : { borderColor: 'var(--gap-edge)', background: 'var(--gap-tint)', color: 'var(--gap)' }}
    >
      {indexNotEstablished
        ? 'Distributor extraction: failed. The distributor catalogue index could not be established, so no release or track total was verified. This result is not evidence that the account contains zero releases or zero tracks.'
        : `Distributor extraction: ${extraction.status.replaceAll('_', ' ').toLowerCase()}. ${releases}; ${tracks}.`}
      {c.unresolvedReleaseIds.length > 0 ? ` ${c.unresolvedReleaseIds.length} release${c.unresolvedReleaseIds.length === 1 ? '' : 's'} remain unresolved.` : ''}
      {failures ? ` Failure codes: ${failures}.` : ''}
    </div>
  );
}

export function CatalogOps() {
  const savedId = useSearchParams().get('id');
  const [rec, setRec] = useState<SearchRecord | null>(null);
  const [state, setState] = useState<'loading' | 'reading' | 'ready' | 'empty' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  // Manual marks: a lookup (by ISRC / release+title) → {releaseId, trackIndex, mark}, plus row selection.
  const [markLookup, setMarkLookup] = useState<Map<string, MarkInfo>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState('');
  // Store-side lyric fields per track (from the catalogue) → the lyric-check coverage summary.
  const [lyricTracks, setLyricTracks] = useState<TrackLyrics[]>([]);
  // Per release (by album UUID) → normalized store → DistroKid deep-link. "Delivered by DistroKid".
  const [deliveredByRelease, setDeliveredByRelease] = useState<Map<string, Map<string, string | null>>>(new Map());

  const searchId = rec?.id ?? savedId ?? null;

  // One catalogue fetch powers the manual-mark lookup, the store-lyric coverage, AND the DistroKid
  // "Submitted to X" delivery overlay.
  const loadCatalogueAux = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/searches/${encodeURIComponent(id)}/catalogue`);
      if (!res.ok) return;
      const cat = (await res.json()) as { releases?: Array<{ releaseId: string; title: string | null; submittedStores?: Array<{ store: string; url: string | null }>; tracks: Array<{ title: string | null; isrc: string | null; trackIndex: number; mark: string | null; plainLyrics: string; syncedLyrics: string; storeLyricStatus: string; storeHasPlain: boolean; storeHasSynced: boolean }> }> };
      const map = new Map<string, MarkInfo>();
      const lyrics: TrackLyrics[] = [];
      const delivered = new Map<string, Map<string, string | null>>();
      for (const rel of cat.releases ?? []) {
        delivered.set(rel.releaseId, deliveredMapFrom(rel.submittedStores));
        for (const t of rel.tracks) {
          const info: MarkInfo = { releaseId: rel.releaseId, trackIndex: t.trackIndex, mark: t.mark ?? null };
          const ik = isrcMarkKey(t.isrc);
          if (ik && !map.has(ik)) map.set(ik, info);
          const ck = contentMarkKey(rel.title, t.title);
          if (!map.has(ck)) map.set(ck, info);
          lyrics.push({ plainLyrics: t.plainLyrics, syncedLyrics: t.syncedLyrics, storeLyricStatus: t.storeLyricStatus, storeHasPlain: t.storeHasPlain, storeHasSynced: t.storeHasSynced });
        }
      }
      setMarkLookup(map);
      setLyricTracks(lyrics);
      setDeliveredByRelease(delivered);
    } catch { /* best-effort; the grid still works without marks/lyric coverage */ }
  }, []);

  const presence = useStorePresence(searchId);
  const lyrics = useLyricsCheck(searchId, { onCompleted: () => { if (searchId) void loadCatalogueAux(searchId); } });

  // Keep the grid live while a store check triggered from THIS page runs (the base poll stops once a
  // prior scan is done, so a fresh re-run wouldn't otherwise update the cells until a manual reload).
  const refreshRecord = useCallback(async () => {
    if (!searchId) return;
    const r = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}`);
    if (r.ok) setRec((await r.json()) as SearchRecord);
  }, [searchId]);
  const storeCheckActive =
    presence.triggering || ['idle', 'queued', 'running'].includes(presence.deepScan?.status ?? '');
  useEffect(() => {
    if (!storeCheckActive) return;
    const t = setInterval(() => { void refreshRecord(); }, 4000);
    return () => clearInterval(t);
  }, [storeCheckActive, refreshRecord]);

  useEffect(() => {
    // The catalogue is read in the background after "connect & scan"; a fresh record starts
    // as a "reading" placeholder (a sentinel warning, 0 tracks). Poll until the read fills
    // it in, then a normal load + the deep-scan polling elsewhere take over.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
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
        if (!r.ok) throw new Error(await apiErrorMessage(r, 'The selected catalog audit could not be loaded'));
        const data = (await r.json()) as SearchRecord;
        if (cancelled) return;
        setRec(data);
        const reading = (data.result?.warnings ?? []).includes(READING_SENTINEL) && (data.result?.tracks?.length ?? 0) === 0;
        const presenceActive = data.deepScan?.status === 'idle' || data.deepScan?.status === 'queued' || data.deepScan?.status === 'running';
        if (reading) {
          setState('reading');
          timer = setTimeout(load, 3000);
        } else {
          setState('ready');
          void loadCatalogueAux(id);
          // Presence verification writes one platform at a time into this same durable record.
          // Keep the catalog live while that background work is active instead of freezing the
          // first empty/partial matrix until the user manually refreshes the browser.
          if (presenceActive) timer = setTimeout(load, 4000);
        }
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : 'The catalog audit could not be loaded.');
          setState('error');
        }
      }
    }
    setLoadError('');
    setState('loading');
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [savedId, loadCatalogueAux]);

  const rows: Row[] = useMemo(() => {
    if (!rec) return [];
    return rec.result.tracks.map((t) => {
      const cells = rec.result.stores.map((s) => t.perStore.find((p) => p.store === s)).filter(Boolean) as PerStore[];
      const has = (st: string) => cells.some((c) => c.status === st);
      const worst: Row['worst'] = cells.length === 0 ? 'pending' : has('wrong-profile') ? 'wrong' : has('not-live') ? 'gap' : has('unverifiable') ? 'unk' : 'live';
      const artist = (t.primaryArtist ?? '').trim() || null;
      const album = cleanTitle(t.album, artist) || null;
      // Prefer a real per-track title; for singles it's blank/"Untitled" → use the release title.
      const title = isRealTitle(t.title) ? cleanTitle(t.title, artist) : album || t.title || 'Untitled';
      const isrc = t.isrc ?? t.metadata?.isrc?.value ?? null;
      const info = markLookup.get(isrcMarkKey(isrc) ?? '') ?? markLookup.get(contentMarkKey(album, title));
      return {
        title,
        artist,
        featuredArtists: [...(t.featuredArtists ?? [])],
        isrc,
        album,
        art: t.artworkUrl ?? t.metadata?.artworkUrl?.value ?? null,
        label: t.label ?? t.metadata?.label?.value ?? null,
        upc: t.upc ?? t.metadata?.upc?.value ?? null,
        releaseDate: t.releaseDate ?? t.metadata?.releaseDate?.value ?? null,
        uploadDate: t.uploadDate ?? t.metadata?.uploadDate?.value ?? null,
        metadata: t.metadata,
        cells,
        worst,
        live: cells.filter((c) => c.status === 'live').length,
        issues: cells.filter((c) => c.status !== 'live').length,
        mark: info?.mark ?? null,
        markRef: info ? { releaseId: info.releaseId, trackIndex: info.trackIndex } : null,
      };
    });
  }, [rec, markLookup]);

  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]!;
    const n = q.trim().toLowerCase();
    return rows.filter((r) => f.test(r) && (!n || r.title.toLowerCase().includes(n) || (r.artist ?? '').toLowerCase().includes(n) || r.featuredArtists.some((artist) => artist.toLowerCase().includes(n)) || (r.isrc ?? '').toLowerCase().includes(n) || (r.album ?? '').toLowerCase().includes(n) || (r.upc ?? '').includes(n)));
  }, [rows, q, filter]);

  // Group filtered tracks by release (UPC preferred), preserving first-seen order,
  // and cap the total rendered tracks so a huge catalogue stays responsive.
  const groups = useMemo(() => {
    const m = new Map<string, Group>();
    const order: string[] = [];
    for (const r of shown) {
      const title = r.album ?? r.title;
      const key = (r.upc || title).toLowerCase();
      let g = m.get(key);
      if (!g) { g = { key, title, artist: r.artist, art: r.art, label: r.label, upc: r.upc, releaseDate: r.releaseDate, uploadDate: r.uploadDate, metadata: r.metadata, rows: [] }; m.set(key, g); order.push(key); }
      if (!g.art && r.art) g.art = r.art;
      g.rows.push(r);
    }
    const out: Group[] = [];
    let n = 0;
    for (const k of order) {
      if (n >= RENDER_CAP) break;
      const g = m.get(k)!;
      const capped = g.rows.slice(0, RENDER_CAP - n);
      out.push({ ...g, rows: capped });
      n += capped.length;
    }
    return out;
  }, [shown]);

  const markedMissing = useMemo(() => rows.filter((r) => r.mark === 'missing').length, [rows]);
  const selectableIds = useMemo(() => new Set(shown.filter((r) => r.markRef).map((r) => selId(r.markRef!))), [shown]);
  const allShownSelected = selectableIds.size > 0 && [...selectableIds].every((k) => selected.has(k));

  const toggleRow = (ref: { releaseId: string; trackIndex: number }) => {
    const key = selId(ref);
    setSelected((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (selectableIds.size > 0 && [...selectableIds].every((k) => prev.has(k))) { for (const k of selectableIds) next.delete(k); }
      else { for (const k of selectableIds) next.add(k); }
      return next;
    });
  };
  const applyMark = async (mark: string | null) => {
    if (!searchId || selected.size === 0) return;
    setMarking(true); setMarkError('');
    try {
      const marks = [...selected].map((k) => {
        const i = k.lastIndexOf(':');
        return { releaseId: k.slice(0, i), trackIndex: Number(k.slice(i + 1)), mark };
      });
      const res = await apiFetch(`/api/searches/${encodeURIComponent(searchId)}/track-marks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marks }),
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Could not update the marks.'));
      await loadCatalogueAux(searchId);
      setSelected(new Set());
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : 'Could not update the marks.');
    } finally {
      setMarking(false);
    }
  };

  function exportCsv() {
    if (!rec) return;
    const stores = rec.result.stores;
    const evidenceHead = (name: string) => [name, `${name} status`, `${name} source`, `${name} captured at`, `${name} parser version`];
    const head = [
      'Track', 'Artist', 'Featured artists', 'Release',
      ...evidenceHead('ISRC'), ...evidenceHead('UPC'), ...evidenceHead('Artwork URL'),
      ...evidenceHead('Record label'), ...evidenceHead('Release date'), ...evidenceHead('Upload date'),
      ...stores,
    ];
    const body = shown.map((r) => [
      r.title, r.artist ?? rec.artist, r.featuredArtists.join('; '), r.album ?? '',
      ...csvEvidence(r.isrc, r.metadata?.isrc),
      ...csvEvidence(r.upc, r.metadata?.upc),
      ...csvEvidence(r.art, r.metadata?.artworkUrl),
      ...csvEvidence(r.label, r.metadata?.label),
      ...csvEvidence(r.releaseDate, r.metadata?.releaseDate),
      ...csvEvidence(r.uploadDate, r.metadata?.uploadDate),
      ...stores.map((s) => r.cells.find((c) => c.store === s)?.status ?? 'n/a'),
    ]);
    downloadCsv(`catalog-${rec.artist.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, [head, ...body]);
  }

  if (state === 'loading') return <p className="page-sub"><span className="spinner" style={{ marginRight: 8 }} />Loading catalog…</p>;
  if (state === 'reading') {
    return (
      <div className="cat-empty">
        <p><span className="spinner" style={{ marginRight: 8 }} /><strong>Reading your catalogue in a real browser…</strong></p>
        <p className="hint" style={{ marginTop: 8 }}>{rec?.result?.note ?? 'Visiting each release to read its tracks, ISRCs and metadata. This page updates automatically as soon as the read finishes, large catalogues can take a minute.'}</p>
      </div>
    );
  }
  if (state === 'error') {
    return <div className="notice-banner" role="alert" style={{ borderColor: 'var(--wrong-edge)', background: 'var(--wrong-tint)', color: 'var(--wrong)' }}>{loadError}</div>;
  }
  if (state !== 'ready' || !rec) {
    return <NoAudit message="No audit has been run yet. Connect a distributor and run an audit to see your catalog track by track." />;
  }

  const s = rec.result.summary;
  const colSpan = 4;
  return (
    <>
      <Readout
        eyebrow={`Catalog · ${new Date(rec.createdAt).toLocaleDateString()}`}
        title={rec.artist}
        stats={[
          { value: s.tracks, label: 'tracks' },
          { value: s.live, label: 'confirmed', tone: 'ok' },
          { value: s.notLive, label: 'not confirmed', tone: s.notLive ? 'warn' : undefined },
          ...(markedMissing ? [{ value: markedMissing, label: 'marked missing', tone: 'bad' as const }] : []),
          { value: s.needsReview, label: 'to review', tone: s.needsReview ? 'warn' : undefined },
        ]}
      />

      <ExtractionBanner extraction={rec.result.distributorExtraction} />

      {/* Re-run controls: verify store presence + reconcile lyrics on this already-scraped catalogue,
          no re-scrape needed. Both are independent background jobs and can run at the same time. */}
      <div style={{ margin: '4px 0 2px' }}>
        <StoreCheckBar presence={presence} />
        <LyricsCheckBar check={lyrics} coverage={computeLyricsCoverage(lyricTracks)} />
      </div>

      <div className="cat-controls">
        <div className="cat-filters">
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${f.cls ?? ''} ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <input className="filter" style={{ minWidth: 220 }} placeholder="Search title, ISRC, UPC, release…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search catalog" />
          <button className="btn ghost" onClick={exportCsv}>Export CSV</button>
        </div>
      </div>

      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          style={{
            position: 'sticky', top: 8, zIndex: 5, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 14px', margin: '0 0 12px', borderRadius: 10, border: '1px solid var(--line)',
            background: 'var(--panel)', boxShadow: 'var(--shadow-sm)',
          }}
        >
          <strong style={{ fontSize: 13 }}>{selected.size} selected</strong>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => void applyMark('missing')} disabled={marking}>Mark missing</button>
          <button className="btn ghost" onClick={() => void applyMark('resolved')} disabled={marking}>Mark resolved</button>
          <button className="btn ghost" onClick={() => void applyMark(null)} disabled={marking}>Clear mark</button>
          <button className="btn ghost" onClick={() => setSelected(new Set())} disabled={marking}>Deselect</button>
          {marking && <span className="spinner" aria-hidden />}
          {markError && <span style={{ fontSize: 12, color: 'var(--wrong)' }}>{markError}</span>}
        </div>
      )}

      <div className="covmx">
        <div className="covmx-scroll">
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown tracks" disabled={selectableIds.size === 0} />
                </th>
                <th className="track-col" style={{ textAlign: 'left' }}>Track ({shown.length})</th>
                <th>Platform coverage</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="rel-head">
                    <td colSpan={colSpan}>
                      <div className="rel-card">
                        <Cover art={g.art} title={g.title} />
                        <div className="rel-body">
                          <div className="rel-row">
                            <span className="rel-title">{g.title}</span>
                            {g.artist && <span className="rel-artist">{g.artist}</span>}
                            <span className="rel-count">{g.rows.length} track{g.rows.length === 1 ? '' : 's'}</span>
                          </div>
                          <div className="rel-meta">
                            <span><b>Label</b> <MetadataValue value={g.label} evidence={g.metadata?.label} /></span>
                            <span><b>Uploaded</b> <MetadataValue value={g.uploadDate} evidence={g.metadata?.uploadDate} format={fmtDate} /></span>
                            <span><b>Released</b> <MetadataValue value={g.releaseDate} evidence={g.metadata?.releaseDate} format={fmtDate} /></span>
                            <span><b>UPC</b> <MetadataValue value={g.upc} evidence={g.metadata?.upc} /></span>
                            <span><b>Artwork</b> <MetadataValue value={g.art} evidence={g.metadata?.artworkUrl} format={() => 'Captured'} /></span>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {g.rows.map((r, i) => (
                    <tr key={`${g.key}-${r.isrc ?? r.title}-${i}`} className={r.markRef && selected.has(selId(r.markRef)) ? 'row-selected' : undefined}>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={!!r.markRef && selected.has(selId(r.markRef))}
                          onChange={() => r.markRef && toggleRow(r.markRef)}
                          disabled={!r.markRef}
                          aria-label={`Select ${r.title}`}
                          title={r.markRef ? undefined : 'This track could not be matched to a catalogue entry for marking'}
                        />
                      </td>
                      <td className="track-col">
                        <span className="tk-title" title={r.title}>{r.title}</span>
                        <span className="tk-sub">
                          {r.artist ? <>{r.artist}{r.featuredArtists.length ? ` feat. ${r.featuredArtists.join(', ')}` : ''} <span className="tk-dot">·</span> </> : ''}
                          <MetadataValue value={r.isrc} evidence={r.metadata?.isrc} />
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'inline-flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center' }}>
                          {r.cells.length > 0
                            ? r.cells.map((c) => {
                                const delivered = r.markRef ? deliveredByRelease.get(r.markRef.releaseId) : undefined;
                                // An unverifiable cell that DistroKid reports it delivered → "Delivered".
                                const isDelivered = c.status === 'unverifiable' && !!delivered?.has(c.store);
                                const url = isDelivered ? (delivered!.get(c.store) || undefined) : (c.url || undefined);
                                const pip = (
                                  <span
                                    className={`pip ${isDelivered ? 'delivered' : statusClass(c.status)}`}
                                    title={isDelivered ? `${c.store}: Delivered by DistroKid (not independently verified)` : `${c.store}: ${c.status}${c.foundArtist ? ` (${c.foundArtist})` : ''}`}
                                  >{platformCode(c.store)}</span>
                                );
                                return url
                                  ? <a key={c.store} href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>{pip}</a>
                                  : <Fragment key={c.store}>{pip}</Fragment>;
                              })
                            : <span className="status unk">Checks pending</span>}
                        </div>
                      </td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          {r.mark === 'missing' && <span className="status wrong" title="Manually marked missing">Marked missing</span>}
                          {r.mark === 'resolved' && <span className="status live" title="Manually marked resolved">Resolved</span>}
                          {(() => {
                            const delivered = r.markRef ? deliveredByRelease.get(r.markRef.releaseId) : undefined;
                            const n = delivered ? r.cells.filter((c) => c.status === 'unverifiable' && delivered.has(c.store)).length : 0;
                            return n > 0 ? <span className="status delivered" title="Delivered by DistroKid but not independently verified">Delivered to {n}</span> : null;
                          })()}
                          {r.worst === 'pending'
                            ? <span className="status unk">Store checks pending</span>
                            : r.worst === 'live'
                              ? <span className="status live">All confirmed</span>
                            : r.worst === 'wrong'
                              ? <span className="status wrong">Wrong profile</span>
                              : r.worst === 'gap'
                                ? <span className="status gap">{r.issues} not confirmed</span>
                                : <span className="status unk">{r.issues} to review</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {shown.length > RENDER_CAP && <p className="cat-note">Showing the first {RENDER_CAP.toLocaleString()} of {shown.length.toLocaleString()} matching tracks. Refine with search or filters (CSV export includes all {shown.length.toLocaleString()}).</p>}
      <CoverageLegend stores={rec.result.stores} />
    </>
  );
}
