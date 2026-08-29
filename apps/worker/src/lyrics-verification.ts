import { createLrclibResolver, type LyricsResolver, type LyricsLookupResult } from '@sentinel/adapters';
import type { LyricScanTarget, StoreLyricsProgress } from '@sentinel/persistence';

/** The persistence surface this worker needs. The concrete `DistroKidOutcomeRepository` satisfies it
 *  structurally; tests supply a lightweight fake. */
export interface StoreLyricsSink {
  readLyricScanTargets(tenantId: string, snapshotId: string): Promise<LyricScanTarget[]>;
  updateStoreLyrics(
    releaseOutcomeId: string,
    updates: Array<{ trackIndex: number; status: string; hasPlain: boolean; hasSynced: boolean; source: string | null }>,
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
  /** Injectable resolver; tests supply a deterministic double, production defaults to LRCLIB. */
  resolver?: LyricsResolver;
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

/** One track's store-lyric verdict, plus the release row + index that key its DB update. */
interface StoreLyricVerdict {
  releaseOutcomeId: string;
  trackIndex: number;
  status: string;
  hasPlain: boolean;
  hasSynced: boolean;
}

/** Map an LRCLIB lookup to the store-side columns. `instrumental` is a distinct, legitimate state
 *  (the recording has no lyrics by design), kept separate from "not-found" and "no lyrics on file". */
export function toStoreVerdict(r: LyricsLookupResult): { status: string; hasPlain: boolean; hasSynced: boolean } {
  if (r.status === 'unverifiable') return { status: 'unverifiable', hasPlain: false, hasSynced: false };
  if (r.status === 'not-found') return { status: 'not-found', hasPlain: false, hasSynced: false };
  if (r.instrumental) return { status: 'instrumental', hasPlain: false, hasSynced: false };
  return { status: 'found', hasPlain: !!r.plain, hasSynced: !!r.synced };
}

/**
 * Background store-side lyric verification. For each COMPLETED release's tracks it asks the lyrics
 * resolver (LRCLIB) whether plain and/or synced lyrics exist on the stores, and writes the verdict to
 * the Postgres outcome tables (`storeLyric*` columns), never the in-memory search record. Because it
 * writes a different table than the store-presence deep scan, the two runs are fully independent: a
 * user can start a store check and a lyrics check and both survive to completion.
 *
 * Fault-isolated: a lyrics-source outage marks tracks `unverifiable` (never a false "no lyrics"). If
 * EVERY lookup was unverifiable the run reports `error` (so the UI offers retry) and throws.
 */
export async function runLyricsVerification(job: LyricsVerificationJob, deps: LyricsVerificationDeps): Promise<void> {
  const { outcomeRepo, env } = deps;
  const { snapshotId, tenantId } = job;
  const log = deps.log ?? (() => {});
  const resolver = deps.resolver ?? createLrclibResolver(env);

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

  // Flatten every track across releases into one work list so bounded concurrency spans the whole
  // catalogue, then write verdicts back grouped per release.
  const work: Array<{ target: LyricScanTarget; trackIndex: number; title: string | null; artist: string; album: string | undefined }> = [];
  for (const target of targets) {
    const releaseArtist = (target.releaseArtist || '').trim();
    const album = target.releaseTitle?.trim() || undefined;
    for (const t of target.tracks) {
      work.push({
        target,
        trackIndex: t.trackIndex,
        title: t.title,
        artist: (t.primaryArtist || releaseArtist || '').trim(),
        album,
      });
    }
  }

  const verdicts = new Array<StoreLyricVerdict | undefined>(work.length);
  const flushed = new Set<string>();
  let failures = 0;
  let checked = 0;

  const flushRelease = async (releaseOutcomeId: string): Promise<void> => {
    if (flushed.has(releaseOutcomeId)) return;
    flushed.add(releaseOutcomeId);
    const updates = verdicts
      .filter((v): v is StoreLyricVerdict => !!v && v.releaseOutcomeId === releaseOutcomeId)
      .map((v) => ({ trackIndex: v.trackIndex, status: v.status, hasPlain: v.hasPlain, hasSynced: v.hasSynced, source: resolver.source }));
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
        let verdict: { status: string; hasPlain: boolean; hasSynced: boolean };
        if (!w.title || !w.title.trim()) {
          verdict = { status: 'unverifiable', hasPlain: false, hasSynced: false };
          failures += 1;
        } else {
          try {
            const r = await resolver.lookup({ artist: w.artist, title: w.title, album: w.album });
            verdict = toStoreVerdict(r);
            if (verdict.status === 'unverifiable') failures += 1;
          } catch {
            verdict = { status: 'unverifiable', hasPlain: false, hasSynced: false };
            failures += 1;
          }
        }
        verdicts[i] = { releaseOutcomeId: w.target.releaseOutcomeId, trackIndex: w.trackIndex, ...verdict };
      }
    });
    await Promise.all(runners);
    checked = end;

    // Persist each release exactly once, as soon as its last track (contiguous in `work`) is resolved.
    const stillPending = new Set(work.slice(end).map((w) => w.target.releaseOutcomeId));
    for (const id of new Set(work.slice(0, end).map((w) => w.target.releaseOutcomeId))) {
      if (!stillPending.has(id)) await flushRelease(id);
    }

    await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, { status: 'running', checked, total });
  }

  const allUnverifiable = failures === total;
  await outcomeRepo.setStoreLyricsProgress(tenantId, snapshotId, {
    status: allUnverifiable ? 'error' : 'done',
    checked: total,
    total,
    error: allUnverifiable
      ? 'Lyric verification could not reach the lyrics source; no track was checked. Retry when ready.'
      : null,
  });
  if (allUnverifiable) throw new Error('lyrics verification: all lookups unverifiable');
  log(`lyrics-check: ${snapshotId} complete`, { total, failures });
}
