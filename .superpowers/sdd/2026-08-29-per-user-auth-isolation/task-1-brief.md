# Task 1 brief — `UserScopedSearchStore` (the per-user scoping authority)

This is your requirements. Use the exact names and signatures below verbatim.

## Context

Refactor: every authenticated user accesses only their own searches, keyed by their Keycloak `sub`. This task rewrites the search-store SCOPING LAYER to enforce `record.userId === principal.sub` and nothing else. The org/workspace/tenant concepts are being deleted across the codebase in later tasks; your job is only the store layer.

## Global constraints (bind this task)

- **Isolation is the security guarantee.** A user must only ever see/mutate records whose `userId` equals their `sub`. Foreign records return `null`/empty/`false`, never another user's data, never a throw that leaks existence.
- No em dashes and no AI-style icons in any code/comments you write. Use a comma/period/colon.
- Canonical names (use verbatim): class `UserScopedSearchStore`; worker-bound class `UserBoundSearchStore`; `interface SearchPrincipal { sub: string; roles: string[]; authenticated: boolean }`; record field `userId: string`; store methods `listForUser(userId: string)` / `pageForUser(userId: string, options: SearchPageOptions)`.

## Files

- Modify: `apps/api/src/tenant-scoped-search-store.ts`
- Modify: `packages/search-store/src/search-store.ts` (SearchRecord + SearchStore interface + `InMemorySearchStore`, and the Redis store if present in this file or a sibling)
- Test: `apps/api/src/search-principal-isolation.test.ts` (rework to per-user), `packages/search-store/src/in-memory.test.ts` (fix fixtures)

## Interfaces produced (later tasks depend on these EXACT shapes)

- `export class UserScopedSearchStore` with `constructor(inner: SearchStore, principal: SearchPrincipal)` and methods: `get(id)`, `save(input, result, released?)`, `saveDerived(source, patch)`, `update(id, mutate)`, `delete(id)`, `listPage(limit, cursor?)`. Scope rule everywhere: a record is visible/writable iff `hasCustomerScanAccess(principal)` AND `record.userId === principal.sub`.
- `export interface SearchPrincipal { sub: string; roles: string[]; authenticated: boolean }`.
- `SearchRecord.userId: string` REPLACES the old `tenantId` / `ownerUserId` / `artistWorkspaceId` fields. Remove `ownerOf()` or make it return `record.userId`.
- `SearchStore.save(input, result, released?, owner?: { userId: string })` — a 4th optional `owner` arg; concrete stores stamp `record.userId = owner.userId`.
- `SearchStore.listForUser(userId)` and `SearchStore.pageForUser(userId, options)` — filter by `record.userId === userId`, newest first. DELETE the old `listForOwner`/`pageForOwner`/`listForTenant`/`pageForTenant` and any tenant/workspace indexes (Redis: a single `user:<id>` index).
- Rename `TenantScopedSearchStore` -> `UserBoundSearchStore` (binds one `userId`; `get`/`update`/`delete` no-op/null for `record.userId !== boundUserId`).

## Steps (TDD)

1. Write the failing per-user isolation test in `search-principal-isolation.test.ts` (replace the org/tenant setup entirely):

```ts
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
```

2. Run it, confirm it fails (`npx vitest run apps/api/src/search-principal-isolation.test.ts`).
3. Update `SearchRecord`/`SearchStore` types + `InMemorySearchStore` (+ Redis store) to the interfaces above.
4. Rewrite `UserScopedSearchStore` (delete `personalArtistWorkspaceId`, `withoutClientScope` workspace logic, `saveInAuthorizedWorkspace`, and every tenant/workspace/tenantAdmin branch). Keep `hasCustomerScanAccess(principal)` = unauthenticated test identity OR `roles.includes('user')`. `save` -> `inner.save(input, result, released, { userId: principal.sub })`. `saveDerived` throws if `!owns(source)`, else inherits `source.userId`. `update`/`delete`/`get` guard on `owns`. `listPage` -> `inner.pageForUser(principal.sub, { limit, cursor })`.
5. Run `npx vitest run apps/api/src/search-principal-isolation.test.ts packages/search-store/src/in-memory.test.ts` to green. Fix `in-memory.test.ts` fixtures that used `tenantId`/`ownerUserId` -> `userId`.
6. Commit: `git add apps/api/src/tenant-scoped-search-store.ts packages/search-store/src apps/api/src/search-principal-isolation.test.ts && git commit -m "feat(auth): scope search store by user_id (keycloak sub) only"` (append `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

## Ruling carried from pre-flight (IMPORTANT)

The FULL app will NOT typecheck after this task — `apps/api/src/app.ts` and others still import the old `PrincipalScopedSearchStore` and reference `tenantId`; those are fixed in Task 4. **Do NOT try to fix the whole app.** Success for THIS task = your two test files pass (`search-principal-isolation.test.ts`, `in-memory.test.ts`) and the `packages/search-store` package typechecks (`npx tsc --noEmit -p packages/search-store/tsconfig.json` if that project compiles standalone; if the search-store package imports nothing broken it should). Leave the API compile errors for Task 4. If `@sentinel/search-store` won't build standalone because of an unrelated pre-existing issue, note it and rely on the vitest run as your green signal.
