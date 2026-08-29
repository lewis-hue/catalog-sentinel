import { describe, it, expect } from 'vitest';
import type { LyricsResolver } from '@sentinel/adapters';
import type { LyricScanTarget } from '@sentinel/persistence';
import { runLyricsVerification, toStoreVerdict, type StoreLyricsSink } from './lyrics-verification';

type Update = { trackIndex: number; status: string; hasPlain: boolean; hasSynced: boolean; source: string | null };

/** In-memory outcome store, the worker writes Postgres columns; this captures those writes. */
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

const target = (releaseOutcomeId: string, tracks: Array<{ title: string | null; isrc: string }>): LyricScanTarget => ({
  releaseOutcomeId, distributorReleaseId: `album=${releaseOutcomeId}`, releaseTitle: 'Album', releaseArtist: 'Lewis KE',
  tracks: tracks.map((t, i) => ({ trackIndex: i, trackNumber: i + 1, title: t.title, primaryArtist: 'Lewis KE', isrc: t.isrc })),
});

describe('runLyricsVerification (outcome-based, independent of the search record)', () => {
  it('resolves per-track store lyric availability and writes verdicts + done progress', async () => {
    const sink = new FakeSink([target('rel1', [{ title: 'Heartless', isrc: 'QZ1' }, { title: 'Pop Out', isrc: 'QZ2' }, { title: 'Skit', isrc: 'QZ3' }])]);
    const resolver: LyricsResolver = {
      source: 'lrclib',
      async lookup({ title }) {
        if (title === 'Heartless') return { status: 'found', plain: true, synced: true, instrumental: false, source: 'lrclib' };
        if (title === 'Pop Out') return { status: 'found', plain: true, synced: false, instrumental: false, source: 'lrclib' };
        return { status: 'not-found', plain: false, synced: false, instrumental: false, source: 'lrclib' };
      },
    };

    await runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver, trackConcurrency: 2, chunkSize: 2 });

    const w = sink.written.get('rel1')!;
    expect(w).toHaveLength(3);
    expect(w.find((u) => u.trackIndex === 0)).toMatchObject({ status: 'found', hasPlain: true, hasSynced: true, source: 'lrclib' });
    expect(w.find((u) => u.trackIndex === 1)).toMatchObject({ status: 'found', hasPlain: true, hasSynced: false });
    expect(w.find((u) => u.trackIndex === 2)).toMatchObject({ status: 'not-found', hasPlain: false, hasSynced: false });
    expect(sink.last()).toMatchObject({ status: 'done', checked: 3, total: 3 });
  });

  it('marks the check error when every lookup is unverifiable (never a false "not-found")', async () => {
    const sink = new FakeSink([target('rel1', [{ title: 'A', isrc: 'QZ1' }, { title: 'B', isrc: 'QZ2' }])]);
    const resolver: LyricsResolver = { source: 'lrclib', async lookup() { return { status: 'unverifiable', plain: false, synced: false, instrumental: false, source: 'lrclib' }; } };

    await expect(runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver })).rejects.toThrow(/unverifiable/i);
    expect(sink.last()?.status).toBe('error');
    expect(sink.written.get('rel1')?.every((u) => u.status === 'unverifiable')).toBe(true);
  });

  it('records a missing title as unverifiable rather than looking it up as not-found', async () => {
    const sink = new FakeSink([target('rel1', [{ title: null, isrc: 'QZ1' }, { title: 'Real', isrc: 'QZ2' }])]);
    const resolver: LyricsResolver = { source: 'lrclib', async lookup() { return { status: 'found', plain: true, synced: false, instrumental: false, source: 'lrclib' }; } };

    await runLyricsVerification({ snapshotId: 'snap', tenantId: 'default' }, { outcomeRepo: sink, env: {}, resolver });
    const w = sink.written.get('rel1')!;
    expect(w.find((u) => u.trackIndex === 0)).toMatchObject({ status: 'unverifiable' });
    expect(w.find((u) => u.trackIndex === 1)).toMatchObject({ status: 'found', hasPlain: true });
  });

  it('maps an instrumental recording to its own status (not "found with lyrics")', () => {
    expect(toStoreVerdict({ status: 'found', plain: false, synced: false, instrumental: true, source: 'lrclib' }))
      .toEqual({ status: 'instrumental', hasPlain: false, hasSynced: false });
    expect(toStoreVerdict({ status: 'found', plain: true, synced: true, instrumental: false, source: 'lrclib' }))
      .toEqual({ status: 'found', hasPlain: true, hasSynced: true });
  });
});
