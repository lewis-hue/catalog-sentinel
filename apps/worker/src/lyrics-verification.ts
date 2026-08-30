import {
  WebLyricsResolver,
  createDuckDuckGoSearch,
  createSearchProvider,
  searchBackendFrom,
  type SongLyricEvidence,
} from '@sentinel/adapters';
import type { LyricScanTarget, StoreLyricsProgress } from '@sentinel/persistence';

/** The lyric evidence source. `WebLyricsResolver` satisfies it; tests supply a deterministic fake. */
export interface LyricEvidenceResolver {
  resolve(artist: string, title: string): Promise<SongLyricEvidence>;
}

/** The persistence surface this worker needs. The concrete `DistroKidOutcomeRepository` satisfies it
 *  structurally; tests supply a lightweight fake. */
export interface StoreLyricsSink {
  readLyricScanTargets(tenantId: string, snapshotId: string): Promise<LyricScanTarget[]>;
  updateStoreLyrics(
    releaseOutcomeId: string,
    updates: Array<{
      trackIndex: number;
      perStore: Record<string, string>;
      status: string; hasPlain: boolean; hasSynced: boolean; source: string | null;
      lyricfindDistributed: boolean; lyricfindUrl: string | null;
    }>,
  ): Promise<number>;
  setStoreLyricsProgress(
    tenantId: string,
    snapshotId: string,
    p: { status: string; checked?: number; total?: number; error?: string | null },
  ): Promise<void>;
  readStoreLyricsProgress?(tenantId: string, snapshotId: string): Promise<StoreLyricsProgress | null>;
}

export interface LyricsVerificationDeps {
  /** Postgres outcome repository, the ONLY store this worker writes. It never touches the search
   *  record, so it runs fully independent of the store-presence deep scan (different table entirely). */
  outcomeRepo: StoreLyricsSink;
  env: NodeJS.ProcessEnv;
  /** Injectable resolver; tests supply a deterministic double, production defaults to Serper web verification. */
  resolver?: LyricEvidenceResolver;
  /** Concurrent per-track lookups (Env: LYRICS_LOOKUP_CONCURRENCY, default 4). */
  trackConcurrency?: number;
  /** Tracks per progress write-back (Env: LYRICS_CHECKPOINT_SIZE, default 10). */
  chunkSize?: number;
  log?: (message: string, extra?: Record<string, unknown>) => void;
}

/** Job payload: the snapshot to check + its owning tenant. `snapshotId` equals the search id. */
export interface LyricsVerificationJob {
  snapshotId: string;
  tenantId: string;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, override: number | undefined, fallback: number, min: number, max: number): number {
  const raw = override ?? (env[name] === undefined ? fallback : Number(env[name]));
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return raw;
}

/** One track's store-lyric result, plus the release row + index that key its DB update. */
interface StoreLyricVerdict {
  releaseOutcomeId: string;
  trackIndex: number;
  perStore: Record<string, string>;
  status: string; hasPlain: boolean; hasSynced: boolean;
  lyricfindDistributed: boolean; lyricfindUrl: string | null;
}

/** Map Serper lyric evidence to the row a track outcome stores. The per-store map keeps only stores
 *  PROVEN to show lyrics; the API merge fills `not-shown` for present-but-unproven lyric-capable
 *  stores. The derived global status feeds the existing missing-lyrics comparison and never claims a
 *  false `not-found`: with zero positive evidence and no LyricFind delivery it stays `unverifiable`. */
export function toStoreVerdict(evidence: SongLyricEvidence): {
  perStore: Record<string, string>; status: string; hasPlain: boolean; hasSynced: boolean;
  lyricfindDistributed: boolean; lyricfindUrl: string | null;
} {
  const perStore: Record<string, string> = {};
  for (const store of evidence.shownStores) perStore[store] = 'shown';
  const shown = evidence.shownStores.size > 0;
  const status = shown ? 'found' : evidence.lyricfindDistributed ? 'not-found' : 'unverifiable';
  return {
    perStore,
    status,
    hasPlain: shown,
    hasSynced: false, // A SERP snippet cannot distinguish time-synced (LRC) lyrics from plain.
    lyricfindDistributed: evidence.lyricfindDistributed,
    lyricfindUrl: evidence.lyricfindUrl,
  };
}

function buildResolver(env: NodeJS.ProcessEnv): LyricEvidenceResolver {
  const provider = createSearchProvider(env);
  const search = provider ? searchBackendFrom(provider) : createDuckDuckGoSearch();
  return new WebLyricsResolver(search);
}

