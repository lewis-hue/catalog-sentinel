import { describe, it, expect } from 'vitest';
import { createInMemoryRepository } from './in-memory';
import type { Artist, Issue, Workspace } from '@sentinel/core';

const ws = (id: string): Workspace => ({
  id: id as Workspace['id'],
  tenantId: 't1' as Workspace['tenantId'],
  name: `ws ${id}`,
  primaryArtistId: null,
  createdAt: '2026-07-07T00:00:00.000Z',
  updatedAt: '2026-07-07T00:00:00.000Z',
});

const issue = (id: string, workspaceId: string): Issue =>
  ({
    id,
    workspaceId,
    reasonCode: 'MISSING_ON_PLATFORM',
    severity: 'high',
    status: 'open',
    platform: 'audiomack',
    releaseId: null,
    trackId: null,
    summary: 's',
    confidence: 0.9,
    confidenceBand: 'strong',
    evidenceIds: [],
    recommendedAction: 'x',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
  }) as unknown as Issue;

describe('InMemoryRepository', () => {
  it('stores immutable copies (mutating the input does not change stored data)', () => {
    const repo = createInMemoryRepository();
    const w = ws('w1');
    repo.workspaces.put(w);
    w.name = 'mutated';
    expect(repo.workspaces.get('w1')?.name).toBe('ws w1');
  });

  it('deleteWorkspace removes all workspace-scoped data but leaves other workspaces', () => {
    const repo = createInMemoryRepository();
    repo.workspaces.put(ws('w1'));
    repo.workspaces.put(ws('w2'));
    repo.issues.put(issue('i1', 'w1'));
    repo.issues.put(issue('i2', 'w2'));

    repo.deleteWorkspace('w1');

    expect(repo.workspaces.get('w1')).toBeUndefined();
    expect(repo.workspaces.get('w2')).toBeDefined();
    expect(repo.issues.find((i) => i.workspaceId === 'w1')).toHaveLength(0);
    expect(repo.issues.find((i) => i.workspaceId === 'w2')).toHaveLength(1);
  });

  it('find and all return matching rows', () => {
    const repo = createInMemoryRepository();
    repo.artists.put({ id: 'a1', workspaceId: 'w1', name: 'Lewis KE' } as unknown as Artist);
    expect(repo.artists.all()).toHaveLength(1);
    expect(repo.artists.find((a) => a.name === 'Lewis KE')).toHaveLength(1);
  });
});
