import { describe, it, expect } from 'vitest';
import { InMemorySearchStore } from '@sentinel/search-store';
import { UserScopedSearchStore, type SearchPrincipal } from './tenant-scoped-search-store';

const principal = (sub: string): SearchPrincipal => ({ sub, roles: ['user'], authenticated: true });
const input = (artist: string) => ({ artist, distributor: 'distrokid' as const });
const result = () => ({ tracks: [], warnings: [], summary: { tracks: 0, live: 0, notLive: 0, wrongProfile: 0, needsReview: 0 }, generatedAt: new Date().toISOString() });

describe('UserScopedSearchStore isolates by keycloak sub', () => {
  it('a user sees only their own records; another user gets null and an empty list', async () => {
    const inner = new InMemorySearchStore();
    const alice = new UserScopedSearchStore(inner, principal('alice'));
    const bob = new UserScopedSearchStore(inner, principal('bob'));
    const saved = await alice.save(input('Alice KE'), result());
    expect(saved.userId).toBe('alice');
    expect((await alice.get(saved.id))?.id).toBe(saved.id);
    expect(await bob.get(saved.id)).toBeNull();
    expect(await bob.update(saved.id, (r) => r)).toBeNull();
    expect(await bob.delete(saved.id)).toBe(false);
    expect((await bob.listPage(50)).items).toHaveLength(0);
    expect((await alice.listPage(50)).items.map((r) => r.id)).toEqual([saved.id]);
  });
});