/**
 * Background store-side lyric verification via Serper web search. For each COMPLETED release's tracks
 * it asks the resolver which lyric-capable stores actually DISPLAY the song's lyrics (and whether
 * LyricFind confirms distribution), and writes the per-store map + a derived global verdict to the
 * Postgres outcome tables, never the in-memory search record. Because it writes a different table than
 * the store-presence deep scan, the two runs stay fully independent.
 *
 * Fault-isolated: a search failure marks the track `unverifiable` (never a false "no lyrics"). If
 * EVERY lookup failed (total search outage) the run reports `error` (so the UI offers retry) and throws.
 */
export async function runLyricsVerification(job: LyricsVerificationJob, deps: LyricsVerificationDeps): Promise<void> {
  const { outcomeRepo, env } = deps;
  const { snapshotId, tenantId } = job;
  const log = deps.log ?? (() => {});
  const resolver = deps.resolver ?? buildResolver(env);

  const targets = await outcomeRepo.readLyricScanTargets(tenantId, snapshotId);
  const total = targets.reduce((n, t) => n + t.tracks.length, 0);
  const trackConcurrency = intEnv(env, 'LYRICS_LOOKUP_CONCURRENCY', deps.trackConcurrency, 4, 1, 16);
  const chunkSize = intEnv(env, 'LYRICS_CHECKPOINT_SIZE', deps.chunkSize, 10, 1, 200);

  if (!total) {
    await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, { status: 'done', checked: 0, total: 0, error: null });
    log(`lyrics-check: ${snapshotId}, no tracks to check`);
    return;
  }

  await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, { status: 'running', checked: 0, total, error: null });

  const work: Array<{ target: LyricScanTarget; trackIndex: number; title: string | null; artist: string }> = [];
  for (const target of targets) {
    const releaseArtist = (target.releaseArtist || '').trim();
    for (const t of target.tracks) {
      work.push({
        target,
        trackIndex: t.trackIndex,
        title: t.title,
        artist: (t.primaryArtist || releaseArtist || '').trim(),
      });
    }
  }

  const verdicts = new Array<StoreLyricVerdict | undefined>(work.length);
  const flushed = new Set<string>();
  let failures = 0;
  let checked = 0;

  const emptyVerdict = (): { perStore: Record<string, string>; status: string; hasPlain: boolean; hasSynced: boolean; lyricfindDistributed: boolean; lyricfindUrl: string | null } =>
    ({ perStore: {}, status: 'unverifiable', hasPlain: false, hasSynced: false, lyricfindDistributed: false, lyricfindUrl: null });

  const flushRelease = async (releaseOutcomeId: string): Promise<void> => {
    if (flushed.has(releaseOutcomeId)) return;
    flushed.add(releaseOutcomeId);
    const updates = verdicts
      .filter((v): v is StoreLyricVerdict => !!v && v.releaseOutcomeId === releaseOutcomeId)
      .map((v) => ({
        trackIndex: v.trackIndex, perStore: v.perStore, status: v.status,
        hasPlain: v.hasPlain, hasSynced: v.hasSynced, source: 'serper',
        lyricfindDistributed: v.lyricfindDistributed, lyricfindUrl: v.lyricfindUrl,
      }));
    if (updates.length) await outcomeRepo.updateStoreLyrics(releaseOutcomeId, updates);
  };

  for (let start = 0; start < work.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, work.length);
    let cursor = start;
    const runners = Array.from({ length: Math.min(trackConcurrency, end - start) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= end) break;
        const w = work[i]!;
        let verdict: ReturnType<typeof emptyVerdict>;
        if (!w.title || !w.title.trim()) {
          verdict = emptyVerdict();
          failures += 1;
        } else {
          try {
            verdict = toStoreVerdict(await resolver.resolve(w.artist, w.title));
          } catch {
            // A search failure is unverifiable, never a false "no lyrics".
            verdict = emptyVerdict();
            failures += 1;
          }
        }
        verdicts[i] = { releaseOutcomeId: w.target.releaseOutcomeId, trackIndex: w.trackIndex, ...verdict };
      }
    });
    await Promise.all(runners);
    checked = end;

    const stillPending = new Set(work.slice(end).map((w) => w.target.releaseOutcomeId));
    for (const id of new Set(work.slice(0, end).map((w) => w.target.releaseOutcomeId))) {
      if (!stillPending.has(id)) await flushRelease(id);
    }

    await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, { status: 'running', checked, total });
  }

  const allFailed = failures === total;
  await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, {
    status: allFailed ? 'error' : 'done',
    checked: total,
    total,
    error: allFailed
      ? 'Lyric verification could not reach the search provider; no track was checked. Retry when ready.'
      : null,
  });
  if (allFailed) throw new Error('lyrics verification: all lookups failed');
  log(`lyrics-check: ${snapshotId} complete`, { total, failures });
}
