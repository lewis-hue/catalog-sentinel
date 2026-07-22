import {
  systemClock,
  type Clock,
  type ConsentGrant,
  type ConsentGrantId,
  type UserId,
  type WorkspaceId,
} from '@sentinel/core';
import { createInMemoryRepository, type Repository } from '@sentinel/db';
import { AudiomackAdapter } from '../../adapters/src/dsp/audiomack.test-support';
import {
  buildLewisKeWorkflowFixture,
  type LewisKeWorkflowFixture,
} from './fixtures.test-support';
import { findMissingAudiomackSongs, type FindMissingAudiomackResult } from './workflow';
import { InMemoryObjectStore } from './object-store.test-support';
import type { ObjectStore } from './object-store';

/** A fully scoped consent grant used only by isolated workflow tests. */
export function workflowFixtureConsent(workspaceId: string, clock: Clock): ConsentGrant {
  const grantedAt = clock.nowIso();
  const expiresAt = new Date(clock.now().getTime() + 30 * 86_400_000).toISOString();
  return {
    id: 'cg_workflow_fixture' as ConsentGrantId,
    workspaceId: workspaceId as WorkspaceId,
    grantedByUserId: 'usr_workflow_fixture' as UserId,
    scopes: ['read-distributor-catalog', 'read-dsp-catalog', 'generate-reports', 'capture-screenshots'],
    purpose: 'Exercise the Audiomack coverage workflow with deterministic test fixtures.',
    retentionDays: 30,
    grantedAt,
    expiresAt,
    revokedAt: null,
    createdAt: grantedAt,
    updatedAt: grantedAt,
  };
}

export interface RunWorkflowFixtureOptions {
  repo?: Repository;
  objectStore?: ObjectStore;
  clock?: Clock;
  workspaceId?: string;
}

export interface WorkflowFixtureRun {
  result: FindMissingAudiomackResult;
  fixture: LewisKeWorkflowFixture;
  repo: Repository;
}

/** Execute the workflow against deterministic test-only input. */
export async function runLewisKeWorkflowFixture(
  opts: RunWorkflowFixtureOptions = {},
): Promise<WorkflowFixtureRun> {
  const clock = opts.clock ?? systemClock;
  const workspaceId = opts.workspaceId ?? 'ws_lewis_ke_fixture';
  const repo = opts.repo ?? createInMemoryRepository();
  const objectStore = opts.objectStore ?? new InMemoryObjectStore();
  const fixture = buildLewisKeWorkflowFixture();

  const result = await findMissingAudiomackSongs({
    workspaceId,
    artistName: fixture.artistName,
    distributorCsvText: fixture.distributorCsvText,
    audiomackSlug: fixture.audiomackSlug,
    audiomackAdapter: new AudiomackAdapter({ dataset: fixture.audiomackDataset, clockIso: clock.nowIso }),
    distributorAccountEmail: 'teamkidaflow@gmail.com',
    consentGrant: workflowFixtureConsent(workspaceId, clock),
    repo,
    objectStore,
    clock,
  });

  return { result, fixture, repo };
}
