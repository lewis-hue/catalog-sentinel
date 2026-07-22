import { describe, it, expect, beforeAll } from 'vitest';
import { fixedClock, ConsentError } from '@sentinel/core';
import { createInMemoryRepository } from '@sentinel/db';
import { InMemoryObjectStore } from './object-store.test-support';
import { AudiomackAdapter } from '../../adapters/src/dsp/audiomack.test-support';
import { runLewisKeWorkflowFixture, workflowFixtureConsent } from './workflow-fixture.test-support';
import { findMissingAudiomackSongs } from './workflow';
import { buildLewisKeWorkflowFixture } from './fixtures.test-support';
import type { FindMissingAudiomackResult } from './workflow';

const clock = fixedClock('2026-07-07T00:00:00.000Z');

describe('findMissingAudiomackSongs — deterministic Lewis KE fixture', () => {
  let result: FindMissingAudiomackResult;
  const fixture = buildLewisKeWorkflowFixture();

  beforeAll(async () => {
    const run = await runLewisKeWorkflowFixture({ clock, objectStore: new InMemoryObjectStore() });
    result = run.result;
  });

  it('generates a 150-track fixture with the expected placement shape', () => {
    expect(fixture.expected.totalTracks).toBe(150);
    expect(fixture.expected.missing).toBe(100);
    expect(fixture.expected.live).toBe(46);
    expect(fixture.expected.private).toBe(2);
  });

  it('detects exactly 100 songs missing on Audiomack', () => {
    expect(result.audit.totalExpected).toBe(150);
    expect(result.audit.counts.missing).toBe(100);
    expect(result.missing).toHaveLength(100);
  });

  it('confirms present tracks and flags private/duplicate/wrong-profile cases', () => {
    const c = result.audit.counts;
    expect(c.present).toBe(46);
    expect(c['present-unplayable']).toBe(2);
    expect(c['present-duplicate-profile']).toBe(1);
    expect(c['present-wrong-profile']).toBe(1);
    // present in any form should total the 50 Audiomack-found tracks
    expect(c.present + c['present-unplayable'] + c['present-duplicate-profile'] + c['present-wrong-profile']).toBe(50);
  });

  it('produces a DistroKid support packet with a CSV listing every missing track', () => {
    const distro = result.packets.find((p) => p.template === 'distrokid-missing-audiomack')!;
    expect(distro.subject).toBe('Audiomack Reinstatement Request — Lewis KE — 100 Missing Songs');
    expect(distro.missingCount).toBe(100);
    const csv = distro.artifacts.find((a) => a.format === 'csv');
    expect(csv).toBeDefined();
    expect(distro.bodyMarkdown).toContain('https://audiomack.com/lewis_ke');
  });

  it('every missing row carries evidence and a confidence score', () => {
    for (const m of result.missing) {
      expect(m.reasonCode).toBe('MISSING_ON_PLATFORM');
      expect(m.confidence).toBeGreaterThan(0);
      expect(m.evidenceNote.length).toBeGreaterThan(0);
    }
  });

  it('is idempotent: a second run yields identical counts and stable ids', async () => {
    const repo = createInMemoryRepository();
    const a = await runLewisKeWorkflowFixture({ clock, repo, objectStore: new InMemoryObjectStore() });
    const releasesAfterFirst = repo.releases.all().length;
    const b = await runLewisKeWorkflowFixture({ clock, repo, objectStore: new InMemoryObjectStore() });
    expect(repo.releases.all().length).toBe(releasesAfterFirst); // no duplicates on rerun
    expect(a.result.scanRunId).toBe(b.result.scanRunId);
    expect(a.result.audit.counts).toEqual(b.result.audit.counts);
  });

  it('persists issues and packets to the repository', async () => {
    const repo = createInMemoryRepository();
    await runLewisKeWorkflowFixture({ clock, repo, objectStore: new InMemoryObjectStore() });
    expect(repo.issues.all().length).toBeGreaterThan(100);
    expect(repo.packets.all()).toHaveLength(2);
    expect(repo.scanRuns.all()).toHaveLength(1);
  });
});

describe('consent enforcement', () => {
  it('refuses to scan without a valid consent grant', async () => {
    const fixture = buildLewisKeWorkflowFixture();
    const expired = workflowFixtureConsent('ws_x', clock);
    expired.revokedAt = '2026-07-06T00:00:00.000Z';
    await expect(
      findMissingAudiomackSongs({
        workspaceId: 'ws_x',
        artistName: fixture.artistName,
        distributorCsvText: fixture.distributorCsvText,
        audiomackSlug: fixture.audiomackSlug,
        audiomackAdapter: new AudiomackAdapter({ dataset: fixture.audiomackDataset, clockIso: clock.nowIso }),
        consentGrant: expired,
        repo: createInMemoryRepository(),
        objectStore: new InMemoryObjectStore(),
        clock,
      }),
    ).rejects.toBeInstanceOf(ConsentError);
  });
});
