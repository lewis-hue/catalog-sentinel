import { describe, it, expect } from 'vitest';
import type { SongLyricEvidence } from '@sentinel/adapters';
import type { LyricScanTarget } from '@sentinel/persistence';
import {
  runLyricsVerification,
  toStoreVerdict,
  type LyricEvidenceResolver,
  type StoreLyricsSink,
} from './lyrics-verification';

type Update = {
  trackIndex: number; perStore: Record<string, string>;
  status: string; hasPlain: boolean; hasSynced: boolean; source: string | null;
  lyricfindDistributed: boolean; lyricfindUrl: string | null;
};

/** In-memory outcome store; the worker writes Postgres columns and this captures those writes. */
class FakeSink implements StoreLyricsSink {
  written = new Map<string, Update[]>();
  progress: Array<{ status: string; checked?: number; total?: number; error?: string | null }> = [];
  constructor(private targets: LyricScanTarget[]) {}
  async readLyricScanTargets(): Promise<LyricScanTarget[]> { return this.targets; }
  async updateStoreLyrics(releaseOutcomeId: string, updates: Update[]): Promise<number> {
    this.written.set(releaseOutcomeId, [...(this.written.get(releaseOutcomeId) ?? []), ...updates]);
    return updates.length;
  }
  async setStoreLyricsProgress(_t: string, _s: string, p: { status: string; checked?: number; total?: number; error?: string | null }): Promise<void> {
    this.progress.push(p);
  }
  last() { return this.progress[this.progress.length - 1]; }
}

const evidence = (shown: string[], lyricfindUrl: string | null = null): SongLyricEvidence => ({
  shownStores: new Set(shown),
  lyricfindDistributed: Boolean(lyricfindUrl),
  lyricfindUrl,
});

const target = (releaseOutcomeId: string, tracks: Array<{ title: string | null; isrc: string }>): LyricScanTarget => ({
  releaseOutcomeId, distributorReleaseId: `album=${releaseOutcomeId}`, releaseTitle: 'Album', releaseArtist: 'Lewis KE',
  tracks: tracks.map((t, i) => ({ trackIndex: i, trackNumber: i + 1, title: t.title, primaryArtist: 'Lewis KE', isrc: t.isrc })),
});

describe('toStoreVerdict', () => {
  it('records proven stores as shown and a global found', () => {
    expect(toStoreVerdict(evidence(['Apple Music', 'Deezer'], 'https://lyrics.lyricfind.com/lyrics/x')))
      .toEqual({ perStore: { 'Apple Music': 'shown', Deezer: 'shown' }, status: 'found', hasPlain: true, hasSynced: false, lyricfindDistributed: true, lyricfindUrl: 'https://lyrics.lyricfind.com/lyrics/x' });
  });
  it('reports not-found when LyricFind delivered but no store shows lyrics', () => {
    expect(toStoreVerdict(evidence([], 'https://lyrics.lyricfind.com/lyrics/y')))
      .toMatchObject({ perStore: {}, status: 'not-found', hasPlain: false, lyricfindDistributed: true });
  });
  it('stays unverifiable with no evidence at all (never a false not-found)', () => {
    expect(toStoreVerdict(evidence([]))).toMatchObject({ perStore: {}, status: 'unverifiable', lyricfindDistributed: false });
  });
});

describe('runLyricsVerification (Serper, outcome-based, independent of the search record)', () => {
  it('writes per-store lyric verdicts + LyricFind + done progress', async () => {
    const sink = new FakeSink([target('rel1', [{ title: 'Heartless', isrc: 'QZ1' }, { title: 'Pop Out', isrc: 'QZ2' }, { title: 'Skit', isrc: 'QZ3' }])]);
    const resolver: LyricEvidenceResolver = {
      async resolve(_artist, title) {
        if (title === 'Heartless') return evidence(['Apple Music', 'Amazon Music'], 'https://lyrics.lyricfind.com/lyrics/heartless');
        if (title === 'Pop Out') return evidence(['Deezer']);
        return evidence([]);
      },
    };

    await runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver, trackConcurrency: 2, chunkSize: 2 });

    const w = sink.written.get('rel1')!;
    expect(w).toHaveLength(3);
    expect(w.find((u) => u.trackIndex === 0)).toMatchObject({ status: 'found', perStore: { 'Apple Music': 'shown', 'Amazon Music': 'shown' }, lyricfindDistributed: true, source: 'serper' });
    expect(w.find((u) => u.trackIndex === 1)).toMatchObject({ status: 'found', perStore: { Deezer: 'shown' } });
    expect(w.find((u) => u.trackIndex === 2)).toMatchObject({ status: 'unverifiable', perStore: {} });
    expect(sink.last()).toMatchObject({ status: 'done', checked: 3, total: 3 });
  });

  it('marks the check error when every lookup fails (never a false "not-found")', async () => {
    const sink = new FakeSink([target('rel1', [{ title: 'A', isrc: 'QZ1' }, { title: 'B', isrc: 'QZ2' }])]);
    const resolver: LyricEvidenceResolver = { async resolve() { throw new Error('search down'); } };

    await expect(runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver })).rejects.toThrow(/all lookups failed/i);
    expect(sink.last()?.status).toBe('error');
    expect(sink.written.get('rel1')?.every((u) => u.status === 'unverifiable')).toBe(true);
  });

  it('records a missing title as unverifiable rather than searching it', async () => {
    const sink = new FakeSink([target('rel1', [{ title: null, isrc: 'QZ1' }, { title: 'Real', isrc: 'QZ2' }])]);
    const resolver: LyricEvidenceResolver = { async resolve() { return evidence(['Apple Music']); } };

    await runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver });
    const w = sink.written.get('rel1')!;
    expect(w.find((u) => u.trackIndex === 0)).toMatchObject({ status: 'unverifiable', perStore: {} });
    expect(w.find((u) => u.trackIndex === 1)).toMatchObject({ status: 'found', perStore: { 'Apple Music': 'shown' } });
  });
});
